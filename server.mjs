import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicDir = resolve(root, 'public');
const storeDir = resolve(root, 'data');
const storePath = resolve(process.env.YURD_STORE_PATH || resolve(storeDir, 'store.json'));
const districts = JSON.parse(await readFile(resolve(root, 'districts.json'), 'utf8'));
await mkdir(storeDir, { recursive: true });
try { await readFile(storePath); } catch { await writeFile(storePath, JSON.stringify({ users: {}, sessions: {} }, null, 2)); }
let state = JSON.parse(await readFile(storePath, 'utf8'));
state.users ||= {}; state.sessions ||= {}; state.polls ||= {}; state.posts ||= []; state.comments ||= []; state.reports ||= []; state.gameScores ||= {}; state.rateLimits ||= {};
const pollSeeds = [
  ['rayon-prioriteti-1','Rayonunuzda ən çox hansı sahə yaxşılaşmalıdır?','Bir cavab seçin. Səsinizi sonra dəyişə bilərsiniz.','İnkişaf',['Yollar və nəqliyyat','Səhiyyə','Təhsil','İş imkanları','İstirahət və mədəniyyət']],
  ['rayon-gormeli-1','Rayonunuza gələn qonağa ilk nəyi göstərərdiniz?','Yerli tövsiyələri toplayırıq.','Yerli həyat',['Təbiət və mənzərələr','Tarixi məkanlar','Yerli mətbəx','Mədəni tədbirlər','Gündəlik həyat']],
  ['rayon-tedbir-1','Növbəti icma mövzusu hansı olsun?','Nəticə yeni müzakirə mövzularını seçməyə kömək edəcək.','İcma',['Yerli biznes və xidmətlər','Tarix və yaddaş','Turizm və marşrutlar','Gənclər və idman','İctimai məkanlar']]
];
for (const [id,question,description,category,options] of pollSeeds) state.polls[id] ||= {id,question,description,category,options:options.map((label,i)=>({key:String(i),label,votes:0})),votes:{}};
await writeFile(storePath, JSON.stringify(state, null, 2), { mode: 0o600 });
let writes = Promise.resolve();
const persist = () => { writes = writes.then(async () => { const temp = `${storePath}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(temp, storePath); }); return writes; };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const cookieName = 'yurd_session';
const sessionDuration = 14 * 24 * 60 * 60 * 1000;
const attempts = new Map();

function parseCookies(header = '') { return Object.fromEntries(header.split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2)); }
function userFrom(req) { const token = parseCookies(req.headers.cookie)[cookieName]; const session = token && state.sessions[token]; if (!session || session.expiresAt < Date.now()) return null; return Object.values(state.users).find(user => user.id === session.userId) || null; }
function publicUser(user) { return user ? { id: user.id, username: user.username, vote: user.vote || null } : null; }
function send(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...headers }); res.end(JSON.stringify(body)); }
function cookie(token, req) { const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'; return `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDuration / 1000}${secure ? '; Secure' : ''}`; }
function noCookie() { return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`; }
function counts() { const out = Object.fromEntries(districts.map(d => [d.id, 0])); for (const user of Object.values(state.users)) if (user.vote && out[user.vote] !== undefined) out[user.vote]++; return out; }
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 12_000) throw new Error('Body too large'); } return JSON.parse(raw || '{}'); }
function allowedOrigin(req) { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function rateAllowed(req) { const now = Date.now(), key = req.socket.remoteAddress || 'unknown'; const item = attempts.get(key) || { start: now, count: 0 }; if (now - item.start > 15 * 60 * 1000) { item.start = now; item.count = 0; } item.count++; attempts.set(key, item); return item.count <= 10; }
function rateUser(user, action, limit, windowMs=10*60*1000) { const now=Date.now(), key=`${user.id}:${action}:${Math.floor(now/windowMs)}`, n=(state.rateLimits[key]||0)+1;state.rateLimits[key]=n;return n<=limit; }
function weekKey(){const d=new Date(),t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));t.setUTCDate(t.getUTCDate()+4-(t.getUTCDay()||7));const y=new Date(Date.UTC(t.getUTCFullYear(),0,1)),w=Math.ceil((((t-y)/86400000)+1)/7);return `${t.getUTCFullYear()}-W${String(w).padStart(2,'0')}`}
async function communityPayload(user) { const polls=Object.values(state.polls).map(p=>({id:p.id,question:p.question,description:p.description,category:p.category,options:p.options.map(o=>({...o})),myVote:user?p.votes[user.id]??null:null})); const posts=state.posts.filter(p=>p.status==='visible').sort((a,b)=>b.createdAt-a.createdAt).slice(0,30).map(p=>({id:p.id,districtId:p.districtId,topic:p.topic,body:p.body,createdAt:p.createdAt,username:Object.values(state.users).find(u=>u.id===p.userId)?.username||'İstifadəçi',commentCount:state.comments.filter(c=>c.postId===p.id&&c.status==='visible').length}));const scores=Object.values(state.gameScores).filter(s=>s.week===weekKey()).sort((a,b)=>b.bestScore-a.bestScore||a.updatedAt-b.updatedAt).slice(0,10);return {polls,posts,leaderboard:scores.map((s,i)=>({rank:i+1,username:Object.values(state.users).find(u=>u.id===s.userId)?.username||'İstifadəçi',score:s.bestScore,mine:user?.id===s.userId})),myGameScore:user?state.gameScores[`${user.id}:rayon-kesfi:${weekKey()}`]?.bestScore||0:0,user:publicUser(user)} }
function reportHidden(type,id){const r=state.reports.filter(x=>x.targetType===type&&x.targetId===id);if(r.length>=3){const item=type==='post'?state.posts.find(x=>x.id===id):state.comments.find(x=>x.id===id);if(item)item.status='hidden';}}
async function registerOrLogin(req, res, isRegister) {
  if (!rateAllowed(req)) return send(res, 429, { error: 'Çox cəhd edildi. Bir az sonra yenidən yoxlayın.' });
  const { username, password } = await body(req);
  const name = String(username || '').trim().normalize('NFKC');
  if (!/^[\p{L}\p{N}_.-]{3,24}$/u.test(name) || typeof password !== 'string' || password.length < 8 || password.length > 200) return send(res, 400, { error: 'İstifadəçi adı 3–24 simvol, şifrə isə ən azı 8 simvol olmalıdır.' });
  const key = name.toLocaleLowerCase('az'); let user = state.users[key];
  if (isRegister) {
    if (user) return send(res, 409, { error: 'Bu istifadəçi adı artıq qeydiyyatdadır.' });
    const salt = randomBytes(16).toString('hex'); const hash = await scrypt(password, salt, 64);
    user = { id: randomBytes(16).toString('hex'), username: name, salt, passwordHash: hash.toString('hex'), vote: null, createdAt: Date.now() };
    state.users[key] = user;
  } else {
    const provided = user ? await scrypt(password, user.salt, 64) : await scrypt(password, 'yurd-login-dummy-salt', 64);
    const expected = user ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
    if (!user || !timingSafeEqual(provided, expected)) return send(res, 401, { error: 'İstifadəçi adı və ya şifrə yanlışdır.' });
  }
  const token = randomBytes(32).toString('hex');
  for (const [id, session] of Object.entries(state.sessions)) if (session.expiresAt < Date.now()) delete state.sessions[id];
  state.sessions[token] = { userId: user.id, expiresAt: Date.now() + sessionDuration };
  await persist();
  return send(res, 200, { user: publicUser(user), counts: counts() }, { 'Set-Cookie': cookie(token, req) });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!allowedOrigin(req)) return send(res, 403, { error: 'Sorğu qəbul edilmədi.' });
      if (req.method === 'GET' && url.pathname === '/api/state') { const user = userFrom(req); return send(res, 200, { districts, counts: counts(), user: publicUser(user), totalVotes: Object.values(state.users).filter(u => !!u.vote).length }); }
      if (req.method === 'GET' && url.pathname === '/api/community') return send(res,200,await communityPayload(userFrom(req)));
      if (req.method === 'GET' && url.pathname === '/api/games') {const games=JSON.parse(await readFile(resolve(publicDir,'games.json'),'utf8'));return send(res,200,{games:games.map(g=>({...g,questions:g.questions.map(({answer,explanation,...q})=>q)}))})}
      if (req.method === 'GET' && url.pathname === '/api/comments') {const id=url.searchParams.get('postId'),post=state.posts.find(p=>p.id===id&&p.status==='visible');if(!post)return send(res,404,{error:'Müzakirə tapılmadı.'});return send(res,200,{comments:state.comments.filter(c=>c.postId===id&&c.status==='visible').map(c=>({id:c.id,body:c.body,createdAt:c.createdAt,username:Object.values(state.users).find(u=>u.id===c.userId)?.username||'İstifadəçi'}))})}
      if (req.method === 'POST' && url.pathname === '/api/poll-vote') {const user=userFrom(req);if(!user)return send(res,401,{error:'Sorğuda iştirak etmək üçün hesaba daxil olun.'});const b=await body(req),p=state.polls[b.pollId],o=p?.options.find(x=>x.key===String(b.optionKey));if(!o)return send(res,400,{error:'Sorğu seçimi tapılmadı.'});const old=p.votes[user.id];if(old!==undefined)p.options.find(x=>x.key===old).votes--;o.votes++;p.votes[user.id]=o.key;await persist();return send(res,200,await communityPayload(user))}
      if (req.method === 'POST' && url.pathname === '/api/post') {const user=userFrom(req);if(!user)return send(res,401,{error:'Yazmaq üçün hesaba daxil olun.'});if(!rateUser(user,'post',5,3600000))return send(res,429,{error:'Bir saat ərzində 5 mövzu limiti var.'});const b=await body(req),text=String(b.body||'').trim();if(text.length<3||text.length>700||!['question','idea','story'].includes(b.topic)||b.districtId&&!districts.some(d=>d.id===b.districtId))return send(res,400,{error:'Mövzu məlumatları düzgün deyil.'});state.posts.push({id:randomBytes(16).toString('hex'),userId:user.id,districtId:b.districtId||null,topic:b.topic,body:text,status:'visible',createdAt:Date.now()});await persist();return send(res,200,await communityPayload(user))}
      if (req.method === 'POST' && url.pathname === '/api/comment') {const user=userFrom(req);if(!user)return send(res,401,{error:'Cavab yazmaq üçün hesaba daxil olun.'});if(!rateUser(user,'comment',15))return send(res,429,{error:'Bir az çox cavab yazıldı.'});const b=await body(req),post=state.posts.find(p=>p.id===b.postId&&p.status==='visible'),text=String(b.body||'').trim();if(!post||!text||text.length>500)return send(res,400,{error:'Cavab və ya müzakirə düzgün deyil.'});state.comments.push({id:randomBytes(16).toString('hex'),postId:post.id,userId:user.id,body:text,status:'visible',createdAt:Date.now()});await persist();return send(res,200,{comments:state.comments.filter(c=>c.postId===post.id&&c.status==='visible').map(c=>({...c,username:Object.values(state.users).find(u=>u.id===c.userId)?.username||'İstifadəçi'}))})}
      if (req.method === 'POST' && url.pathname === '/api/report') {const user=userFrom(req);if(!user)return send(res,401,{error:'Şikayət etmək üçün hesaba daxil olun.'});const b=await body(req);if(!['post','comment'].includes(b.targetType)||!['spam','abuse','misinformation','other'].includes(b.reason))return send(res,400,{error:'Şikayət məlumatı düzgün deyil.'});if(state.reports.some(r=>r.userId===user.id&&r.targetType===b.targetType&&r.targetId===b.targetId))return send(res,409,{error:'Bu məzmun barədə artıq şikayət göndərmisiniz.'});state.reports.push({userId:user.id,targetType:b.targetType,targetId:b.targetId});reportHidden(b.targetType,b.targetId);await persist();return send(res,200,{ok:true,message:'Şikayət qəbul edildi.'})}
      if (req.method === 'POST' && url.pathname === '/api/game-submit') {const user=userFrom(req);if(!user)return send(res,401,{error:'Oyunda xal toplamaq üçün hesaba daxil olun.'});if(!rateUser(user,'game',20))return send(res,429,{error:'Çox oyun cəhdi edildi.'});const b=await body(req),games=JSON.parse(await readFile(resolve(publicDir,'games.json'),'utf8')),game=games.find(g=>g.id===b.gameId);if(!game||!Array.isArray(b.answers)||b.answers.length!==game.questions.length||b.answers.some(x=>!Number.isInteger(x)||x<0||x>3))return send(res,400,{error:'Oyun cavabları düzgün deyil.'});const score=game.questions.reduce((n,q,i)=>n+(b.answers[i]===q.answer?20:0),0),key=`${user.id}:${game.id}:${weekKey()}`,old=state.gameScores[key]||{userId:user.id,gameId:game.id,week:weekKey(),bestScore:0,attempts:0};old.bestScore=Math.max(old.bestScore,score);old.attempts++;old.updatedAt=Date.now();state.gameScores[key]=old;await persist();const result=await communityPayload(user);return send(res,200,{score,bestScore:old.bestScore,attempts:old.attempts,explanations:game.questions.map(q=>q.explanation),leaderboard:result.leaderboard})}
      if (req.method === 'POST' && url.pathname === '/api/register') return await registerOrLogin(req, res, true);
      if (req.method === 'POST' && url.pathname === '/api/login') return await registerOrLogin(req, res, false);
      if (req.method === 'POST' && url.pathname === '/api/logout') { const token = parseCookies(req.headers.cookie)[cookieName]; if (token) delete state.sessions[token]; await persist(); return send(res, 200, { user: null }, { 'Set-Cookie': noCookie() }); }
      if (req.method === 'POST' && url.pathname === '/api/vote') {
        const user = userFrom(req); if (!user) return send(res, 401, { error: 'Səs vermək üçün daxil olun.' });
        const { districtId } = await body(req); if (!districts.some(d => d.id === districtId)) return send(res, 400, { error: 'Rayon seçimi tapılmadı.' });
        const previousVote = user.vote || null; user.vote = districtId; user.updatedAt = Date.now(); await persist();
        return send(res, 200, { user: publicUser(user), previousVote, counts: counts(), totalVotes: Object.values(state.users).filter(u => !!u.vote).length });
      }
      return send(res, 404, { error: 'API ünvanı tapılmadı.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const pathname = decodeURIComponent(url.pathname); const candidate = resolve(publicDir, `.${pathname}`);
    if (candidate !== publicDir && !candidate.startsWith(publicDir + sep)) throw new Error('Invalid path');
    const file = pathname === '/' ? resolve(publicDir, 'index.html') : candidate;
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end(); res.end(data);
  } catch (err) { if (!res.headersSent) send(res, 404, { error: 'Tapılmadı.' }); else res.end(); }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Yurd MVP: http://${process.env.HOST || '127.0.0.1'}:${port}`));

