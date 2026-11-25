'use strict';

const assert = require('assert');
const { createAdminAuth, parseCookies } = require('../src/adminAuth');

// Yeni davranışlar (25.11.2026): hız sınırı, kilit, yönetici listesi önbelleği, Telegram'a erken gitmeme, ?token= yok.
async function extra() {
  let t = 5_000_000;
  const calls = { list: 0, send: 0 };
  let list = ['11111111', '22222222'];
  const tg = {
    getGroupAdminIds: async () => { calls.list++; return list; },
    sendPrivate: async () => { calls.send++; return true; },
  };
  const mk = () => createAdminAuth({ env: { NODE_ENV: 'test' }, now: () => t, randomInt: () => 42, telegram: tg });

  // Yönetici listesi 30 sn önbellekli: art arda istekler Telegram'ı bir kez çağırır
  let a = mk();
  await a.requestCode('11111111'); t += 5_000;
  await a.requestCode('11111111');
  assert.strictEqual(calls.list, 1, 'admin list is cached for 30 s (got ' + calls.list + ' lookups)');
  t += 31_000;
  await a.requestCode('11111111');
  assert.strictEqual(calls.list, 2, 'cache expires after 30 s');

  // Kullanıcı ID başına saatte 5 kod isteği; 6. istek 429, Telegram çağrılmaz
  calls.list = 0; a = mk();
  for (let i = 0; i < 5; i++) { t += 61_000; assert.strictEqual((await a.requestCode('22222222')).ok, true); }
  const before = { ...calls };
  const limited = await a.requestCode('22222222');
  assert.strictEqual(limited.ok, false); assert.strictEqual(limited.status, 429); assert.match(limited.error, /saatte en fazla 5/);
  assert.deepStrictEqual(calls, before, 'rate-limited request must not touch Telegram');
  t += 60 * 60 * 1000 + 1;
  assert.strictEqual((await a.requestCode('22222222')).ok, true, 'limit resets after an hour');

  // Geçersiz biçimli ID Telegram'ı çağırmaz ve sayaç tutmaz
  const c0 = calls.list; a = mk();
  assert.deepStrictEqual(await a.requestCode('abc'), { ok: true });
  assert.strictEqual(calls.list, c0, 'malformed ID must not reach Telegram');
  assert.strictEqual(a._internal.reqLog.size, 0);

  // Bekleyen OTP yokken verify Telegram'ı hiç çağırmaz
  a = mk(); const c1 = calls.list;
  assert.strictEqual(await a.verifyCode('11111111', '000042'), null);
  assert.strictEqual(calls.list, c1, 'verify without a pending OTP must not call Telegram');

  // 24 saatte 15 yanlış kod → 24 saat kilit (kod gönderilmez, 429)
  a = mk(); t += 1000;
  let guard = 0;
  while (!a.isLocked('11111111') && guard++ < 40) {
    t += 61_000;                               // cooldown + saatlik sınır dışında kalmak için aralık bırak
    if (a._internal.reqLog.get('11111111')?.length >= 5) a._internal.reqLog.clear();
    await a.requestCode('11111111');
    for (let k = 0; k < 5 && a._internal.otps.has('11111111'); k++) await a.verifyCode('11111111', '999999');
  }
  assert(a.isLocked('11111111'), 'ID is locked after 15 wrong verifications');
  assert(a._internal.failLog.get('11111111|').count === 15, 'lock happens exactly at 15 (got ' + a._internal.failLog.get('11111111|').count + ')');
  const sentBefore = calls.send;
  const lockedReq = await a.requestCode('11111111');
  assert.strictEqual(lockedReq.status, 429); assert.match(lockedReq.error, /24 saat/);
  assert.strictEqual(calls.send, sentBefore, 'locked ID gets no code');
  t += 24 * 60 * 60 * 1000 + 1;
  assert(!a.isLocked('11111111'), 'lock expires after 24 h');

  // Kilit DoS: saldırganın başka IP'den yaptığı 15 yanlış yöneticiyi kendi IP'sinden kilitlemez
  const wrong = async (x, id, ip, n) => {
    for (let i = 0; i < n; i++) {
      t += 61_000;
      x._internal.reqLog.clear();
      await x.requestCode(id, ip);
      await x.verifyCode(id, '999999', ip);
    }
  };
  a = mk(); t += 1000;
  await wrong(a, '11111111', '6.6.6.6', 15);
  assert(a.isLocked('11111111', '6.6.6.6'), 'attacker IP is locked after 15 wrong');
  assert(!a.isLocked('11111111', '1.1.1.1'), 'attacker must not lock the admin out from the admin own IP');
  assert.strictEqual((await a.requestCode('11111111', '6.6.6.6')).status, 429, 'locked IP gets 429 on code request');
  t += 61_000; const sent0 = calls.send;
  assert.strictEqual((await a.requestCode('11111111', '1.1.1.1')).ok, true);
  assert.strictEqual(calls.send, sent0 + 1, 'admin still gets a code from their own IP');
  assert(await a.verifyCode('11111111', '000042', '1.1.1.1'), 'admin logs in from own IP while attacker IP is locked');
  // Aynı IP 15 yanlışta kilitlenir (14'te değil)
  a = mk(); t += 1000;
  await wrong(a, '11111111', '5.5.5.5', 14);
  assert(!a.isLocked('11111111', '5.5.5.5'), 'not locked at 14');
  await wrong(a, '11111111', '5.5.5.5', 1);
  assert(a.isLocked('11111111', '5.5.5.5'), 'locked at 15 from the same IP');
  // ID başına IP'den bağımsız tavan: 60 yanlış → o ID için doğrulama herkese kapalı
  a = mk(); t += 1000;
  for (let ip = 0; ip < 4; ip++) await wrong(a, '11111111', '7.7.7.' + ip, 14);   // 56, hiçbir çift kilitli değil
  assert(!a.isLocked('11111111', '1.1.1.1'), 'below the per-ID ceiling no one is locked');
  await wrong(a, '11111111', '7.7.8.0', 4);
  assert.strictEqual(a._internal.failTotal.get('11111111').count, 60, 'per-ID ceiling hit at exactly 60');
  assert(a.isLocked('11111111', '1.1.1.1'), 'after 60 wrong, verification is closed for that ID from any IP');
  t += 61_000; await a.requestCode('11111111', '1.1.1.1');
  assert.strictEqual(await a.verifyCode('11111111', '000042', '1.1.1.1'), null, 'verify is refused while the ID ceiling is active');
  t += 24 * 60 * 60 * 1000 + 1;
  assert(!a.isLocked('11111111', '1.1.1.1'), 'ceiling lock expires after 24 h');
  // Tahliye: tümü kilitliyken de Map sınırı aşılmaz
  a = mk();
  // fly-client-ip yalnız Fly ortamında güvenilir
  const flyOn = createAdminAuth({ env: { NODE_ENV: 'test', FLY_APP_NAME: 'x' }, now: () => t, telegram: tg });
  assert.strictEqual(flyOn.clientIp({ headers: { 'fly-client-ip': '8.8.8.8' }, socket: { remoteAddress: '10.0.0.1' } }), '8.8.8.8');
  assert.strictEqual(a.clientIp({ headers: { 'fly-client-ip': '8.8.8.8' }, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1', 'header ignored outside Fly');
  {
    const res2 = { setHeader() {}, status(c) { this.code = c; return this; }, json() { return this; } };
    let ok = 0; const x = mk();
    for (let i = 0; i < 21; i++) x.authRateLimit({ headers: { 'fly-client-ip': '4.4.4.' + i }, socket: { remoteAddress: '2.2.2.2' } }, res2, () => { ok++; });
    assert.strictEqual(ok, 20); assert.strictEqual(res2.code, 429, '21st request is 429 even with rotating spoofed fly-client-ip');
  }

  // Sayaç Map'leri sınırlı
  a = mk();
  for (let i = 0; i < 1500; i++) await a.requestCode(String(30000000 + i));
  assert(a._internal.reqLog.size <= 1000, 'reqLog is bounded (' + a._internal.reqLog.size + ')');
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = 0;
  for (let i = 0; i < 25; i++) a.authRateLimit({ headers: { 'fly-client-ip': '1.2.3.4' }, socket: {} }, res, () => { passed++; });
  assert.strictEqual(passed, 20, 'IP limit lets 20 /api/auth requests through per 10 min');
  assert.strictEqual(res.code, 429);
  t += 10 * 60 * 1000 + 1;
  a.authRateLimit({ headers: { 'fly-client-ip': '1.2.3.4' }, socket: {} }, res, () => { passed++; });
  assert.strictEqual(passed, 21, 'IP window resets after 10 min');

  // GET /session sayılmaz; request-code (POST) 21. istekte 429
  const sa = mk(); let sp = 0, sr = { headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json() { return this; } };
  const rq = (method, path) => ({ method, path, headers: { 'fly-client-ip': '8.8.8.8' }, socket: {} });
  for (let i = 0; i < 30; i++) sa.authRateLimit(rq('GET', '/session'), sr, () => { sp++; });
  assert.strictEqual(sp, 30); assert.strictEqual(sr.code, undefined, '30 GET /session never 429');
  let rp = 0;
  for (let i = 0; i < 21; i++) sa.authRateLimit(rq('POST', '/request-code'), sr, () => { rp++; });
  assert.strictEqual(rp, 20); assert.strictEqual(sr.code, 429, 'request-code still 429 on 21st');

  // Grup üyesi (yönetici değil): kod alır, role=member; üye değilse kod yok
  const sentTo = [];
  const mt = { getGroupAdminIds: async () => ['11111111'], isMember: async id => id === '33333333', sendPrivate: async id => { sentTo.push(id); return true; } };
  const m = createAdminAuth({ env: { NODE_ENV: 'test' }, now: () => t, randomInt: () => 42, telegram: mt });
  await m.requestCode('44444444'); t += 61_000;
  await m.requestCode('33333333');
  assert.deepStrictEqual(sentTo, ['33333333'], 'only the member gets a code');
  assert.strictEqual(await m.verifyCode('44444444', '000042'), null);
  const mv = await m.verifyCode('33333333', '000042');
  assert(mv && mv.role === 'member', 'member session role');
  assert.strictEqual(m.getSession({ headers: { cookie: 'scalp_admin_session=' + mv.token } }).role, 'member');
  t += 6 * 60_000;
  assert.strictEqual((await m.authorize({ token: mv.token })).ok, true, 'member recheck passes while still a member');
  t += 6 * 60_000; mt.isMember = async () => false; t += 11 * 60_000;
  const dropped = await m.authorize({ token: mv.token });
  assert.strictEqual(dropped.status, 403, 'member who left is dropped');
  const am = createAdminAuth({ env: { NODE_ENV: 'test' }, now: () => t, randomInt: () => 42, telegram: { ...mt, isMember: async () => true } });
  await am.requestCode('11111111');
  assert.strictEqual((await am.verifyCode('11111111', '000042')).role, 'admin', 'admin keeps admin role even if also a member');

  // ?token= artık hiçbir yerde oturum açmaz
  const b = mk(); list = ['11111111']; t += 61_000;
  await b.requestCode('11111111');
  const v = await b.verifyCode('11111111', '000042');
  assert(v && v.token);
  assert.strictEqual(b.getSession({ headers: {}, query: { token: v.token } }), null, 'query token must not create a session');
  assert.strictEqual(b.getSession({ headers: {}, query: { token: v.token } }, { allowQuery: true }), null, 'allowQuery option is gone');
  assert(b.getSession({ headers: { cookie: 'scalp_admin_session=' + v.token } }), 'cookie still works');
  const lp = require('../src/adminAuth').loginPage();
  assert(!/<script>|onclick=|localStorage|sessionStorage|\?token=/.test(lp), 'login page has no inline script, inline handlers or URL/Storage token');
  assert(lp.includes('src="/panel/login.js"'));
}

async function main() {
  let time = 1_000_000;
  const sent = [];
  let groupAdmins = ['12345678', '87654321'];
  let refreshCalls = 0;
  const telegram = {
    getGroupAdminIds: async () => groupAdmins,
    refreshGroupAdminIds: async () => { refreshCalls++; return groupAdmins; },
    sendPrivate: async (id, text) => { sent.push({ id, text }); return true; },
  };
  const auth = createAdminAuth({
    env: { NODE_ENV: 'test' },
    now: () => time,
    randomInt: () => 42,
    telegram,
  });

  assert.deepStrictEqual(parseCookies('a=1; scalp_admin_session=hello%20world'), { a: '1', scalp_admin_session: 'hello world' });

  // Live Telegram group admins are discovered automatically; no TELEGRAM_ADMIN_IDS secret is required.
  assert.deepStrictEqual(await auth.requestCode('12345678'), { ok: true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].id, '12345678', 'OTP must go to a live group admin');
  assert(sent[0].text.includes('000042'));
  assert.deepStrictEqual(await auth.requestCode('12345678'), { ok: true }, 'cooldown prevents repeat OTP sends');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(await auth.requestCode('99999999'), { ok: true });
  assert.strictEqual(sent.length, 1, 'non-admin must not receive a code');

  assert.strictEqual(await auth.verifyCode('12345678', '111111'), null);
  assert.strictEqual(await auth.verifyCode('12345678', '222222'), null, 'wrong code must not allow login');
  time += 60_001;
  await auth.requestCode('12345678');
  const verified = await auth.verifyCode('12345678', '000042');
  assert(verified && verified.token, 'valid OTP should create session');
  assert.strictEqual(verified.userId, '12345678');
  const session = auth._internal.sessions.get(verified.token);
  assert(session.expiresAt > time);
  assert.strictEqual(await auth.verifyCode('12345678', '000042'), null, 'OTP is single-use');

  // Current group-admin membership is rechecked when the OTP is verified.
  const membershipCheck = createAdminAuth({
    env: { NODE_ENV: 'test' },
    now: () => time,
    randomInt: () => 42,
    telegram,
  });
  groupAdmins = ['87654321'];
  await membershipCheck.requestCode('87654321');
  groupAdmins = ['12345678'];
  time += 31_000;   // yönetici listesi 30 sn önbelleklenir; süre dolunca taze liste okunur
  assert.strictEqual(await membershipCheck.verifyCode('87654321', '000042'), null, 'removed group admin must not complete login');

  // Refresh must report the current live list, not a previously observed count.
  const refreshed = await auth.refreshAdminList('12345678');
  assert.strictEqual(refreshed.ok, true, 'current group admin can refresh the list');
  assert.strictEqual(refreshed.adminCount, 1, 'refresh reports the current live admin count');
  assert.strictEqual(refreshCalls, 1, 'explicit refresh must call Telegram cache-clearing refresh method');
  const deniedRefresh = await auth.refreshAdminList('11111111');
  assert.strictEqual(deniedRefresh.ok, false, 'non-admin cannot refresh the list');

  // Unauthenticated/non-member IDs must not consume the hourly OTP quota.
  const nonMemberAuth = createAdminAuth({
    env: { NODE_ENV: 'test' }, now: () => time,
    telegram: {
      getGroupAdminIds: async () => [],
      isMember: async () => false,
      sendPrivate: async () => { throw new Error('must not send OTP to non-member'); },
    },
  });
  assert.deepStrictEqual(await nonMemberAuth.requestCode('55555555'), { ok: true });
  assert.strictEqual(nonMemberAuth._internal.reqLog.has('55555555'), false,
    'non-member request must not consume a per-ID OTP slot');

  const sendFailure = createAdminAuth({
    env: { NODE_ENV: 'test' }, now: () => time,
    telegram: { getGroupAdminIds: async () => ['12345678'], sendPrivate: async () => false },
  });
  assert.deepStrictEqual(await sendFailure.requestCode('12345678'), { ok: false, error: 'Telegram mesajı gönderilemedi. Botla özel sohbeti başlatıp tekrar deneyin.' });

  // A Telegram API failure must be reported instead of pretending an OTP was sent.
  const originalConsoleError = console.error;
  try {
    console.error = () => {};
    const listFailure = createAdminAuth({
      env: { NODE_ENV: 'test' }, now: () => time,
      telegram: {
        getGroupAdminIds: async () => { throw new Error('Bad Request: chat not found'); },
        sendPrivate: async () => { throw new Error('must not send OTP when admin lookup fails'); },
      },
    });
    const failure = await listFailure.requestCode('12345678');
    assert.strictEqual(failure.ok, false);
    assert.match(failure.error, /Telegram grup yöneticileri okunamadı/);
  } finally {
    console.error = originalConsoleError;
  }

  await extra();

  time += 8 * 60 * 60 * 1000 + 1;
  assert.strictEqual(auth.getSession({ headers: { cookie: 'scalp_admin_session=' + verified.token } }), null, 'expired sessions must be rejected');
  console.log('PASS: automatic live group-admin discovery, OTP cooldown, membership recheck, single-use code, session expiry');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
