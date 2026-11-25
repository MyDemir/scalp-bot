'use strict';
// Web paneli istemci güvenliği: HTML kaçışı, Telegram HTML beyaz listesi, salt okunurluk, CSP uyumu
// (satır içi betik / olay özniteliği / harici kaynak yok) ve '/' yanıtında oturum belirtecinin gömülmemesi.
// Panel istemcisi src/panel/ altındadır (eski hali src/server.js içindeki şablondu).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.NODE_ENV = 'test';
const PANEL = path.join(__dirname, '..', 'src', 'panel');
const source = fs.readFileSync(path.join(PANEL, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PANEL, 'app.css'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
assert.doesNotThrow(() => new vm.Script(serverSrc), 'server.js must parse before dashboard security checks');
assert.doesNotThrow(() => new vm.Script(source), 'panel app.js must parse before dashboard security checks');

// ── Kaçış yardımcıları (mevcut kontroller, kaynak yolu src/panel/app.js) ──
const helper = source.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/);
assert(helper, 'dashboard must define an HTML escaping helper');

const escapeHtml = vm.runInNewContext('(' + helper[0] + ')');
const payload = `"><img src=x onerror='alert(1)'>&`;
assert.strictEqual(
  escapeHtml(payload),
  '&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;',
  'HTML text and attribute metacharacters must be escaped'
);

for (const token of [
  'escapeHtml(b.name)',
  'escapeHtml(b.telegram ||',
  'escapeHtml(b.lastSignal ||',
  'escapeHtml(k)',
  'escapeHtml(v)',
  'escapeHtml(l.tag)',
  'escapeHtml(t.symbol)',
  'escapeHtml(t.name)',
  'escapeHtml(label)',
  'tgHtml(r.text',
  'escapeHtml(shown)',
]) {
  assert(source.includes(token), `dashboard must escape untrusted field: ${token}`);
}
const tgHelper = source.match(/function tgHtml\(str\) \{[\s\S]*?\n\}/);
assert(tgHelper, 'dashboard must define a Telegram-HTML sanitizer');
const tgHtml = vm.runInNewContext(helper[0] + ';(' + tgHelper[0] + ')');
assert.strictEqual(tgHtml('<b>RSI</b> <img src=x onerror=alert(1)> <a href="javascript:x">l</a>'), '<b>RSI</b> &lt;img src=x onerror=alert(1)&gt; l', 'only b/i/u/code/pre survive');
// Dışa açılan (module.exports) yardımcılar kaynaktaki ile aynı davranır
const app = require('../src/panel/app.js');
assert.strictEqual(app.escapeHtml(payload), escapeHtml(payload), 'exported escapeHtml matches');
assert.strictEqual(app.tgHtml('<pre>x</pre><script>y</script>'), '<pre>x</pre>&lt;script&gt;y&lt;/script&gt;', 'exported tgHtml drops script tags');

// ── Salt okunur: yazma denetimi yok ──
for (const src of [source, html]) {
  assert(!src.includes('deleteBot('), 'read-only dashboard must not offer bot deletion');
  for (const gone of ['saveSettings(', 'clearLogs(', 'runTests(', 'openAddBotModal(', 'notifyTelegramPanel(', 'data-delete-bot', 'refreshTelegramAdmins(', 'openConfirm(', 'confirm-modal']) {
    assert(!src.includes(gone), `dashboard must not expose write control ${gone}`);
  }
}
const methods = [...source.matchAll(/method:\s*'([A-Z]+)'/g)].map(m => m[1]);
assert.deepStrictEqual([...new Set(methods)], ['POST'], 'only POST used by the client is logout');
assert.strictEqual((source.match(/method:\s*'POST'/g) || []).length, 1, 'single POST call (logout)');
assert(/fetch\('\/api\/auth\/logout', \{ method: 'POST'/.test(source), 'the only POST is /api/auth/logout');

// ── Oturum yalnız çerezde: belirteç istemcide tutulmaz/gönderilmez ──
for (const bad of ['__ADMIN_TOKEN__', 'scalp_token', 'Authorization', 'x-session-token', 'sessionStorage']) {
  assert(!source.includes(bad) && !html.includes(bad), `client must not handle session token (${bad})`);
}
assert(/credentials: 'same-origin'/.test(source), 'API calls send same-origin cookies');
assert(/status === 401\) \{ location\.href = '\/'/.test(source), '401 sends the user to the login page');

// ── CSP uyumu: satır içi betik, satır içi olay özniteliği, harici kaynak yok ──
for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  assert(/\bsrc="\/panel\/[a-z]+\.js"/.test(attrs), 'every <script> must load a /panel file: ' + attrs);
  assert.strictEqual(body.trim(), '', 'inline <script> body is not allowed');
}
assert(!/\son[a-z]+\s*=/i.test(html), 'index.html must not use inline event handler attributes');
assert(!/javascript:/i.test(html), 'index.html must not use javascript: URLs');
assert(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(html), 'index.html must not reference external URLs');
assert(!/https?:\/\//i.test(css) && !/@import/i.test(css), 'app.css must not load external resources');
assert(!/https?:\/\//i.test(source), 'app.js must not reference external URLs (CDN, fonts)');
assert(!/cdn\.tailwindcss|fonts\.googleapis|fonts\.gstatic/i.test(html + source + css), 'no CDN / Google Fonts');
assert(!/\.innerHTML\s*=\s*[^;]*\bonclick=/i.test(source) && !/\son(click|change|input|error|load)=/i.test(source), 'app.js must not build inline handlers');
assert(!/\beval\(|new Function\(/.test(source), 'no eval / new Function (CSP without unsafe-eval)');

// ── '/' yanıtı: index.html, no-store, belirteç gömülü değil ──
assert(!/__ADMIN_TOKEN__|currentToken|allowQuery: true/.test(serverSrc), "server '/' must not embed the session token");

const telegram = require('../src/telegram');
const dms = [];
telegram.getGroupAdminIds = async () => ['12345678'];
telegram.refreshGroupAdminIds = async () => ['12345678'];
telegram.sendPrivate = async (id, text) => { dms.push({ id, text }); return true; };
const server = require('../src/server');

(async () => {
  const srv = await new Promise(resolve => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.strictEqual((await fetch(base + '/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '12345678' }) })).status, 202);
    const code = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const verify = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '12345678', code }) });
    assert.strictEqual(verify.status, 200);
    const cookie = String(verify.headers.get('set-cookie') || '').split(';')[0];
    assert(/^scalp_admin_session=./.test(cookie), 'verify sets the session cookie');
    const token = cookie.split('=')[1];

    const root = await fetch(base + '/', { headers: { cookie } });
    assert.strictEqual(root.status, 200);
    assert.strictEqual(root.headers.get('cache-control'), 'no-store', "'/' is not cached");
    const body = await root.text();
    assert.strictEqual(body, html, "'/' serves src/panel/index.html as is");
    assert(!body.includes(token), "'/' must not embed the session token");

    const js = await fetch(base + '/panel/app.js', { headers: { cookie } });
    assert.strictEqual(js.status, 200);
    assert(/javascript/.test(js.headers.get('content-type') || ''), 'app.js served as JavaScript');
    assert(!(await js.text()).includes(token), 'static app.js does not carry the token');
    const cssRes = await fetch(base + '/panel/app.css', { headers: { cookie } });
    assert.strictEqual(cssRes.status, 200);
    assert(/text\/css/.test(cssRes.headers.get('content-type') || ''), 'app.css served as CSS');
    for (const p of ['/panel/', '/panel/../server.js', '/panel/%2e%2e/server.js', '/panel/nope.js', '/panel/.env']) {
      const r = await fetch(base + p, { headers: { cookie } });
      assert.notStrictEqual(r.status, 200, `${p} must not be served (got ${r.status})`);
    }
    // Oturumsuz '/' giriş sayfası döner, panel değil
    const anon = await (await fetch(base + '/')).text();
    assert(!anon.includes('id="page-simdi"'), 'unauthenticated / does not serve the panel');
  } finally {
    srv.close();
  }
  console.log('PASS: dashboard security (escaping, read-only, cookie-only session, CSP-safe static panel, no token in /)');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
