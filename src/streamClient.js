'use strict';

/**
 * Binance USDⓈ-M combined stream istemcisi (kline)
 *
 * Neden kütüphanenin WebsocketClient'ı değil:
 *   'binance' npm her subscribeKlines() çağrısı için AYRI bir WebSocket açıyor.
 *   Tüm market (≈500+ sembol × 4 TF) = 2000+ bağlantı → Binance limitini aşar, IP banlanabilir.
 *   Burada bağlantı başına en fazla 800 stream (Binance limiti 1024) → tüm market 2–3 bağlantı.
 *
 * Özellikler:
 *   • wss://fstream.binance.com/market/stream + SUBSCRIBE mesajları (2026-04-23 URL ayrımı sonrası doğru adres)
 *   • Binance'in 3 dakikalık ping'ine 'ws' kütüphanesi otomatik pong döner; 24 saatlik kopuş otomatik yeniden bağlanır
 *   • Watchdog: bir bağlantıdan staleMs boyunca HİÇ mesaj gelmezse bağlantı kopartılıp yeniden kurulur
 *     (eski /ws adresindeki gibi "bağlı ama veri yok" durumunu yakalar)
 *   • Yeniden bağlanınca onGap(symbols, downSince) çağrılır → kaçan mumlar REST ile doldurulabilir
 *   • Üstel geri çekilme (1 sn → 30 sn), bağlantılar kademeli açılır
 */

const WebSocket = require('ws');

const DEFAULTS = {
  url:                  process.env.BINANCE_WS_MARKET_URL || 'wss://fstream.binance.com/market/stream',
  streamsPerConnection: 800,     // Binance: bağlantı başına en fazla 1024 stream
  paramsPerMessage:     200,     // tek SUBSCRIBE mesajındaki stream sayısı
  subscribeGapMs:       250,     // SUBSCRIBE mesajları arası (Binance: en fazla 10 mesaj/sn)
  connectStaggerMs:     500,     // bağlantıları aynı anda açma
  staleMs:              60_000,  // bu kadar süre mesaj yoksa bağlantı ölü sayılır
  watchdogEveryMs:      10_000,
  minBackoffMs:         1_000,
  maxBackoffMs:         30_000,
  finalOnly:            false,   // true: kapanmamış mum güncellemeleri JSON'a çevrilmeden atlanır (CPU)
};

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * @param {object}   p
 * @param {string[]} p.symbols
 * @param {string[]} p.timeframes          ['5m','15m','1h','4h']
 * @param {function} p.onKline             (symbol, tf, kline, isFinal) — kline: {startTime, open, high, low, close, volume, final, interval}
 * @param {function} [p.onGap]             (symbols[], downSince) — yeniden bağlanınca
 * @param {object}   [p.options]
 *
 * setSymbols(list) ile sembol listesi çalışırken değiştirilebilir (SUBSCRIBE / UNSUBSCRIBE; bağlantı kopmaz).
 */
