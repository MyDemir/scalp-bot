'use strict';
/**
 * WebSocket birikme koruması: stream'ler birkaç bağlantıya bölünür; bir bağlantının mesajları
 * Binance olay zamanından (E) çok geriden geliyorsa bağlantı yenilenir ve geride kalan aralık onGap ile dolar.
 */
const assert = require('assert');
const WebSocketServer = require('ws').Server;
const { createStreamClient } = require('../src/streamClient');

const PORT = 18531;
const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(20); }
  throw new Error(`zaman aşımı: ${label}`);
}

(async () => {
  const wss = new WebSocketServer({ port: PORT });
  const conns = [];
  let lagBy = 0;
  wss.on('connection', ws => {
    const c = { ws, streams: [] };
    conns.push(c);
    ws.on('message', m => {
      const msg = JSON.parse(m);
      if (msg.method === 'SUBSCRIBE') c.streams.push(...msg.params);
      ws.send(JSON.stringify({ result: null, id: msg.id }));
    });
    ws.on('close', () => conns.splice(conns.indexOf(c), 1));
  });
  const push = (c, final) => {
    for (const st of c.streams) {
      const s = st.split('@')[0].toUpperCase(), t = Math.floor(Date.now() / 60000) * 60000 - 60000;
      c.ws.send(JSON.stringify({ stream: st, data: { e: 'kline', E: Date.now() - lagBy, s, k: { t, i: '1m', o: '1', h: '1', l: '1', c: '1', v: '1', q: '1', V: '0', Q: '0', x: final } } }));
    }
  };

  const symbols = Array.from({ length: 7 }, (_, i) => `C${i}USDT`);
  const gaps = [], klines = [];
  const client = createStreamClient({
    symbols, timeframes: ['1m'], logger: quiet,
    onKline: (s, tf, k) => klines.push(k),
    onGap: (syms, since) => gaps.push({ syms, since }),
    options: { url: `ws://127.0.0.1:${PORT}/market/stream`, streamsPerConnection: 3, subscribeGapMs: 5, connectStaggerMs: 10,
      watchdogEveryMs: 50, lagReconnectMs: 2_000, lagReconnectGapMs: 60_000, finalOnly: true },
  });
  try {
    client.start();
    await waitFor(() => conns.length === 3 && conns.reduce((n, c) => n + c.streams.length, 0) === 7, 3000, '3 bağlantı, 7 stream');
    assert.deepStrictEqual(conns.map(c => c.streams.length).sort(), [1, 3, 3], 'bağlantı başına en fazla 3 stream');

    for (const c of conns) push(c, true);
    await waitFor(() => klines.length === 7, 2000, 'ilk mumlar');
    assert.strictEqual(client.getStats().reconnects, 0);

    // Bir bağlantı 5 sn geriden gelmeye başlar → yenilenir, diğerleri dokunulmaz
    const slow = conns.find(c => c.streams.length === 3), slowWs = slow.ws, slowSyms = slow.streams.map(s => s.split('@')[0].toUpperCase()).sort();
    lagBy = 5_000;
    for (let i = 0; i < 3; i++) push(slow, true);
    lagBy = 0;
    await waitFor(() => slowWs.readyState === 3, 2000, 'yavaş bağlantı kapandı');
    let st = client.getStats();
    assert.strictEqual(st.lagReconnects, 1, 'birikme koruması bir kez');
    assert(st.perConn.some(c => c.lagMaxMs >= 5_000), 'bağlantı başı en fazla gecikme raporlanır');
    await waitFor(() => conns.length === 3 && conns.reduce((n, c) => n + c.streams.length, 0) === 7, 4000, 'yeniden bağlandı');
    for (const c of conns) push(c, false);           // ilk veri → onGap
    await waitFor(() => gaps.length === 1, 2000, 'onGap');
    assert.deepStrictEqual(gaps[0].syms.slice().sort(), slowSyms, 'yalnız yenilenen bağlantının coinleri doldurulur');
    assert(Date.now() - gaps[0].since >= 4_000, 'doldurma geride kalan aralığın başından');

    // Pencere sıfırlanır; aynı bağlantı tekrar geride kalsa da lagReconnectGapMs dolmadan yenilenmez
    client.takeStats();
    const again = conns.find(c => c.streams.length === 3 && slowSyms.includes(c.streams[0].split('@')[0].toUpperCase()));
    lagBy = 5_000;
    for (let i = 0; i < 3; i++) push(again, true);
    lagBy = 0;
    await sleep(300);
    st = client.getStats();
    assert.strictEqual(st.lagReconnects, 0, 'kısa sürede ikinci yenileme yok');
    assert.strictEqual(again.ws.readyState, 1);
    console.log('✅ Stream\'ler bağlantılara bölünür; geride kalan bağlantı yenilenir, kaçan aralık REST\'e bırakılır, aynı bağlantı 10 dk\'da bir kez');
  } finally {
    client.stop();
    wss.close();
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
