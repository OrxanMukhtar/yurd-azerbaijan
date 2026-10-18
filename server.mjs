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
const storePath = resolve(storeDir, 'store.json');
const districts = JSON.parse(await readFile(resolve(root, 'districts.json'), 'utf8'));
await mkdir(storeDir, { recursive: true });
try { await readFile(storePath); } catch { await writeFile(storePath, JSON.stringify({ users: {}, sessions: {} }, null, 2)); }
let state = JSON.parse(await readFile(storePath, 'utf8'));
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