function createStreamClient({ symbols, timeframes, onKline, onGap = () => {}, options = {}, logger = console }) {
  const opt = { ...DEFAULTS, ...options };
  const streamsOf = list => list.flatMap(s => timeframes.map(tf => `${s.toLowerCase()}@kline_${tf}`));
  const symOf = st => st.split('@')[0].toUpperCase();
  let streams = streamsOf(symbols);

  const newConn = (list, id) => ({
    id,
    streams:     list,
    symbols:     [...new Set(list.map(symOf))],
    ws:          null,
    state:       'idle',          // idle | connecting | open | closed
    lastMsgAt:   0,
    downSince:   null,
    backoffMs:   opt.minBackoffMs,
    reconnects:  0,
    subAcks:     0,
    timers:      [],
    outbox:      [],              // gönderilecek SUBSCRIBE/UNSUBSCRIBE mesajları (10 msj/sn sınırı)
    sending:     false,
  });
  const conns = chunk(streams, opt.streamsPerConnection).map((list, i) => newConn(list, i + 1));

  const counters = { messages: 0, finals: {}, parseErrors: 0, skipped: 0 };
  let stopped = false;
  let watchdog = null;

  // İlk veri geldiyse bağlantı sağlıklı → geri çekilmeyi sıfırla, boşluk varsa bildir
  function checkGap(conn) {
    if (conn.downSince == null) return;
    const since = conn.downSince;
    conn.downSince = null;
    conn.backoffMs = opt.minBackoffMs;
    try {
      const r = onGap(conn.symbols, since);
      if (r && typeof r.catch === 'function') r.catch(e => logger.error(`[WS#${conn.id}] onGap hatası:`, e?.message || e));
    } catch (e) { logger.error(`[WS#${conn.id}] onGap hatası:`, e.message); }
  }

  const FINAL_MARK = Buffer.from('"x":true');
  const KLINE_MARK = Buffer.from('"e":"kline"');

  function handleMessage(conn, raw) {
    conn.lastMsgAt = Date.now();
    // Kapanmamış mum güncellemesi → ayrıştırmadan atla (tüm markette saniyede yüzlerce mesaj)
    // (ws@7 metin çerçevelerini string, ws@8 Buffer olarak verir — ikisi de desteklenir)
    if (opt.finalOnly && (typeof raw === 'string'
      ? raw.includes('"e":"kline"') && !raw.includes('"x":true')
      : Buffer.isBuffer(raw) && raw.includes(KLINE_MARK) && !raw.includes(FINAL_MARK))) {
      counters.skipped++;
      checkGap(conn);          // veri geri geldi → boşluk bildirimi (kapanış beklenmeden)
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { counters.parseErrors++; return; }

    if (msg.id != null && 'result' in msg) { conn.subAcks++; return; }   // SUBSCRIBE onayı
    if (msg.error) { logger.error(`[WS#${conn.id}] Sunucu hatası:`, JSON.stringify(msg.error)); return; }

    const d = msg.data;
    if (!d || d.e !== 'kline' || !d.k) return;
    counters.messages++;

    const k = d.k;
    const kline = {
      startTime: k.t,
      open:      +k.o,
      high:      +k.h,
      low:       +k.l,
      close:     +k.c,
      volume:    +k.v,
      quoteVolume:   +k.q,
      takerBuyBase:  +k.V,
      takerBuyQuote: +k.Q,
      final:     k.x === true,
      interval:  k.i,
    };
    if (kline.final) counters.finals[k.i] = (counters.finals[k.i] || 0) + 1;

    checkGap(conn);

    try { onKline(d.s, k.i, kline, kline.final); }
    catch (e) { logger.error(`[WS#${conn.id}] onKline hatası (${d.s} ${k.i}):`, e.message); }
  }

  /**
   * Mesajları sırayla gönderir. Her mesaj bir öncekinin GERÇEKTEN gönderilmesinden subscribeGapMs
   * sonra zamanlanır — tüm zamanlayıcıları baştan kurmak, event loop meşgulken geciken
   * zamanlayıcıların üst üste ateşlenmesine (10 mesaj/sn limitinin aşılmasına) yol açıyordu.
   */
  function drain(conn) {
    if (conn.sending) return;
    const ws = conn.ws;
    const sendNext = () => {
      if (!conn.outbox.length || conn.ws !== ws || !ws || ws.readyState !== WebSocket.OPEN) { conn.sending = false; return; }
      conn.sending = true;
      const m = conn.outbox.shift();
      ws.send(JSON.stringify({ method: m.method, params: m.params, id: conn.id * 100000 + (++msgSeq % 100000) }));
      conn.timers.push(setTimeout(sendNext, opt.subscribeGapMs));
    };
    sendNext();
  }
  let msgSeq = 0;

  function queueMsg(conn, method, list) {
    for (const b of chunk(list, opt.paramsPerMessage)) conn.outbox.push({ method, params: b });
    if (conn.state === 'open') drain(conn);
  }

  function subscribe(conn) {
    conn.outbox = [];
    conn.sending = false;
    queueMsg(conn, 'SUBSCRIBE', conn.streams);
  }

  function connect(conn) {
    if (stopped) return;
    conn.state = 'connecting';
    const ws = new WebSocket(opt.url);
    conn.ws = ws;

    ws.on('open', () => {
      conn.state     = 'open';
      conn.lastMsgAt = Date.now();          // watchdog sayacı bağlantı anından başlar
      conn.subAcks   = 0;
      logger.log(`[WS#${conn.id}] Bağlandı — ${conn.streams.length} stream abone ediliyor`);
      subscribe(conn);
    });

    ws.on('message', raw => handleMessage(conn, raw));

    ws.on('error', err => {
      logger.error(`[WS#${conn.id}] Hata: ${err.message}`);
    });

    ws.on('close', (code) => {
      conn.timers.forEach(clearTimeout);
      conn.timers = [];
      conn.sending = false;
      if (conn.ws !== ws) return;            // eski sokete ait gecikmiş olay
      conn.state = 'closed';
      if (conn.downSince == null) conn.downSince = Date.now();
      if (stopped) return;
      const delay = conn.backoffMs;
      conn.backoffMs = Math.min(conn.backoffMs * 2, opt.maxBackoffMs);
      conn.reconnects++;
      logger.warn(`[WS#${conn.id}] Bağlantı kapandı (kod ${code}) — ${Math.round(delay / 1000)} sn sonra yeniden bağlanılacak`);
      conn.timers.push(setTimeout(() => connect(conn), delay));
    });
  }

  function checkStale() {
    const now = Date.now();
    for (const conn of conns) {
      if (conn.state === 'open' && now - conn.lastMsgAt > opt.staleMs) {
        logger.warn(`[WS#${conn.id}] ${Math.round((now - conn.lastMsgAt) / 1000)} sn'dir veri yok — bağlantı yenileniyor`);
        conn.downSince = conn.downSince ?? conn.lastMsgAt;
        conn.ws.terminate();                 // 'close' olayı yeniden bağlanmayı tetikler
      }
    }
  }

  /** Çalışırken sembol listesini değiştir. @returns {{added:string[], removed:string[]}} */
  function setSymbols(list) {
    const want = new Set(streamsOf(list));
    const have = new Set(conns.flatMap(c => c.streams));
    const removed = [...have].filter(st => !want.has(st));
    const added = [...want].filter(st => !have.has(st));
    for (const c of conns) {
      const rm = c.streams.filter(st => !want.has(st));
      if (!rm.length) continue;
      c.streams = c.streams.filter(st => want.has(st));
      c.symbols = [...new Set(c.streams.map(symOf))];
      if (c.state === 'open') queueMsg(c, 'UNSUBSCRIBE', rm);
    }
    let rest = added;
    for (const c of conns) {
      if (!rest.length) break;
      const room = opt.streamsPerConnection - c.streams.length;
      if (room <= 0) continue;
      const take = rest.slice(0, room);
      rest = rest.slice(room);
      c.streams.push(...take);
      c.symbols = [...new Set(c.streams.map(symOf))];
      if (c.state === 'open') queueMsg(c, 'SUBSCRIBE', take);
    }
    for (const list2 of chunk(rest, opt.streamsPerConnection)) {
      const c = newConn(list2, conns.length + 1);
      conns.push(c);
      if (!stopped && watchdog) connect(c);
    }
    streams = conns.flatMap(c => c.streams);
    return { added: [...new Set(added.map(symOf))], removed: [...new Set(removed.map(symOf))] };
  }

  return {
    setSymbols,

    start() {
      stopped = false;
      conns.forEach((c, i) => setTimeout(() => connect(c), i * opt.connectStaggerMs));
      watchdog = setInterval(checkStale, opt.watchdogEveryMs);
      logger.log(`[WS] ${symbols.length} sembol × ${timeframes.length} TF = ${streams.length} stream → ${conns.length} bağlantı`);
    },

    stop() {
      stopped = true;
      clearInterval(watchdog);
      for (const c of conns) {
        c.timers.forEach(clearTimeout);
        c.timers = [];
        if (c.ws) { c.ws.removeAllListeners('close'); c.ws.terminate(); }
        c.state = 'closed';
      }
    },

    /** Heartbeat için: sayaçları döndürür ve sıfırlar */
    takeStats() {
      const s = {
        connections: conns.length,
        open:        conns.filter(c => c.state === 'open').length,
        streams:     streams.length,
        messages:    counters.messages,
        skipped:     counters.skipped,
        finals:      { ...counters.finals },
        reconnects:  conns.reduce((n, c) => n + c.reconnects, 0),
        parseErrors: counters.parseErrors,
      };
      counters.messages = 0;
      counters.skipped = 0;
      counters.finals = {};
      counters.parseErrors = 0;
      for (const c of conns) c.reconnects = 0;
      return s;
    },
  };
}

module.exports = { createStreamClient };
