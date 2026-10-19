const COOKIE = 'yurd_session';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...headers } });
}
function cookie(token) { return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}; Secure`; }
function expiredCookie() { return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`; }
function tokenFrom(request) { const pair = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`)); return pair ? decodeURIComponent(pair.slice(COOKIE.length + 1)) : null; }
function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function randomHex(size = 32) { const bytes = crypto.getRandomValues(new Uint8Array(size)); return hex(bytes); }
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Cloudflare Workers caps PBKDF2 at 100,000 iterations per operation.
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}
function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
async function parseBody(request) { const text = await request.text(); if (text.length > 12000) throw new Error('body too large'); return JSON.parse(text || '{}'); }
async function districtsFor(request, env) {
  const r = await env.ASSETS.fetch(new Request(new URL('/districts.json', request.url)));
  if (!r.ok) throw new Error('District data unavailable');
  return r.json();
}
function publicUser(row) { return row ? { id: row.id, username: row.username, vote: row.vote || null } : null; }
async function userFor(request, env) {
  const token = tokenFrom(request); if (!token) return null;
  return env.DB.prepare('SELECT u.id,u.username,u.vote FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await digest(token), Date.now()).first();
}
async function voteCounts(env, districts) {
  const rows = await env.DB.prepare('SELECT vote,COUNT(*) AS n FROM users WHERE vote IS NOT NULL GROUP BY vote').all();
  const counts = Object.fromEntries(districts.map(d => [d.id, 0]));
  for (const row of rows.results) if (Object.hasOwn(counts, row.vote)) counts[row.vote] = Number(row.n);
  return counts;
}
async function stateResponse(request, env, districts) {
  const user = await userFor(request, env), counts = await voteCounts(env, districts);
  return json({ districts, counts, user: publicUser(user), totalVotes: Object.values(counts).reduce((a, b) => a + b, 0) });
}
async function allowAuth(request, env) {
  const address = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await digest(address), windowStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const row = await env.DB.prepare('INSERT INTO auth_attempts(ip_hash,window_start,attempt_count) VALUES(?,?,1) ON CONFLICT(ip_hash,window_start) DO UPDATE SET attempt_count=attempt_count+1 RETURNING attempt_count').bind(ipHash, windowStart).first();
  return Number(row.attempt_count) <= 10;
}
async function allowUserAction(env, userId, action, limit, windowMs = 10 * 60 * 1000) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const row = await env.DB.prepare('INSERT INTO user_rate_limits(user_id,action,window_start,action_count) VALUES(?,?,?,1) ON CONFLICT(user_id,action,window_start) DO UPDATE SET action_count=action_count+1 RETURNING action_count').bind(userId, action, windowStart).first();
  return Number(row.action_count) <= limit;
}
async function gamesFor(request, env, includeAnswers = false) {
  const response = await env.ASSETS.fetch(new Request(new URL('/games.json', request.url)));
  if (!response.ok) throw new Error('Game data unavailable');
  const games = await response.json();
  return includeAnswers ? games : games.map(game => ({ ...game, questions: game.questions.map(({ answer, explanation, ...question }) => question) }));
}
function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
async function communityResponse(request, env) {
  const user = await userFor(request, env);
  const [polls, voteRows, myVotes, posts, scoreRows, myScores] = await Promise.all([
    env.DB.prepare('SELECT id,question,description,category,options_json,closes_at FROM polls WHERE is_active=1 ORDER BY created_at,id').all(),
    env.DB.prepare('SELECT poll_id,option_key,COUNT(*) AS n FROM poll_votes GROUP BY poll_id,option_key').all(),
    user ? env.DB.prepare('SELECT poll_id,option_key FROM poll_votes WHERE user_id=?').bind(user.id).all() : Promise.resolve({ results: [] }),
    env.DB.prepare("SELECT p.id,p.user_id,p.district_id,p.topic,p.body,p.created_at,u.username,COUNT(c.id) AS comment_count FROM community_posts p JOIN users u ON u.id=p.user_id LEFT JOIN community_comments c ON c.post_id=p.id AND c.status='visible' WHERE p.status='visible' GROUP BY p.id ORDER BY p.created_at DESC LIMIT 30").all(),
    env.DB.prepare('SELECT g.user_id,g.best_score,u.username FROM game_scores g JOIN users u ON u.id=g.user_id WHERE g.game_id=? AND g.week_key=? ORDER BY g.best_score DESC,g.updated_at ASC LIMIT 10').bind('rayon-kesfi', weekKey()).all(),
    user ? env.DB.prepare('SELECT game_id,best_score,attempts FROM game_scores WHERE user_id=? AND week_key=?').bind(user.id, weekKey()).all() : Promise.resolve({ results: [] })
  ]);
  const counts = new Map();
  for (const row of voteRows.results) counts.set(`${row.poll_id}:${row.option_key}`, Number(row.n));
  const chosen = new Map(myVotes.results.map(row => [row.poll_id, row.option_key]));
  return json({
    polls: polls.results.map(poll => ({ id: poll.id, question: poll.question, description: poll.description, category: poll.category, options: JSON.parse(poll.options_json).map((label, i) => ({ key: String(i), label, votes: counts.get(`${poll.id}:${i}`) || 0 })), myVote: chosen.get(poll.id) ?? null, closesAt: poll.closes_at })),
    posts: posts.results.map(row => ({ id: row.id, districtId: row.district_id, topic: row.topic, body: row.body, createdAt: row.created_at, username: row.username, commentCount: Number(row.comment_count), mine: user?.id === row.user_id })),
    leaderboard: scoreRows.results.map((row, i) => ({ rank: i + 1, username: row.username, score: Number(row.best_score), mine: user?.id === row.user_id })),
    myGameScore: Number(myScores.results.find(row => row.game_id === 'rayon-kesfi')?.best_score || 0),
    user: publicUser(user)
  });
}
async function submitCommunityPost(request, env, districts) {
  const user = await userFor(request, env); if (!user) return json({ error: 'Yazmaq üçün hesaba daxil olun.' }, 401);
  if (!await allowUserAction(env, user.id, 'post', 5, 60 * 60 * 1000)) return json({ error: 'Bir saat ərzində 5 mövzu limiti var. Bir az sonra yenidən yazın.' }, 429);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Mətn formatı düzgün deyil.' }, 400); }
  const text = String(body.body || '').trim(), topic = String(body.topic || ''), districtId = body.districtId || null;
  if (text.length < 3 || text.length > 700 || !['question','idea','story'].includes(topic)) return json({ error: 'Mövzu 3–700 simvol olmalı və növü seçilməlidir.' }, 400);
  if (districtId && !districts.some(d => d.id === districtId)) return json({ error: 'Rayon seçimi tapılmadı.' }, 400);
  await env.DB.prepare('INSERT INTO community_posts(id,user_id,district_id,topic,body,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), user.id, districtId, topic, text, Date.now()).run();
  return communityResponse(request, env);
}
async function submitCommunityComment(request, env) {
  const user = await userFor(request, env); if (!user) return json({ error: 'Cavab yazmaq üçün hesaba daxil olun.' }, 401);
  if (!await allowUserAction(env, user.id, 'comment', 15)) return json({ error: 'Bir az çox cavab yazıldı. Sonra yenidən yoxlayın.' }, 429);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Mətn formatı düzgün deyil.' }, 400); }
  const postId = String(body.postId || ''), text = String(body.body || '').trim();
  if (text.length < 1 || text.length > 500) return json({ error: 'Cavab 1–500 simvol olmalıdır.' }, 400);
  const post = await env.DB.prepare("SELECT id FROM community_posts WHERE id=? AND status='visible'").bind(postId).first();
  if (!post) return json({ error: 'Müzakirə artıq əlçatan deyil.' }, 404);
  await env.DB.prepare('INSERT INTO community_comments(id,post_id,user_id,body,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), postId, user.id, text, Date.now()).run();
  return json({ comments: await listComments(env, postId, user) });
}
async function listComments(env, postId, user = null) {
  const rows = await env.DB.prepare("SELECT c.id,c.user_id,c.body,c.created_at,u.username FROM community_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? AND c.status='visible' ORDER BY c.created_at LIMIT 100").bind(postId).all();
  return rows.results.map(row => ({ id: row.id, body: row.body, createdAt: row.created_at, username: row.username, mine: user?.id === row.user_id }));
}
async function reportCommunityContent(request, env) {
  const user = await userFor(request, env); if (!user) return json({ error: 'Şikayət etmək üçün hesaba daxil olun.' }, 401);
  if (!await allowUserAction(env, user.id, 'report', 20, 24 * 60 * 60 * 1000)) return json({ error: 'Gündəlik şikayət limiti bitib.' }, 429);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Sorğu formatı düzgün deyil.' }, 400); }
  const type = String(body.targetType || ''), targetId = String(body.targetId || ''), reason = String(body.reason || '');
  if (!['post','comment'].includes(type) || !['spam','abuse','misinformation','other'].includes(reason)) return json({ error: 'Şikayət məlumatı düzgün deyil.' }, 400);
  const table = type === 'post' ? 'community_posts' : 'community_comments';
  const target = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND status='visible'`).bind(targetId).first();
  if (!target) return json({ error: 'Məzmun artıq əlçatan deyil.' }, 404);
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO community_reports(id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), user.id, type, targetId, reason, Date.now()).run();
  if (Number(inserted.meta?.changes || 0) === 0) return json({ error: 'Bu məzmun barədə artıq şikayət göndərmisiniz.' }, 409);
  await env.DB.prepare(`UPDATE ${table} SET report_count=report_count+1,status=CASE WHEN report_count+1>=3 THEN 'hidden' ELSE status END WHERE id=?`).bind(targetId).run();
  return json({ ok: true, message: 'Şikayət qəbul edildi. Bir neçə müstəqil şikayətdən sonra məzmun müvəqqəti gizlənir.' });
}
async function deleteCommunityContent(request, env, type) {
  const user = await userFor(request, env); if (!user) return json({ error: 'Məzmunu silmək üçün hesaba daxil olun.' }, 401);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Sorğu formatı düzgün deyil.' }, 400); }
  const isPost = type === 'post', table = isPost ? 'community_posts' : 'community_comments', id = String(isPost ? body.postId || '' : body.commentId || '');
  if (!id || id.length > 80) return json({ error: 'Məzmun tapılmadı.' }, 400);
  const owned = await env.DB.prepare(`SELECT id FROM ${table} WHERE id=? AND user_id=? AND status='visible'`).bind(id, user.id).first();
  if (!owned) return json({ error: 'Bu məzmun tapılmadı və ya onu silmək hüququn yoxdur.' }, 404);
  await env.DB.prepare(`UPDATE ${table} SET status='removed' WHERE id=? AND user_id=? AND status='visible'`).bind(id, user.id).run();
  return json({ ok: true });
}
async function submitGame(request, env) {
  const user = await userFor(request, env); if (!user) return json({ error: 'Oyunda xal toplamaq üçün hesaba daxil olun.' }, 401);
  if (!await allowUserAction(env, user.id, 'game', 20)) return json({ error: 'Çox oyun cəhdi edildi. Bir az sonra yenidən yoxlayın.' }, 429);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Cavablar formatı düzgün deyil.' }, 400); }
  const games = await gamesFor(request, env, true), game = games.find(item => item.id === body.gameId), tiers = [1,1,2,2,3];
  if (!game || !Array.isArray(body.questionIds) || body.questionIds.length !== tiers.length || new Set(body.questionIds).size !== tiers.length || !Array.isArray(body.answers) || body.answers.length !== tiers.length) return json({ error: 'Oyun cavabları düzgün deyil.' }, 400);
  const questions = body.questionIds.map((id, index) => game.questions.find(q => q.id === id && q.difficulty === tiers[index]));
  if (questions.some(question => !question) || body.answers.some((answer, index) => !Number.isInteger(answer) || answer < 0 || answer >= questions[index].options.length)) return json({ error: 'Sualların sırası və ya cavablar düzgün deyil.' }, 400);
  const score = questions.reduce((total, q, index) => total + (body.answers[index] === q.answer ? 20 : 0), 0), now = Date.now(), season = weekKey();
  await env.DB.prepare('INSERT INTO game_scores(user_id,game_id,week_key,best_score,attempts,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(user_id,game_id,week_key) DO UPDATE SET best_score=MAX(best_score,excluded.best_score),attempts=attempts+1,updated_at=excluded.updated_at').bind(user.id, game.id, season, score, now).run();
  const row = await env.DB.prepare('SELECT best_score,attempts FROM game_scores WHERE user_id=? AND game_id=? AND week_key=?').bind(user.id, game.id, season).first();
  const leaders = await env.DB.prepare('SELECT u.username,g.best_score FROM game_scores g JOIN users u ON u.id=g.user_id WHERE g.game_id=? AND g.week_key=? ORDER BY g.best_score DESC,g.updated_at ASC LIMIT 10').bind(game.id, season).all();
  return json({ score, bestScore: Number(row.best_score), attempts: Number(row.attempts), explanations: questions.map(q => q.explanation), leaderboard: leaders.results.map((leader, i) => ({ rank: i + 1, username: leader.username, score: Number(leader.best_score), mine: leader.username === user.username })) });
}
async function authenticate(request, env, districts, register) {
  if (!await allowAuth(request, env)) return json({ error: 'Çox cəhd edildi. Bir az sonra yenidən yoxlayın.' }, 429);
  let body; try { body = await parseBody(request); } catch { return json({ error: 'Sorğu formatı düzgün deyil.' }, 400); }
  const username = String(body.username || '').trim().normalize('NFKC');
  const password = body.password;
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(username) || typeof password !== 'string' || password.length < 8 || password.length > 200) return json({ error: 'İstifadəçi adı 3–24 simvol, şifrə isə ən azı 8 simvol olmalıdır.' }, 400);
  const usernameKey = username.toLocaleLowerCase('az');
  let user = await env.DB.prepare('SELECT * FROM users WHERE username_key=?').bind(usernameKey).first();
  if (register) {
    if (user) return json({ error: 'Bu istifadəçi adı artıq qeydiyyatdadır.' }, 409);
    const salt = randomHex(16), hash = await passwordHash(password, salt), id = crypto.randomUUID(), now = Date.now();
    await env.DB.prepare('INSERT INTO users(id,username_key,username,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').bind(id, usernameKey, username, salt, hash, now).run();
    user = { id, username, vote: null };
  } else {
    const salt = user?.password_salt || 'yurd-login-dummy-salt';
    const supplied = await passwordHash(password, salt);
    if (!user || !constantTimeEqual(supplied, user.password_hash)) return json({ error: 'İstifadəçi adı və ya şifrə yanlışdır.' }, 401);
  }
  const token = randomHex(), expires = Date.now() + SESSION_MS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),
    env.DB.prepare('DELETE FROM auth_attempts WHERE window_start<?').bind(Date.now() - 24 * 60 * 60 * 1000),
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token), user.id, expires)
  ]);
  user = await env.DB.prepare('SELECT id,username,vote FROM users WHERE id=?').bind(user.id).first();
  const counts = await voteCounts(env, districts);
  return json({ user: publicUser(user), counts }, 200, { 'Set-Cookie': cookie(token) });
}
async function handleApi(request, env) {
  const url = new URL(request.url), districts = await districtsFor(request, env);
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== url.host) return json({ error: 'Sorğu qəbul edilmədi.' }, 403);
  if (request.method === 'GET' && url.pathname === '/api/state') return stateResponse(request, env, districts);
  if (request.method === 'GET' && url.pathname === '/api/community') return communityResponse(request, env);
  if (request.method === 'GET' && url.pathname === '/api/comments') {
    const postId = url.searchParams.get('postId') || '';
    if (!await env.DB.prepare("SELECT id FROM community_posts WHERE id=? AND status='visible'").bind(postId).first()) return json({ error: 'Müzakirə tapılmadı.' }, 404);
    return json({ comments: await listComments(env, postId, await userFor(request, env)) });
  }
  if (request.method === 'GET' && url.pathname === '/api/games') return json({ games: await gamesFor(request, env) });
  if (request.method === 'POST' && url.pathname === '/api/poll-vote') {
    const user = await userFor(request, env); if (!user) return json({ error: 'Sorğuda iştirak etmək üçün hesaba daxil olun.' }, 401);
    let body; try { body = await parseBody(request); } catch { return json({ error: 'Sorğu formatı düzgün deyil.' }, 400); }
    const poll = await env.DB.prepare('SELECT options_json FROM polls WHERE id=? AND is_active=1').bind(String(body.pollId || '')).first();
    if (!poll || !JSON.parse(poll.options_json).some((_, i) => String(i) === String(body.optionKey))) return json({ error: 'Sorğu seçimi tapılmadı.' }, 400);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO poll_votes(poll_id,user_id,option_key,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET option_key=excluded.option_key,updated_at=excluded.updated_at').bind(body.pollId, user.id, String(body.optionKey), now, now).run();
    return communityResponse(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/post') return submitCommunityPost(request, env, districts);
  if (request.method === 'POST' && url.pathname === '/api/comment') return submitCommunityComment(request, env);
  if (request.method === 'POST' && url.pathname === '/api/post-delete') return deleteCommunityContent(request, env, 'post');
  if (request.method === 'POST' && url.pathname === '/api/comment-delete') return deleteCommunityContent(request, env, 'comment');
  if (request.method === 'POST' && url.pathname === '/api/report') return reportCommunityContent(request, env);
  if (request.method === 'POST' && url.pathname === '/api/game-submit') return submitGame(request, env);
  if (request.method === 'POST' && url.pathname === '/api/register') return authenticate(request, env, districts, true);
  if (request.method === 'POST' && url.pathname === '/api/login') return authenticate(request, env, districts, false);
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const token = tokenFrom(request); if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    return json({ user: null }, 200, { 'Set-Cookie': expiredCookie() });
  }
  if (request.method === 'POST' && url.pathname === '/api/vote') {
    const user = await userFor(request, env); if (!user) return json({ error: 'Səs vermək üçün daxil olun.' }, 401);
    let body; try { body = await parseBody(request); } catch { return json({ error: 'Sorğu formatı düzgün deyil.' }, 400); }
    if (!districts.some(d => d.id === body.districtId)) return json({ error: 'Rayon seçimi tapılmadı.' }, 400);
    const previousVote = user.vote || null;
    await env.DB.prepare('UPDATE users SET vote=?,updated_at=? WHERE id=?').bind(body.districtId, Date.now(), user.id).run();
    const updated = { ...user, vote: body.districtId }, counts = await voteCounts(env, districts);
    return json({ user: publicUser(updated), previousVote, counts, totalVotes: Object.values(counts).reduce((a, b) => a + b, 0) });
  }
  return json({ error: 'API ünvanı tapılmadı.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env); }
      catch (error) { return json({ error: 'Server sorğusu tamamlanmadı.' }, 500); }
    }
    return env.ASSETS.fetch(request);
  }
};

