'use strict';

const crypto = require('crypto');

const COOKIE = 'scalp_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

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
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070a10;color:#e2e8f0;font:15px system-ui,sans-serif;padding:20px}.card{width:min(420px,100%);background:#0c101b;border:1px solid #26344e;border-radius:14px;padding:28px;box-shadow:0 20px 70px #0008}h1{font-size:21px;margin:0 0 8px}p{color:#94a3b8;line-height:1.5;font-size:13px}label{display:block;font-size:12px;color:#cbd5e1;margin:18px 0 6px}input{width:100%;padding:12px;border:1px solid #334155;border-radius:8px;background:#070a10;color:white;font:inherit}button{width:100%;padding:12px;border:0;border-radius:8px;background:#f59e0b;color:#111827;font-weight:700;margin-top:14px;cursor:pointer}button:disabled{opacity:.6}#msg{min-height:20px;color:#fbbf24;font-size:13px;margin-top:14px;overflow-wrap:anywhere}.step{display:none}.step.active{display:block}.hint{font-size:11px;color:#64748b;margin-top:16px}</style></head><body><main class="card"><h1>⚡ Scalp Engine · Yönetici</h1><p>Panele yalnızca yapılandırılmış Telegram grup/kanalının yöneticileri girebilir. Kod, ana Telegram botu üzerinden size özel gönderilir.</p>
  <section id="step1" class="step active"><label for="tgid">Telegram kullanıcı ID</label><input id="tgid" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="Örn. 123456789"><button id="send" onclick="requestCode()">Telegram kodu gönder</button></section>
  <section id="step2" class="step"><label for="otp">6 haneli doğrulama kodu</label><input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><button id="verify" onclick="verifyCode()">Giriş yap</button><button style="background:#1e293b;color:#e2e8f0" onclick="back()">Başka ID kullan</button></section>
  <div id="msg" role="status" aria-live="polite"></div><div class="hint">Doğrulama kodu 5 dakika geçerlidir. Başarılı giriş 8 saat sürer.</div></main><script>
  const msg=document.getElementById('msg');let userId='';
  async function post(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)});const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.error||'İşlem tamamlanamadı.');return d;}
  async function requestCode(){const id=document.getElementById('tgid').value.trim();if(id.length<5||id.length>20||!Array.from(id).every(c=>c>='0'&&c<='9')){msg.textContent='Geçerli Telegram kullanıcı ID girin.';return;}const b=document.getElementById('send');b.disabled=true;msg.textContent='İstek gönderiliyor…';try{await post('/api/auth/request-code',{userId:id});userId=id;document.getElementById('step1').classList.remove('active');document.getElementById('step2').classList.add('active');msg.textContent='Hesap yetkiliyse kod Telegram özel mesajınıza gönderildi. Spam klasörünü de kontrol edin.';}catch(e){msg.textContent=e.message;}finally{b.disabled=false;}}
  async function verifyCode(){const code=document.getElementById('otp').value.trim();const b=document.getElementById('verify');if(code.length!==6||!Array.from(code).every(c=>c>='0'&&c<='9')){msg.textContent='6 haneli kodu girin.';return;}b.disabled=true;msg.textContent='Kod doğrulanıyor…';try{const d=await post('/api/auth/verify',{userId,code});if(d.token){try{sessionStorage.setItem('scalp_token',d.token);localStorage.setItem('scalp_token',d.token);}catch(e){}location.href='/?token='+encodeURIComponent(d.token);}else{location.reload();}}catch(e){msg.textContent=e.message;}finally{b.disabled=false;}}
  function back(){document.getElementById('step2').classList.remove('active');document.getElementById('step1').classList.add('active');document.getElementById('otp').value='';msg.textContent='';}
  document.getElementById('tgid').addEventListener('keydown',e=>{if(e.key==='Enter')requestCode()});document.getElementById('otp').addEventListener('keydown',e=>{if(e.key==='Enter')verifyCode()});
  </script></body></html>`;
}

function createAdminAuth({ telegram, env = process.env, now = () => Date.now(), randomInt = crypto.randomInt } = {}) {
  const otps = new Map();
  const sessions = new Map();
  const cooldowns = new Map();
  let lastAdminLookupError = null;
  const sessionCookieSecure = env.NODE_ENV === 'production';
  // Always resolve authorization from the live administrators of TELEGRAM_CHAT_ID.
  // TELEGRAM_ADMIN_IDS is intentionally not required for web-panel access.
  async function adminIds({ refresh = false } = {}) {
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
      return [...new Set(ids.map(String).filter(x => /^\d{5,20}$/.test(x)))];
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

  async function requestCode(userId) {
    if (!/^\d{5,20}$/.test(String(userId || ''))) return { ok: true };
    const admins = await adminIds();
    if (admins === null) {
      return { ok: false, error: 'Telegram grup yöneticileri okunamadı. ' + (lastAdminLookupError || 'TELEGRAM_CHAT_ID ve botun grup erişimini kontrol edin.') };
    }
    if (!admins.includes(String(userId))) return { ok: true };
    const id = String(userId);
    const last = cooldowns.get(id) || 0;
    if (now() - last < OTP_COOLDOWN_MS) return { ok: true };
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

  async function verifyCode(userId, code) {
    const id = String(userId || '');
    const entry = otps.get(id);
    // Re-check current group/channel admin membership at verification time too.
    const admins = await adminIds();
    if (admins === null) return null;
    if (!admins.includes(id) || !entry || entry.expiresAt < now() || entry.attempts >= MAX_OTP_ATTEMPTS) {
      otps.delete(id);
      return null;
    }
    entry.attempts++;
    const supplied = hashCode(id, String(code || ''), entry.salt);
    if (!safeEqual(supplied, entry.hash)) {
      if (entry.attempts >= MAX_OTP_ATTEMPTS) otps.delete(id);
      return null;
    }
    otps.delete(id);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId: id, expiresAt: now() + SESSION_TTL_MS });
    return { token, userId: id, expiresAt: now() + SESSION_TTL_MS };
  }

  function getSession(req) {
    const authHeader = req.headers?.authorization;
    const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const headerToken = req.headers?.['x-session-token'];
    const queryToken = req.query?.token || req.query?._token;
    const cookieToken = parseCookies(req.headers?.cookie)[COOKIE];
    const token = bearer || headerToken || queryToken || cookieToken;
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

  function middleware(req, res, next) {
    if (req.path.startsWith('/api/auth/')) return next();
    const session = getSession(req);
    if (session) {
      req.adminSession = session;
      if (req.query?.token && req.query.token === session.token) {
        setCookie(res, session.token);
      }
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

  function createQuickSession(userId = 'admin') {
    const token = crypto.randomBytes(32).toString('base64url');
    const session = { userId, expiresAt: now() + SESSION_TTL_MS };
    sessions.set(token, session);
    return { token, ...session };
  }

  return { requestCode, verifyCode, refreshAdminList, createQuickSession, getSession, setCookie, clearCookie, middleware, logout, _internal: { otps, sessions, cooldowns, adminIds } };
}

module.exports = { createAdminAuth, loginPage, parseCookies };
