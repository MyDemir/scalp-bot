'use strict';
// Telegram gönderim kuyruğunun sert sınırı (429 yeniden denemesi dahil), yanıt önceliği ve
// istatistik okumalarının (getStats) sayaçları sıfırlamaması. Ağ yok: sahte Telegram sunucusu.

const assert = require('assert');
const http = require('http');

const PORT = 18411;
const LIMIT = 5;
Object.assign(process.env, {
  TELEGRAM_API_BASE: `http://127.0.0.1:${PORT}`,
  TELEGRAM_BOT_TOKEN: 'TEST:TOKEN',
  TELEGRAM_CHAT_ID: '-1001234567890',
  TELEGRAM_MAX_QUEUE_LEN: String(LIMIT),
});
const cfg = require('../src/config');
cfg.telegramMinIntervalMs = 0;
const telegram = require('../src/telegram');
const { createStreamClient } = require('../src/streamClient');
const { queue, enqueue } = telegram._internal;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let calls = 0;
let hold = null;     // ilk istek bu söz çözülene kadar bekletilir, sonra 429 döner
const sent = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    calls++;
    const msg = JSON.parse(body || '{}');
    if (calls === 1) {
      await hold;
      res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }));
      return;
    }
    sent.push(msg.text);
    res.end(JSON.stringify({ ok: true, result: { message_id: calls } }));
  });
});

async function main() {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const origWarn = console.warn; console.warn = () => {};
  let maxSeen = 0;
  const watch = setInterval(() => { maxSeen = Math.max(maxSeen, queue.length); }, 1);
  try {
    assert.strictEqual(telegram._internal.MAX_QUEUE_LEN, LIMIT);
    let release;
    hold = new Promise(r => { release = r; });

    // 1) İlk kart gönderimdeyken kuyruk dolar; 429 sonrası geri koyma sınırı aşmamalı.
    enqueue('card', '-1', 'card-0');
    await sleep(30);
    assert.strictEqual(queue.length, 0, 'first card is in flight');
    for (let i = 1; i <= 7; i++) enqueue('card', '-1', `card-${i}`);
    assert.strictEqual(queue.length, LIMIT, 'enqueue respects the hard cap');
    maxSeen = Math.max(maxSeen, queue.length);
    release();
    await sleep(30);
    assert(queue.length <= LIMIT, `429 requeue keeps the hard cap (length ${queue.length})`);
    assert(await telegram.flush(5000), 'queue drains');
    assert(maxSeen <= LIMIT, `queue never exceeded ${LIMIT} (max seen ${maxSeen})`);
    const st = telegram.getStats();
    assert.strictEqual(st.sent + st.droppedOverflow, 8, 'every message is either sent or counted as dropped');
    assert.strictEqual(st.retried429, 1);
    assert.strictEqual(st.droppedOverflow, 8 - LIMIT, 'overflow drops are counted');

    // 2) Okuma sayaçları sıfırlamaz; takeStats (heartbeat) sıfırlar.
    assert.deepStrictEqual(telegram.getStats(), st, 'getStats is read-only');
    const taken = telegram.takeStats();
    assert.strictEqual(taken.sent, st.sent);
    assert.strictEqual(telegram.getStats().sent, 0, 'takeStats resets counters');

    // 3) Yalnızca yanıtlarla dolu kuyrukta yeni kart düşer; yeni yanıt en eski yanıt yerine girer.
    hold = new Promise(() => {}); calls = 0;            // pompa ilk istekte takılı kalsın
    enqueue('reply', '-1', 'reply-0');
    await sleep(30);
    for (let i = 1; i <= LIMIT; i++) enqueue('reply', '-1', `reply-${i}`);
    assert.strictEqual(enqueue('card', '-1', 'late-card'), false, 'card is dropped when queue holds only replies');
    assert.strictEqual(queue.length, LIMIT);
    assert(queue.every(q => q.kind === 'reply'));
    enqueue('reply', '-1', 'reply-new');
    assert.strictEqual(queue.length, LIMIT, 'reply overflow also keeps the cap');
    assert(queue.some(q => q.text === 'reply-new'), 'newest reply kept');

    // 4) WebSocket istemci metrikleri de salt okunur.
    const stream = createStreamClient({ symbols: ['BTCUSDT'], timeframes: ['1m'], onKline: () => {} });
    assert.deepStrictEqual(stream.getStats(), stream.getStats(), 'stream getStats is read-only');

    console.log(`PASS: Telegram hard queue cap ${LIMIT} incl. 429 requeue (max seen ${maxSeen}), reply priority, read-only stats`);
  } finally {
    clearInterval(watch);
    console.warn = origWarn;
    srv.close();
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
