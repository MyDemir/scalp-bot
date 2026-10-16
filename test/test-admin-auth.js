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
    env: { TELEGRAM_ADMIN_IDS: '99999999', NODE_ENV: 'test' },
    now: () => time,
    randomInt: () => 42,
    telegram,
  });

  assert.deepStrictEqual(parseCookies('a=1; scalp_admin_session=hello%20world'), { a: '1', scalp_admin_session: 'hello world' });

  // A configured allowlist is authoritative: listed IDs work, other live group admins do not.
  assert.deepStrictEqual(await auth.requestCode('12345678'), { ok: true }, 'response must not disclose allowlist');
  assert.strictEqual(sent.length, 0, 'ID outside configured allowlist must not receive a code');
  assert.deepStrictEqual(await auth.requestCode('99999999'), { ok: true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].id, '99999999', 'OTP must go to configured Telegram admin');
  assert(sent[0].text.includes('000042'));
  assert.deepStrictEqual(await auth.requestCode('99999999'), { ok: true }, 'cooldown prevents repeat OTP sends');
  assert.strictEqual(sent.length, 1);

  assert.strictEqual(await auth.verifyCode('99999999', '111111'), null);
  assert.strictEqual(await auth.verifyCode('99999999', '222222'), null, 'wrong code must not allow login');
  time += 60_001;
  await auth.requestCode('99999999');
  const verified = await auth.verifyCode('99999999', '000042');
  assert(verified && verified.token, 'valid OTP should create session');
  assert.strictEqual(verified.userId, '99999999');
  const session = auth._internal.sessions.get(verified.token);
  assert(session.expiresAt > time);
  assert.strictEqual(await auth.verifyCode('99999999', '000042'), null, 'OTP is single-use');

  // Without an explicit allowlist, fall back to the live Telegram group-admin list.
  const fallback = createAdminAuth({
    env: { NODE_ENV: 'test' },
    now: () => time,
    randomInt: () => 42,
    telegram,
  });
  assert.deepStrictEqual(await fallback.requestCode('87654321'), { ok: true });
  groupAdmins = ['12345678'];
  assert.strictEqual(await fallback.verifyCode('87654321', '000042'), null, 'removed group admin must not complete login');

  const limited = createAdminAuth({
    env: { TELEGRAM_ADMIN_IDS: '12345678' }, now: () => time,
    telegram: { getGroupAdminIds: async () => [], sendPrivate: async () => false },
  });
  assert.deepStrictEqual(await limited.requestCode('12345678'), { ok: false, error: 'Telegram mesajı gönderilemedi. Botla özel sohbeti başlatıp tekrar deneyin.' });

  time += 8 * 60 * 60 * 1000 + 1;
  assert.strictEqual(auth.getSession({ headers: { cookie: 'scalp_admin_session=' + verified.token } }), null, 'expired sessions must be rejected');
  console.log('PASS: configured Telegram allowlist, live-admin fallback, OTP cooldown, single-use code, session expiry');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
