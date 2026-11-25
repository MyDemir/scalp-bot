'use strict';

const crypto = require('crypto');

const COOKIE = 'scalp_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
// Oturum sahibinin hâlâ canlı grup yöneticisi olduğu bu sürede bir yeniden doğrulanır (GET istekleri).
const SESSION_RECHECK_MS = 5 * 60 * 1000;
const ADMIN_CACHE_MS = 30 * 1000;            // Telegram yönetici listesi önbelleği
const REQ_WINDOW_MS = 60 * 60 * 1000;        // kullanıcı ID başına kod isteği penceresi
const MAX_REQS_PER_ID = 5;
const FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;  // yanlış doğrulama penceresi ve kilit süresi
const MAX_FAILS = 15;                        // (kullanıcı ID + IP) çifti başına
const MAX_FAILS_PER_ID = 60;                 // ID başına IP'den bağımsız tavan
const IP_WINDOW_MS = 10 * 60 * 1000;
const MAX_IP_REQS = 20;
// Giriş sayfasının betiği ve panel statikleri sır içermez; oturumsuz sunulur.
const PUBLIC_ASSETS = new Set(['/panel/app.js', '/panel/app.css', '/panel/login.js']);
const MAX_KEYS = 1000;                       // her sayaç Map'i için üst sınır

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try { result[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function loginPage() {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Scalp Bot · Yönetici Girişi</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070a10;color:#e2e8f0;font:15px system-ui,sans-serif;padding:20px}.card{width:min(420px,100%);background:#0c101b;border:1px solid #26344e;border-radius:14px;padding:28px;box-shadow:0 20px 70px #0008}h1{font-size:21px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5;font-size:13px}label{display:block;font-size:12px;color:#cbd5e1;margin:18px 0 6px}input{width:100%;padding:12px;border:1px solid #334155;border-radius:8px;background:#070a10;color:white;font:inherit;font-size:16px;min-height:44px}button{width:100%;padding:12px;min-height:44px;border:0;border-radius:8px;background:#f59e0b;color:#111827;font-weight:700;margin-top:14px;cursor:pointer}button:disabled{opacity:.6}#msg{min-height:20px;color:#fbbf24;font-size:13px;margin-top:14px;overflow-wrap:anywhere}.step{display:none}.step.active{display:block}.hint{font-size:11px;color:#64748b;margin-top:16px}</style></head><body><main class="card"><h1>⚡ Scalp Engine · Yönetici</h1><p>Panele yalnızca yapılandırılmış Telegram grup/kanalının yöneticileri girebilir. Kod, ana Telegram botu üzerinden size özel gönderilir.</p>
  <section id="step1" class="step active"><label for="tgid">Telegram kullanıcı ID</label><input id="tgid" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="Örn. 123456789"><button id="send">Telegram kodu gönder</button></section>
  <section id="step2" class="step"><label for="otp">6 haneli doğrulama kodu</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><button id="verify">Giriş yap</button><button id="back" style="background:#1e293b;color:#e2e8f0">Başka ID kullan</button></section>
  <div id="msg" role="status" aria-live="polite"></div><div class="hint">Doğrulama kodu 5 dakika geçerlidir. Başarılı giriş 8 saat sürer.</div></main><script src="/panel/login.js"></script></body></html>`;
}

function createAdminAuth({ telegram, env = process.env, now = () => Date.now(), randomInt = crypto.randomInt } = {}) {
  const otps = new Map();
  const sessions = new Map();
  const cooldowns = new Map();
  const reqLog = new Map();    // id -> [kod isteği zamanları] (son 1 saat)
  const failLog = new Map();   // 'id|ip' -> { count, first, lockedUntil } (yanlış doğrulama, çift başına)
  const failTotal = new Map(); // id -> { count, first, lockedUntil } (IP'den bağımsız tavan)
  const ipLog = new Map();     // ip -> [/api/auth/* istek zamanları] (son 10 dk)
  let adminCache = null;       // { ids, at }
  let refreshCache = 0;        // son zorunlu yenilemenin zamanı
  let lastAdminLookupError = null;
  const sessionCookieSecure = env.NODE_ENV === 'production';
  // Always resolve authorization from the live administrators of TELEGRAM_CHAT_ID.
  // TELEGRAM_ADMIN_IDS is intentionally not required for web-panel access.
  // Sayaç Map'lerini sınırlı tutar: süresi dolanlar atılır, hâlâ doluysa en eski anahtarlar (kilitliler hariç) düşer.
  function bound(map, live) {
    if (map.size < MAX_KEYS) return;
    for (const [k, v] of map) if (!live(v)) map.delete(k);
    for (const [k, v] of map) {
      if (map.size < MAX_KEYS) break;
      if (!(v && v.lockedUntil > now())) map.delete(k);
    }
    // Hâlâ doluysa (hepsi kilitli) en eski kayıtlar en son düşer.
    for (const k of map.keys()) {
      if (map.size < MAX_KEYS) break;
      map.delete(k);
    }
  }
  const liveTimes = ms => v => v.length > 0 && now() - v[v.length - 1] < ms;
  const liveFail = v => v.lockedUntil > now() || now() - v.first < FAIL_WINDOW_MS;

  function lockOf(map, key) {
    const f = map.get(key);
    if (!f) return null;
    if (f.lockedUntil > now()) return f;
    if (now() - f.first >= FAIL_WINDOW_MS) map.delete(key);
    return null;
  }
  const pairKey = (id, ip) => id + '|' + String(ip || '');
  const lockedResult = () => ({ ok: false, status: 429, error: 'Bu kullanıcı ID için çok fazla yanlış kod denendi; 24 saat boyunca kilitlendi.' });
  /** Bu IP'den bu ID kilitli mi ya da ID'nin IP'den bağımsız tavanı dolu mu (doğrulama için). */
  function isLocked(userId, ip) {
    const id = String(userId || '');
    return Boolean(lockOf(failLog, pairKey(id, ip)) || lockOf(failTotal, id));
  }
  function bump(map, key, max) {
    let f = map.get(key);
    if (!f || now() - f.first >= FAIL_WINDOW_MS) { bound(map, liveFail); f = { count: 0, first: now(), lockedUntil: 0 }; map.set(key, f); }
    f.count++;
    if (f.count >= max) f.lockedUntil = now() + FAIL_WINDOW_MS;
  }
  function noteFail(id, ip) {
    bump(failLog, pairKey(id, ip), MAX_FAILS);
    bump(failTotal, id, MAX_FAILS_PER_ID);
  }
  /** Fly'da fly-client-ip'e yalnız Fly ortamında güvenilir (başka yerde başlık istemci tarafından uydurulur). */
  function clientIp(req) {
    const trustFly = Boolean(env.FLY_APP_NAME || env.FLY_MACHINE_ID);
    return String((trustFly && req.headers?.['fly-client-ip']) || req.socket?.remoteAddress || 'bilinmiyor').slice(0, 64);
  }
  /** Kullanıcı ID başına saatte en fazla MAX_REQS_PER_ID kod isteği; true = izin var */
  function takeRequestSlot(id) {
    const arr = (reqLog.get(id) || []).filter(t => now() - t < REQ_WINDOW_MS);
    if (arr.length >= MAX_REQS_PER_ID) { reqLog.set(id, arr); return false; }
    if (!reqLog.has(id)) bound(reqLog, liveTimes(REQ_WINDOW_MS));
    arr.push(now());
    reqLog.set(id, arr);
    return true;
  }
  /** IP başına 10 dk'da en fazla MAX_IP_REQS /api/auth/* isteği (Fly'da fly-client-ip, yoksa soket adresi) */
  function authRateLimit(req, res, next) {
    if (req.method === 'GET' && req.path === '/session') return next();   // oturum okuması sayılmaz
    const ip = clientIp(req);
    const arr = (ipLog.get(ip) || []).filter(t => now() - t < IP_WINDOW_MS);
    if (arr.length >= MAX_IP_REQS) {
      ipLog.set(ip, arr);
      res.setHeader('Retry-After', String(Math.ceil((IP_WINDOW_MS - (now() - arr[0])) / 1000)));
      return res.status(429).json({ ok: false, error: 'Çok fazla giriş isteği; birkaç dakika sonra tekrar deneyin.' });
    }
    if (!ipLog.has(ip)) bound(ipLog, liveTimes(IP_WINDOW_MS));
    arr.push(now());
    ipLog.set(ip, arr);
    return next();
  }

  async function adminIds({ refresh = false } = {}) {
    // 30 sn önbellek; açık yenileme (refreshAdminList) de en çok 30 sn'de bir Telegram'a gider.
    if (adminCache && now() - adminCache.at < ADMIN_CACHE_MS && (!refresh || now() - refreshCache < ADMIN_CACHE_MS)) return adminCache.ids;
    if (typeof telegram?.getGroupAdminIds !== 'function') {
      lastAdminLookupError = 'getGroupAdminIds fonksiyonu mevcut değil.';
      console.error('[AUTH] Telegram yönetici listesi alınamıyor:', lastAdminLookupError);
      return null;
    }
    try {
      const lookup = refresh && typeof telegram?.refreshGroupAdminIds === 'function' ? telegram.refreshGroupAdminIds.bind(telegram) : telegram.getGroupAdminIds.bind(telegram);
      const ids = await lookup();
      if (!Array.isArray(ids)) {
        lastAdminLookupError = 'Telegram yönetici listesi beklenmeyen formatta döndü.';
        console.error('[AUTH] Telegram yönetici listesi beklenmeyen formatta döndü');
        return null;
      }
      lastAdminLookupError = null;
      const clean = [...new Set(ids.map(String).filter(x => /^\d{5,20}$/.test(x)))];
      adminCache = { ids: clean, at: now() };
      if (refresh) refreshCache = now();
      return clean;
    } catch (err) {
      // Telegram errors are descriptions, not request URLs; redact token-shaped text defensively.
      lastAdminLookupError = String(err?.message || 'Bilinmeyen Telegram hatası')
        .replace(/bot\d+:[A-Za-z0-9_-]+/gi, '[token gizlendi]')
        .slice(0, 240);
      console.error('[AUTH] Telegram grup yöneticileri alınamadı:', lastAdminLookupError);
      return null;
    }
  }
  const hashCode = (userId, code, salt) => crypto.createHash('sha256').update(userId + ':' + code + ':' + salt).digest('hex');

  /**
   * Panel rolü: grup yöneticisi → 'admin'; grup üyesi (telegram.isMember: creator/administrator/member/restricted,
   * 10 dk önbellekli) → 'member'; aksi halde null. `admins` canlı yönetici listesidir.
   */
  async function roleOf(id, admins) {
    if (admins.includes(id)) return 'admin';
    if (typeof telegram?.isMember !== 'function') return null;
    try { return (await telegram.isMember(id)) ? 'member' : null; } catch { return null; }
  }

  async function requestCode(userId, ip) {
    if (!/^\d{5,20}$/.test(String(userId || ''))) return { ok: true };
    // Yanlış doğrulama kilidi Telegram çağrısından önce uygulanır.
    if (lockOf(failLog, pairKey(String(userId), ip))) return lockedResult();
    const admins = await adminIds();
    if (admins === null) {
      return { ok: false, error: 'Telegram grup yöneticileri okunamadı. ' + (lastAdminLookupError || 'TELEGRAM_CHAT_ID ve botun grup erişimini kontrol edin.') };
    }
    if (!(await roleOf(String(userId), admins))) return { ok: true };   // yönetici de üye de değil: sessizce aynı yanıt
    const id = String(userId);
    const last = cooldowns.get(id) || 0;
    if (now() - last < OTP_COOLDOWN_MS) return { ok: true };
    // Yalnızca gerçekten grup üyesi olduğu doğrulanan kullanıcı kota tüketebilir.
    if (!takeRequestSlot(id)) return { ok: false, status: 429, error: 'Bu kullanıcı ID için saatte en fazla 5 kod istenebilir; daha sonra tekrar deneyin.' };
    cooldowns.set(id, now());
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    otps.set(id, { hash: hashCode(id, code, salt), salt, expiresAt: now() + OTP_TTL_MS, attempts: 0 });
    const sent = await telegram.sendPrivate(id, '🔐 <b>Scalp Bot yönetici giriş kodu</b>\n\nKod: <code>' + code + '</code>\n\nKod 5 dakika geçerlidir. Bu isteği siz yapmadıysanız mesajı yok sayın.', null);
    if (!sent) {
      otps.delete(id);
      return { ok: false, error: 'Telegram mesajı gönderilemedi. Botla özel sohbeti başlatıp tekrar deneyin.' };
    }
    return { ok: true };
  }

  async function refreshAdminList(userId) {
    const id = String(userId || '');
    const ids = await adminIds({ refresh: true });
    if (ids === null) {
      return { ok: false, status: 503, error: 'Telegram yönetici listesi alınamadı. ' + (lastAdminLookupError || 'TELEGRAM_CHAT_ID ve botun grup erişimini kontrol edin.') };
    }
    // A refresh is permitted only when the requesting signed-in user is still a live group admin.
    if (!/^\d{5,20}$/.test(id) || !ids.includes(id)) {
      return { ok: false, status: 403, error: 'Telegram grubundaki güncel yöneticiliğiniz doğrulanamadı. Yeniden giriş yapın.' };
    }
    return { ok: true, adminCount: ids.length, refreshedAt: now() };
  }

  async function verifyCode(userId, code, ip) {
    const id = String(userId || '');
    const entry = otps.get(id);
    // Bekleyen OTP yoksa Telegram'a hiç gidilmez (sayaca da yazılmaz: kimsenin ID'sini boşuna kilitleme).
    if (!entry || isLocked(id, ip)) return null;
    // Re-check current group/channel admin membership at verification time too.
    const admins = await adminIds();
    if (admins === null) return null;
    const spent = entry.expiresAt < now() || entry.attempts >= MAX_OTP_ATTEMPTS;
    const role = spent ? null : await roleOf(id, admins);
    if (!role) {
      otps.delete(id);
      noteFail(id, ip);
      return null;
    }
    entry.attempts++;
    const supplied = hashCode(id, String(code || ''), entry.salt);
    if (!safeEqual(supplied, entry.hash)) {
      if (entry.attempts >= MAX_OTP_ATTEMPTS) otps.delete(id);
      noteFail(id, ip);
      return null;
    }
    failLog.delete(pairKey(id, ip));
    otps.delete(id);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId: id, role, expiresAt: now() + SESSION_TTL_MS, verifiedAt: now() });
    return { token, userId: id, role, expiresAt: now() + SESSION_TTL_MS };
  }

  /**
   * Oturum belirteci: Authorization: Bearer, x-session-token başlığı ya da HttpOnly çerez.
   * URL'deki ?token= hiçbir yolda kabul edilmez (loglara/Referer'a sızar).
   */
  function getSession(req) {
    const authHeader = req.headers?.authorization;
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const headerToken = req.headers?.['x-session-token'];
    const cookieToken = parseCookies(req.headers?.cookie)[COOKIE];
    const token = [bearer, headerToken, cookieToken].find(t => typeof t === 'string' && t);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) { sessions.delete(token); return null; }
    return { token, ...session };
  }

  function setCookie(res, token) {
    const parts = [COOKIE + '=' + encodeURIComponent(token), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)];
    if (sessionCookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearCookie(res) {
    const parts = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (sessionCookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  /**
   * Yetki kontrolü: oturum sahibinin TELEGRAM_CHAT_ID grubunda hâlâ yönetici olduğunu doğrular.
   * Her oturum için SESSION_RECHECK_MS'de bir (force ile hemen) Telegram'dan taze liste alınır.
   * Yöneticilikten çıkarılan kullanıcının oturumu hemen iptal edilir.
   * @returns {Promise<{ok:true}|{ok:false,status:number,error:string}>}
   */
  async function authorize(session, { force = false } = {}) {
    const stored = sessions.get(session?.token);
    if (!stored) return { ok: false, status: 401, error: 'Yönetici girişi gerekli.' };
    if (!force && now() - (stored.verifiedAt || 0) < SESSION_RECHECK_MS) return { ok: true };
    const ids = await adminIds();
    if (ids === null) return { ok: false, status: 503, error: 'Telegram yönetici listesi doğrulanamadı; işlem güvenlik nedeniyle reddedildi.' };
    const role = await roleOf(String(stored.userId), ids);
    if (!role) {
      sessions.delete(session.token);
      return { ok: false, status: 403, error: 'Telegram grubundaki üyeliğiniz doğrulanamadı; oturum kapatıldı.' };
    }
    stored.role = role;      // rol yükselmesi / düşmesi oturuma yansır
    stored.verifiedAt = now();
    return { ok: true };
  }

  async function middleware(req, res, next) {
    if (req.path.startsWith('/api/auth/')) return next();
    const panelOpen = req.method === 'GET' && req.path === '/';
    if (req.method === 'GET' && PUBLIC_ASSETS.has(req.path)) return next();
    const session = getSession(req);
    if (session) {
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      let verdict;
      try {
        verdict = await authorize(session, { force: mutating });
      } catch (err) {
        console.error('[AUTH] Yetki kontrolü başarısız:', err?.message || err);
        verdict = { ok: false, status: 503, error: 'Yetki kontrolü yapılamadı.' };
      }
      if (!verdict.ok) {
        res.setHeader('Cache-Control', 'no-store');
        if (verdict.status === 403) clearCookie(res);
        if (req.path.startsWith('/api/')) return res.status(verdict.status).json({ ok: false, error: verdict.error });
        if (verdict.status === 403 && panelOpen) return res.status(200).type('html').send(loginPage());
        return res.status(verdict.status).type('text').send(verdict.error);
      }
      req.adminSession = getSession(req) || session;   // authorize rolü saklanan oturumda güncelledi
      return next();
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && (req.path === '/' || req.path === '/login')) {
      return res.status(200).type('html').send(loginPage());
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Yönetici girişi gerekli.' });
    return res.status(401).type('text').send('Yönetici girişi gerekli.');
  }

  function logout(req, res) {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    clearCookie(res);
  }

  return { requestCode, verifyCode, isLocked, authRateLimit, clientIp, refreshAdminList, authorize, getSession, setCookie, clearCookie, middleware, logout, _internal: { otps, sessions, cooldowns, adminIds, reqLog, failLog, failTotal, ipLog, clearAdminCache: () => { adminCache = null; refreshCache = 0; } } };
}

module.exports = { createAdminAuth, loginPage, parseCookies, escapeHtml, safeEqual };
