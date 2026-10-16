'use strict';

const assert = require('assert');
const { createAdminAuth, parseCookies } = require('../src/adminAuth');

async function main() {
  let time = 1_000_000;
  const sent = [];
  const auth = createAdminAuth({
    env: { TELEGRAM_ADMIN_IDS: '99999999', NODE_ENV: 'test' },
    now: () => time,
    randomInt: () => 42,
    telegram: { getChatAdminIds: async () => ['12345678', '87654321'], sendPrivate: async (id, text) => { sent.push({ id, text }); return true; } },
  });

  assert.deepStrictEqual(parseCookies('a=1; scalp_admin_session=hello%20world'), { a: '1', scalp_admin_session: 'hello world' });
  assert.deepStrictEqual(await auth.requestCode('99999999'), { ok: true }, 'unknown user response must not disclose allowlist');
  assert.strictEqual(sent.length, 0, 'unknown user must not receive code');

  assert.deepStrictEqual(await auth.requestCode('12345678'), { ok: true });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].id, '12345678', 'OTP must go to the requested allowlisted Telegram admin only');
  assert(sent[0].text.includes('000042'));
  assert.deepStrictEqual(await auth.requestCode('12345678'), { ok: true }, 'cooldown prevents repeat OTP sends');
  assert.strictEqual(sent.length, 1);

  assert.strictEqual(await auth.verifyCode('12345678', '111111'), null);
  assert.strictEqual(await auth.verifyCode('12345678', '222222'), null, 'wrong code attempt must not allow login');
  // A new code cannot be requested until cooldown elapses.
  time += 60_001;
  await auth.requestCode('12345678');
  const verified = await auth.verifyCode('12345678', '000042');
  assert(verified && verified.token, 'valid OTP should create session');
  assert.strictEqual(verified.userId, '12345678');
  const session = auth._internal.sessions.get(verified.token);
  assert(session.expiresAt > time);
  assert.strictEqual(await auth.verifyCode('12345678', '000042'), null, 'OTP is single-use');

  const limited = createAdminAuth({
    env: { TELEGRAM_ADMIN_IDS: '12345678' }, now: () => time,
    telegram: { getChatAdminIds: async () => ['12345678'], sendPrivate: async () => false },
  });
  assert.deepStrictEqual(await limited.requestCode('12345678'), { ok: false, error: 'Telegram mesajı gönderilemedi. Botla özel sohbeti başlatıp tekrar deneyin.' });

  time += 8 * 60 * 60 * 1000 + 1;
  assert.strictEqual(auth.getSession({ headers: { cookie: 'scalp_admin_session=' + verified.token } }), null, 'expired sessions must be rejected');
  console.log('PASS: Telegram OTP allowlist, cooldown, single-use code, session expiry');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
