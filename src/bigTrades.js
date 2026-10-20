'use strict';

/**
 * Spot büyük alım / satım sayacı — kartı ETKİLEMEZ, yalnız /akis, panel ve CSV (src/spotFlow.js'e yazar).
 *
 *   Kaynak : Binance spot birleşik akış (<sembol>@aggTrade). Bir aggTrade = tek taker emrin aynı fiyattaki dolumu;
 *            m = true → alıcı maker → taker SATIŞ, m = false → taker ALIŞ. Tutar = fiyat × miktar ($).
 *   Eşik   : coin başına getThreshold(futuresSembol) — spotFlow.bigThreshold: max(flowBigMinUsd, günlük spot hacmi × flowBigPct %).
 *            Eşik kayıt anında uygulanır; değiştirmek geçmiş sayıları değiştirmez.
 *   Kayıt  : coin + saat başına sayaç (alış adedi / $, satış adedi / $); dakikada bir flow.db'ye eklenir (flow_big).
 *            4s / günlük / haftalık / aylık toplamlar okunurken saatlerden toplanır.
 *   Geçmiş : akış canlıdır; sayım botun açıldığı andan başlar (Binance geçmiş büyük işlem listesi vermez).
 *            Kopuşta kaçan süre sayılmaz (yeniden bağlanınca devam eder).
 */

const WebSocket = require('ws');
const HOUR = 3_600_000;

/**
 * @param {object} o
 * @param {Function} o.getPairs      () → [[spotSymbol, futuresSymbol], …] (akış evreni)
 * @param {Function} o.getThreshold  (futuresSembol) → $ eşik
 * @param {Function} o.record        (rows) → kayıt [{symbol, t, buyN, buyUsd, sellN, sellUsd}]
 */
function createBigTrades({
  getPairs, getThreshold = () => 50_000, record,
  url = process.env.BINANCE_SPOT_WS_URL || 'wss://stream.binance.com:9443/stream',
  paramsPerMessage = 200, subscribeGapMs = 300, staleMs = 90_000, flushMs = 60_000,
  now = () => Date.now(), logger = console, WS = WebSocket,
} = {}) {
  const pending = new Map();            // `${futSym}|${hour}` → sayaç
  let toFut = new Map(getPairs() || []);   // spot → futures (start / refresh ile güncellenir)
  let subscribed = [];
  let ws = null, stopped = true, backoff = 1000, lastMsg = 0, reconnectTimer = null, watchdog = null, flusher = null;
  const stats = { messages: 0, big: 0, reconnects: 0, flushed: 0 };

  function onTrade(d) {
    if (!d || d.e !== 'aggTrade') return;
    stats.messages++;
    const usd = parseFloat(d.p) * parseFloat(d.q);
    const fut = toFut.get(d.s);
    if (!fut || !(usd >= getThreshold(fut))) return;
    const t = Math.floor((Number(d.T) || now()) / HOUR) * HOUR;
    const k = `${fut}|${t}`;
    let c = pending.get(k);
    if (!c) { c = { symbol: fut, t, buyN: 0, buyUsd: 0, sellN: 0, sellUsd: 0 }; pending.set(k, c); }
    if (d.m) { c.sellN++; c.sellUsd += usd; } else { c.buyN++; c.buyUsd += usd; }
    stats.big++;
  }

  function flush() {
    if (!pending.size) return 0;
    const rows = [...pending.values()];
    pending.clear();
    try { record(rows); stats.flushed += rows.length; } catch (err) { logger.error(`[BÜYÜK İŞLEM] kayıt hatası: ${err?.message || err}`); }
    return rows.length;
  }

  const send = msg => { try { ws?.readyState === 1 && ws.send(JSON.stringify(msg)); } catch { /* kopuk */ } };

  async function subscribe(list, method = 'SUBSCRIBE') {
    for (let i = 0; i < list.length; i += paramsPerMessage) {
      send({ method, params: list.slice(i, i + paramsPerMessage).map(s => `${s.toLowerCase()}@aggTrade`), id: Date.now() % 1e9 + i });
      if (i + paramsPerMessage < list.length) await new Promise(r => setTimeout(r, subscribeGapMs));
    }
  }

  function connect() {
    if (stopped) return;
    try { ws = new WS(url); } catch (err) { logger.warn(`[BÜYÜK İŞLEM] bağlanamadı: ${err.message}`); schedule(); return; }
    ws.on('open', () => {
      backoff = 1000; lastMsg = now();
      subscribed = [...toFut.keys()];
      subscribe(subscribed).catch(() => {});
    });
    ws.on('message', raw => {
      lastMsg = now();
      let m; try { m = JSON.parse(raw); } catch { return; }
      onTrade(m.data || m);
    });
    ws.on('close', () => { ws = null; schedule(); });
    ws.on('error', err => { logger.warn(`[BÜYÜK İŞLEM] bağlantı hatası: ${err?.message || err}`); try { ws?.terminate(); } catch { /* yok */ } });
  }

  function schedule() {
    if (stopped || reconnectTimer) return;
    stats.reconnects++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  /** Evren değiştiyse abonelikleri güncelle (bağlantı kopmaz) */
  async function refresh() {
    const pairs = getPairs() || [];
    toFut = new Map(pairs);
    const want = [...toFut.keys()];
    if (!ws || ws.readyState !== 1) return { want: want.length };
    const have = new Set(subscribed), next = new Set(want);
    const add = want.filter(s => !have.has(s)), drop = subscribed.filter(s => !next.has(s));
    subscribed = want;
    if (drop.length) await subscribe(drop, 'UNSUBSCRIBE');
    if (add.length) await subscribe(add);
    return { want: want.length, add: add.length, drop: drop.length };
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    toFut = new Map(getPairs() || []);
    connect();
    watchdog = setInterval(() => {
      if (ws && ws.readyState === 1 && toFut.size && now() - lastMsg > staleMs) {
        logger.warn(`[BÜYÜK İŞLEM] ${Math.round(staleMs / 1000)} sn mesaj yok — yeniden bağlanılıyor`);
        try { ws.terminate(); } catch { /* yok */ }
      }
    }, 15_000);
    flusher = setInterval(flush, flushMs);
    for (const t of [watchdog, flusher]) t.unref?.();
  }

  function stop() {
    stopped = true;
    for (const t of [watchdog, flusher, reconnectTimer]) if (t) clearInterval(t);
    reconnectTimer = null;
    try { ws?.close(); } catch { /* yok */ }
    flush();
  }

  return { start, stop, refresh, flush, stats, _onTrade: onTrade, _pending: pending };
}

module.exports = { createBigTrades };
