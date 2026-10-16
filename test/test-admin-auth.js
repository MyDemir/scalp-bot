'use strict';

const assert = require('assert');
const { createAdminAuth, parseCookies } = require('../src/adminAuth');

async function main() {
  let time = 1_000_000;
  const sent = [];
  let groupAdmins = ['12345678', '87654321'];
  const telegram = {
    getGroupAdminIds: async () => groupAdmins,
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
  assert.strictEqual(await membershipCheck.verifyCode('87654321', '000042'), null, 'removed group admin must not complete login');

  // Refresh must report the current live list, not a previously observed count.
  const refreshed = await auth.refreshAdminList('12345678');
  assert.strictEqual(refreshed.ok, true, 'current group admin can refresh the list');
  assert.strictEqual(refreshed.adminCount, 1, 'refresh reports the current live admin count');
  const deniedRefresh = await auth.refreshAdminList('11111111');
  assert.strictEqual(deniedRefresh.ok, false, 'non-admin cannot refresh the list');

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

  time += 8 * 60 * 60 * 1000 + 1;
  assert.strictEqual(auth.getSession({ headers: { cookie: 'scalp_admin_session=' + verified.token } }), null, 'expired sessions must be rejected');
  console.log('PASS: automatic live group-admin discovery, OTP cooldown, membership recheck, single-use code, session expiry');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
