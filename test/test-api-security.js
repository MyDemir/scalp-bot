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
    const panel = await req('/?token=' + token);
    assert.strictEqual(panel.status, 200);
    assert((await panel.text()).includes('SCALP ENGINE'), 'URL token still opens the dashboard once after login');
    assert(/scalp_admin_session=/.test(panel.headers.get('set-cookie') || ''), 'dashboard open converts URL token into cookie');

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
    app.locals.adminAuth._internal.sessions.get(token).verifiedAt = 0;   // periyodik yeniden doğrulama zamanı geldi
    const revoked = await req('/api/status', { token });
    assert.strictEqual(revoked.status, 403, 'removed admin is rejected on the next periodic recheck');
    assert.strictEqual((await req('/api/status', { token })).status, 401, 'revoked session can no longer read');

    // Telegram doğrulaması yapılamıyorsa yazma işlemi reddedilir (fail closed)
    admins = ['55555555'];
    await req('/api/auth/request-code', { method: 'POST', body: { userId: '55555555' } });
    const code2 = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const token2 = (await (await req('/api/auth/verify', { method: 'POST', body: { userId: '55555555', code: code2 } })).json()).token;
    assert(token2, 'another live admin can log in');
    const origErr = console.error; console.error = () => {};
    telegram.getGroupAdminIds = async () => { throw new Error('network down'); };
    try {
      assert.strictEqual((await req('/api/status', { token: token2 })).status, 200, 'recently verified session can still read');
      app.locals.adminAuth._internal.sessions.get(token2).verifiedAt = 0;
      const failClosed = await req('/api/status', { token: token2 });
      assert.strictEqual(failClosed.status, 503, 'recheck fails closed when Telegram admin list cannot be read');
    } finally {
      console.error = origErr;
      telegram.getGroupAdminIds = async () => admins;
    }

    console.log('PASS: read-only panel, API auth, live admin authorization, CSRF, URL-token restriction, bot key, input sanitizing, non-resetting status reads');
  } finally {
    server.close();
    require('fs').rmSync(LOG_DIR, { recursive: true, force: true });
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(err => { console.error(err); process.exit(1); });
