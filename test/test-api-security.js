'use strict';
// Web paneli API güvenliği: kimlik doğrulama, canlı yönetici yetki kontrolü, CSRF, URL belirteci,
// harici bot anahtarı, girdi temizliği (stored XSS) ve istatistik okumalarının sayaç sıfırlamaması.
// Ağ gerekmez: Telegram yönetici listesi ve özel mesaj gönderimi taklit edilir.

const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.EXTERNAL_BOT_KEY = 'test-bot-key-0123456789';
const LOG_DIR = require('path').join(__dirname, '.tmp', 'api-logs');
require('fs').rmSync(LOG_DIR, { recursive: true, force: true });
process.env.LOG_DIR = LOG_DIR;

const telegram = require('../src/telegram');
let admins = ['12345678'];
const dms = [];
telegram.getGroupAdminIds = async () => admins;
telegram.refreshGroupAdminIds = async () => admins;
let members = [];
telegram.isMember = async id => members.includes(String(id));
telegram.sendPrivate = async (id, text) => { dms.push({ id, text }); return true; };

const app = require('../src/server');

async function main() {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, { method = 'GET', token, body, headers = {} } = {}) => fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    // ── Kimlik doğrulama: oturumsuz hiçbir API ucu veri vermez ─────────────
    for (const [method, path] of [['GET', '/api/status'], ['GET', '/api/settings'], ['GET', '/api/logs'], ['GET', '/api/external-bots'], ['GET', '/api/logs/days'], ['GET', '/api/logs/history'], ['GET', '/api/logs/export?day=2026-01-01'],
      ['POST', '/api/settings'], ['POST', '/api/logs/clear'], ['POST', '/api/run-tests'], ['POST', '/api/notify-panel'], ['DELETE', '/api/external-bots/x']]) {
      const r = await req(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.strictEqual(r.status, 401, `${method} ${path} must require a session (got ${r.status})`);
    }
    const loginHtml = await (await req('/')).text();
    assert(loginHtml.includes('Yönetici Girişi'), 'unauthenticated panel shows the login page');
    assert.strictEqual((await req('/api/status', { token: 'forged-token' })).status, 401, 'unknown token rejected');

    // ── Güvenlik başlıkları ─────────────────────────────────────────────
    const h = await req('/api/status');
    assert.strictEqual(h.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(h.headers.get('cache-control'), 'no-store');
    assert.strictEqual(h.headers.get('x-powered-by'), null);

    // ── OTP ile giriş ──────────────────────────────────────────────────
    assert.strictEqual((await req('/api/auth/request-code', { method: 'POST', body: { userId: '12345678' } })).status, 202);
    const code = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const verify = await req('/api/auth/verify', { method: 'POST', body: { userId: '12345678', code } });
    assert.strictEqual(verify.status, 200);
    const { token } = await verify.json();
    assert(token, 'verify returns a session token');
    const cookie = verify.headers.get('set-cookie');
    assert(/HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie), 'session cookie is HttpOnly + SameSite');

    assert.strictEqual((await req('/api/status', { token })).status, 200, 'bearer session can read status');
    assert.strictEqual((await req('/api/status', { headers: { cookie: 'scalp_admin_session=' + token } })).status, 200, 'cookie session works');
    assert.strictEqual((await req('/api/status?token=' + token)).status, 401, 'URL token must not authorize API calls');
    // 25.11.2026: ?token= TERS çevrildi — artık hiçbir yolda (panel dahil) oturum açmaz, çerez de kurulmaz.
    const panel = await req('/?token=' + token);
    assert.strictEqual(panel.status, 200);
    assert((await panel.text()).includes('Yönetici Girişi'), 'URL token no longer opens the dashboard: login page is shown');
    assert(!/scalp_admin_session=/.test(panel.headers.get('set-cookie') || ''), 'URL token is not converted into a cookie');
    assert.strictEqual(panel.headers.get('cache-control'), 'no-store', 'login page is no-store');
    assert((await (await req('/', { headers: { cookie: 'scalp_admin_session=' + token } })).text()).length > 0);

    // ── CSRF: farklı kaynaktan yazma isteği reddedilir ───────────────────
    const csrf = await req('/api/logs/clear', { method: 'POST', headers: { cookie: 'scalp_admin_session=' + token, origin: 'https://evil.example' } });
    assert.strictEqual(csrf.status, 403, 'cross-origin POST is rejected');
    // ── Panel salt okunur: oturumlu kullanıcı da ayar/durum değiştiremez ────────
    for (const [method, path] of [['POST', '/api/settings'], ['POST', '/api/logs/clear'], ['POST', '/api/run-tests'], ['POST', '/api/notify-panel'],
      ['POST', '/api/external-bots/register'], ['DELETE', '/api/external-bots/x'], ['PUT', '/api/settings']]) {
      const r = await req(path, { method, token, headers: { origin: base }, body: method === 'DELETE' ? undefined : { rsiMin: 1 } });
      assert.strictEqual(r.status, 405, `${method} ${path} must be read-only (got ${r.status})`);
    }
    assert.strictEqual((await req('/api/logs/history?day=../x', { token })).status, 400, 'log day parameter is validated');
    assert.strictEqual((await req('/api/logs/days', { token })).status, 200, 'log history is readable');
    assert.strictEqual((await req('/api/reports/ayar?args=rsiMin%2050', { token })).status, 404, 'setting-changing commands are not exposed as reports');
    assert.strictEqual((await req('/api/reports/istatistik', { token })).status, 200, 'read-only reports are available');
    assert.strictEqual((await req('/api/reports/istatistik')).status, 401, 'reports require a session');
    // Diske yalnızca uyarı ve hata yazılır; "[UYARI] …" console.log satırı uyarı sayılır.
    console.log('[HEARTBEAT] sağlıklı'); console.log('[UYARI] 1m mum gecikmesi 45 sn'); console.error('[REST] ECONNRESET');
    const hist = await (await req('/api/logs/history', { token })).json();
    const tags = hist.entries.map(e => e.tag + ':' + e.level);
    assert(tags.includes('UYARI:warn') && tags.includes('REST:error'), 'warnings and errors are persisted: ' + tags);
    assert(!tags.some(t => t.startsWith('HEARTBEAT')), 'info lines are not persisted');
    const live = await (await req('/api/logs', { token })).json();
    assert(live.logs.some(l => l.tag === 'HEARTBEAT'), 'info lines still appear in the live stream');

    const settings = await (await req('/api/settings', { token })).json();
    assert(settings.ok && settings.settings && Array.isArray(settings.defs), 'settings are readable for the mirror view');
    const dash = await (await req('/', { token })).text();
    // Tarayıcıya giden satır içi betikler sözdizimi hatası içermemeli (şablon dizgesi kaçışları).
    for (const [, js] of dash.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new (require('vm').Script)(js), 'served dashboard script must parse');
    }
    for (const gone of ['saveSettings(', 'clearLogs(', 'runTests(', 'openAddBotModal(', 'notifyTelegramPanel(', 'data-delete-bot', 'refreshTelegramAdmins(']) {
      assert(!dash.includes(gone), `dashboard must not expose write control ${gone}`);
    }

    // ── Girdi temizliği / stored XSS ─────────────────────────────────────
    const xss = '<img src=x onerror=alert(1)>';
    const botKey = { 'x-bot-key': process.env.EXTERNAL_BOT_KEY };
    const reg = await req('/api/external-bots/heartbeat', { method: 'POST', headers: botKey, body: { id: 'bad"id<script>', name: xss } });
    assert.strictEqual(reg.status, 400, 'bot id with HTML metacharacters is rejected');
    const big = { id: 'xss-bot', name: xss + 'A'.repeat(500), lastSignal: { nested: true }, status: '<b>', metrics: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, { evil: i }])) };
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', headers: botKey, body: big })).status, 200);
    const bots = (await (await req('/api/external-bots', { token })).json()).bots;
    const stored = bots.find(b => b.id === 'xss-bot');
    assert(stored.name.length <= 80, 'name is length-limited');
    assert.strictEqual(stored.lastSignal, '—', 'non-string lastSignal is discarded');
    assert.strictEqual(stored.status, 'online', 'unknown status is not stored');
    assert.deepStrictEqual(stored.metrics, {}, 'object metric values are discarded');
    assert.strictEqual(stored.type, 'remote', 'remote bot cannot claim local type');
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', headers: botKey, body: { id: 'scalp-primary', name: 'x' } })).status, 400, 'local bot cannot be spoofed');

    // ── Harici bot anahtarı ────────────────────────────────────────────
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', body: { id: 'key-bot' } })).status, 401, 'heartbeat without key is rejected');
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', token, body: { id: 'key-bot' } })).status, 401, 'admin session alone cannot write bot state');
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', body: { id: 'key-bot' }, headers: { 'x-bot-key': 'wrong-key-0123456789' } })).status, 401, 'wrong bot key rejected');
    assert.strictEqual((await req('/api/external-bots/heartbeat', { method: 'POST', body: { id: 'key-bot', name: 'Anahtar' }, headers: { 'x-bot-key': process.env.EXTERNAL_BOT_KEY } })).status, 200, 'valid bot key may heartbeat');
    assert.strictEqual((await req('/api/external-bots', { headers: { 'x-bot-key': process.env.EXTERNAL_BOT_KEY } })).status, 401, 'bot key grants nothing beyond heartbeat');

    // ── İstatistik okumaları sayaçları sıfırlamaz ─────────────────────────
    const s1 = await (await req('/api/status', { token })).json();
    const s2 = await (await req('/api/status', { token })).json();
    assert.deepStrictEqual(s2.telegram.stats.sent, s1.telegram.stats.sent, 'polling /api/status keeps telegram counters');
    assert.deepStrictEqual(s2.diagnostics.errorCount, s1.diagnostics.errorCount);

    // ── Yetki: yöneticilikten çıkarılan kullanıcının oturumu yazma işleminde iptal edilir ──
    admins = ['87654321'];
    app.locals.adminAuth._internal.clearAdminCache();                    // yönetici listesi 30 sn önbelleklenir
    app.locals.adminAuth._internal.sessions.get(token).verifiedAt = 0;   // periyodik yeniden doğrulama zamanı geldi
    const revoked = await req('/api/status', { token });
    assert.strictEqual(revoked.status, 403, 'removed admin is rejected on the next periodic recheck');
    assert.strictEqual((await req('/api/status', { token })).status, 401, 'revoked session can no longer read');

    // Telegram doğrulaması yapılamıyorsa yazma işlemi reddedilir (fail closed)
    admins = ['55555555'];
    app.locals.adminAuth._internal.clearAdminCache();
    await req('/api/auth/request-code', { method: 'POST', body: { userId: '55555555' } });
    const code2 = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const token2 = (await (await req('/api/auth/verify', { method: 'POST', body: { userId: '55555555', code: code2 } })).json()).token;
    assert(token2, 'another live admin can log in');
    const origErr = console.error; console.error = () => {};
    telegram.getGroupAdminIds = async () => { throw new Error('network down'); };
    try {
      assert.strictEqual((await req('/api/status', { token: token2 })).status, 200, 'recently verified session can still read');
      app.locals.adminAuth._internal.clearAdminCache();
      app.locals.adminAuth._internal.sessions.get(token2).verifiedAt = 0;
      const failClosed = await req('/api/status', { token: token2 });
      assert.strictEqual(failClosed.status, 503, 'recheck fails closed when Telegram admin list cannot be read');
    } finally {
      console.error = origErr;
      telegram.getGroupAdminIds = async () => admins;
    }

    // ── 25.11.2026 yenileme: başlıklar, uçlar, IP hız sınırı ─────────────────
    admins = ['55555555'];
    const csp = h.headers.get('content-security-policy') || '';
    assert(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"), 'CSP set on API responses');
    assert.strictEqual(h.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(h.headers.get('strict-transport-security'), null, 'HSTS only in production');
    const lp = await req('/');
    assert.strictEqual(lp.headers.get('x-frame-options'), 'DENY'); assert(lp.headers.get('content-security-policy'));
    assert(!(await lp.text()).includes('<script>'), 'login page has no inline script');
    const loginJs = await req('/panel/login.js');
    assert.strictEqual(loginJs.status, 200, '/panel/login.js is served without a session');
    assert(/addEventListener/.test(await loginJs.text()));
    assert.strictEqual((await req('/panel/index.html')).status, 401, 'other panel files need a session');
    assert.strictEqual((await req('/api/universe', { token: token2 })).status, 404, '/api/universe was removed');
    assert.strictEqual((await req('/api/universe')).status, 401);
    const cv = await (await req('/api/status', { token: token2 })).json();
    assert(cv.coverage && ['oldestCard', 'oldestEvent', 'oldestTouch', 'lastWeeklySlot', 'nextWeeklySlot'].every(k => k in cv.coverage), 'status has coverage');
    for (const p of ['/api/events', '/api/events?limit=5&outcome=d%C3%BC%C5%9Ft%C3%BC', '/api/cards?limit=3', '/api/touches?limit=3']) {
      assert.strictEqual((await req(p)).status, 401, p + ' requires a session');
      assert.strictEqual((await req(p, { token: token2 })).status, 200, p + ' readable with a session');
    }
    assert.strictEqual((await req('/api/paths/NOPEUSDT-1', { token: token2 })).status, 404, 'unknown path is 404');
    assert.strictEqual((await req('/api/paths/NOPEUSDT-1')).status, 401);

    // Gerçek (geçici) kart deposu ile uçların içeriği
    const infoBot = require('../src/infoBot');
    const { createCardStore } = require('../src/cardStore');
    const dbFile = require('path').join(__dirname, '.tmp', 'api-cards.db');
    require('fs').rmSync(dbFile, { force: true });
    const store = createCardStore({ file: dbFile, logger: { log() {}, error() {} } });
    const origGet = infoBot._internal.getStore;
    infoBot._internal.getStore = () => store;
    try {
      const T = Date.now() - 5 * 86_400_000;      // 24 saatten eski: eski uç bunu göstermezdi
      store.add({ id: 'c1', kind: 'card', symbol: 'AAAUSDT', t: T, seq: 1, price: 1, data: { grade: 2 } });
      store.add({ id: 'c2', kind: 'card', symbol: 'BBBUSDT', t: T + 1000, seq: 2, price: 2, data: {} });
      store.add({ id: 'm1', kind: 'move', symbol: 'CCCUSDT', t: T + 2000, seq: 3, price: 3, data: {} });
      store.addTouch({ id: 'tt1', symbol: 'AAAUSDT', t: T, name: 'x', value: 1, hits: 1, pb: 0, pbMin: 1, held: true, up: 1, dn: 1, c60: 1 });
      store.addEvent({ id: 'AAAUSDT-' + T, symbol: 'AAAUSDT', t: T, price: 1, dropT: T + 60000, dropMin: 1, card: true, cardGrade: 2, outcome: 'düştü',
        feat: { grade: 2, score: 5, g_sep: 1, v3x: 7, rsi15: 80, secretField: 'x', price: 1 }, out: { 15: { low: -1, high: 1, close: 0 } } });
      store.addEvent({ id: 'BBBUSDT-' + T, symbol: 'BBBUSDT', t: T + 5, price: 1, outcome: 'devam', feat: { grade: 1 }, out: {} });
      store.addPath({ id: 'AAAUSDT-' + T, symbol: 'AAAUSDT', t: T, entry: 100, n: 2, buf: new Float32Array([1, -1, 0.5, 2, -2, 1]) });
      const cards = (await (await req('/api/cards', { token: token2 })).json());
      assert.strictEqual(cards.source, 'sqlite');
      assert.deepStrictEqual(cards.cards.map(c => c.symbol), ['BBBUSDT', 'AAAUSDT'], 'cards: newest first, only kind=card, no 24 h cut-off');
      assert.strictEqual((await (await req('/api/cards?limit=1', { token: token2 })).json()).cards.length, 1);
      assert.strictEqual((await (await req('/api/touches', { token: token2 })).json()).touches.length, 1);
      const ev = (await (await req('/api/events', { token: token2 })).json()).events;
      assert.strictEqual(ev.length, 2); assert.strictEqual(ev[0].symbol, 'BBBUSDT', 'events newest first');
      const e1 = ev.find(e => e.symbol === 'AAAUSDT');
      assert.strictEqual(e1.hasPath, true); assert.strictEqual(ev[0].hasPath, false);
      assert.strictEqual(e1.feat.grade, 2); assert.strictEqual(e1.feat.g_sep, 1); assert.strictEqual(e1.feat.v3x, 7); assert.strictEqual(e1.feat.rsi15, 80);
      assert(!('secretField' in e1.feat), 'feat is whitelisted');
      assert.strictEqual(e1.cardGrade, 2); assert.deepStrictEqual(e1.out[15], { low: -1, high: 1, close: 0 });
      const filtered = (await (await req('/api/events?outcome=' + encodeURIComponent('devam'), { token: token2 })).json()).events;
      assert.deepStrictEqual(filtered.map(e => e.symbol), ['BBBUSDT'], 'outcome filter');
      const pr = await req('/api/paths/' + encodeURIComponent('AAAUSDT-' + T), { token: token2 });
      assert.strictEqual(pr.status, 200);
      const pj = (await pr.json()).path;
      assert.strictEqual(pj.n, 2); assert.strictEqual(pj.bars.length, 2); assert.strictEqual(pj.bars[0].h, 101); assert.strictEqual(pj.bars[1].l, 98);
      const cov = (await (await req('/api/status', { token: token2 })).json()).coverage;
      assert.strictEqual(cov.oldestCard, T); assert.strictEqual(cov.oldestEvent, T); assert.strictEqual(cov.oldestTouch, T);
    } finally {
      infoBot._internal.getStore = origGet; store.close(); require('fs').rmSync(dbFile, { force: true });
    }

    // ── Grup üyesi erişimi (25.11.2026): üye OTP alır, role=member, yönetici uçları 403 ──
    members = ['77777777'];
    const dmN = dms.length;
    assert.strictEqual((await req('/api/auth/request-code', { method: 'POST', body: { userId: '66666666' } })).status, 202);
    assert.strictEqual(dms.length, dmN, 'non-member (not admin, not member) gets no code');
    assert.strictEqual((await req('/api/auth/request-code', { method: 'POST', body: { userId: '77777777' } })).status, 202);
    assert.strictEqual(dms.length, dmN + 1, 'group member gets a code by private message');
    const mcode = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const mv = await (await req('/api/auth/verify', { method: 'POST', body: { userId: '77777777', code: mcode } })).json();
    assert(mv.token && mv.role === 'member', 'member logs in with role member');
    const ms = await (await req('/api/auth/session', { token: mv.token })).json();
    assert.strictEqual(ms.role, 'member');
    assert.strictEqual((await (await req('/api/auth/session', { token: token2 })).json()).role, 'admin');
    for (const p of ['/api/logs', '/api/logs/days', '/api/logs/history', '/api/external-bots', '/api/settings']) {
      const r = await req(p, { token: mv.token });
      assert.strictEqual(r.status, 403, 'member must not read ' + p);
      assert.deepStrictEqual(await r.json(), { ok: false, error: 'Yalnız yönetici' });
      assert.strictEqual((await req(p, { token: token2 })).status, 200, 'admin reads ' + p);
    }
    // Büyük/küçük harf kaçışı: Express yönlendirmesi duyarsızdı, yönetici denetimi duyarlıydı; üye asla 200 almaz
    for (const p of ['/API/logs', '/api/LOGS', '/Api/Settings', '/API/EXTERNAL-BOTS', '/API/logs/days', '/api/Logs/', '/api/Settings/', '/Api/External-Bots']) {
      for (const tk of [mv.token]) {
        const r = await req(p, { token: tk });
        assert([403, 404].includes(r.status), 'member must not reach ' + p + ' (got ' + r.status + ')');
      }
    }
    assert.strictEqual((await req('/API/status', { token: token2 })).status === 200, false, 'upper-case route is not served at all');
    // authorize rolü düşürünce aynı isteğin kendisi eski rolle geçmez: yöneticilikten üyeye düşen ilk istek 403
    {
      const sess = app.locals.adminAuth._internal.sessions;
      sess.set('demote-token', { userId: '12345678', role: 'admin', expiresAt: Date.now() + 3600_000, verifiedAt: 0 });
      const prevAdmins = admins, prevMembers = members;
      admins = []; members = ['12345678'];
      app.locals.adminAuth._internal.clearAdminCache();
      const r = await req('/api/logs', { token: 'demote-token' });
      assert.strictEqual(r.status, 403, 'demoted admin gets 403 on the very request that triggers the recheck (got ' + r.status + ')');
      assert.strictEqual(sess.get('demote-token').role, 'member');
      admins = prevAdmins; members = prevMembers;
      sess.delete('demote-token');
      app.locals.adminAuth._internal.clearAdminCache();
    }
    // recentDispatches: chatId hiç dönmez; üye yalnız kind=card görür
    const origDisp = telegram.getRecentDispatches;
    telegram.getRecentDispatches = () => [
      { kind: 'card', chatId: '-100111', symbol: 'AAAUSDT', ok: true },
      { kind: 'reply', chatId: '-100222', symbol: null, ok: true },
    ];
    try {
      const ad = (await (await req('/api/status', { token: token2 })).json()).telegram.recentDispatches;
      assert.strictEqual(ad.length, 2, 'admin sees all dispatch kinds');
      assert(ad.every(d => !('chatId' in d)), 'admin status has no chatId');
      const md = (await (await req('/api/status', { token: mv.token })).json()).telegram.recentDispatches;
      assert(md.length === 1 && md.every(d => d.kind === 'card' && !('chatId' in d)), 'member sees only card dispatches without chatId');
    } finally { telegram.getRecentDispatches = origDisp; }
    for (const p of ['/api/cards', '/api/touches', '/api/events', '/api/status', '/api/flow']) assert.strictEqual((await req(p, { token: mv.token })).status, 200, 'member reads ' + p);
    // üyelikten çıkan oturum 5 dk'lık yenilemede düşer
    members = [];
    app.locals.adminAuth._internal.clearAdminCache();
    app.locals.adminAuth._internal.sessions.get(mv.token).verifiedAt = 0;
    assert.strictEqual((await req('/api/status', { token: mv.token })).status, 403, 'removed member is dropped on recheck');
    assert.strictEqual((await req('/api/status', { token: mv.token })).status, 401);

    // IP başına 10 dk'da en fazla 20 /api/auth/* isteği
    let n429 = 0;
    for (let i = 0; i < 25; i++) if ((await req('/api/auth/request-code', { method: 'POST', body: { userId: '1' }, headers: { 'fly-client-ip': '9.9.9.' + i } })).status === 429) n429++;   // Fly ortamı değil: başlık yok sayılır, hepsi aynı soket
    assert(n429 >= 5, 'IP limit: spoofed fly-client-ip must not dodge it (got ' + n429 + ' 429s)');
    // GET /api/auth/session sayılmaz: 30 okuma 429 almaz (IP zaten dolu olsa bile)
    for (let i = 0; i < 30; i++) assert.notStrictEqual((await req('/api/auth/session', { token: token2 })).status, 429, 'session read exempt from IP limit');
    assert.strictEqual((await req('/api/status', { token: token2, headers: { 'fly-client-ip': '9.9.9.9' } })).status, 200, 'IP limit applies only to /api/auth/*');

    console.log('PASS: read-only panel, API auth, live admin authorization, CSRF, URL-token restriction, bot key, input sanitizing, non-resetting status reads');
  } finally {
    server.close();
    require('fs').rmSync(LOG_DIR, { recursive: true, force: true });
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(err => { console.error(err); process.exit(1); });
