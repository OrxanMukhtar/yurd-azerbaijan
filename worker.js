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
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 210000, hash: 'SHA-256' }, key, 256);
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
      catch (error) { console.error('Yurd API error:', error instanceof Error ? error.message : String(error)); return json({ error: 'Server sorğusu tamamlanmadı.' }, 500); }
    }
    return env.ASSETS.fetch(request);
  }
};
