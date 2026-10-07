'use strict';

/**
 * İstatistik için Binance'ten ek veri — kartı ETKİLEMEZ.
 *
 *   Baz         : premiumIndex'ten (zaten 5 dk'da bir çekiliyor, ek istek yok) mark − endeks farkı %
 *   enrich()    : tepe adayı başına (zaman uyumsuz, kayda sonradan eklenir):
 *                 · açık pozisyon (5m geçmişi, 13 nokta): 15 dk / 60 dk değişim %, USDT değeri
 *                 · en büyük trader'lar long/short (hesap ve pozisyon), tüm hesaplar long/short, taker alış/satış oranı (5m)
 *                 · emir defteri (100 seviye, tepe ANINDA — geçmişi yok): fiyatın %1 / %2 yakınındaki alış payı (0–1) ve USDT
 *                 Diğerleri adayın sonucu belli olunca (≤ 15 dk) tepe anına hizalı (endTime) çekilir.
 *                 · spot: aynı coinin spot fiyatına göre perp primi % ve son 60 dk spot hacminin toplam içindeki payı
 *                 REST kuyruğu 15 sn'den doluysa atlanır (kart / tohumlama işleri öncelikli). Spot olmayan coin hatırlanır.
 *   Likidasyon  : tek WebSocket akışı (!forceOrder@arr, tüm piyasa) — coin başına son 60 dk; BUY = short likidasyonu
 *                 (zorla alım), SELL = long likidasyonu. liq() → 15/60 dk short/long USDT.
 */

const WebSocket = require('ws');
const MIN = 60_000;
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

function basisPct(prem) {
  return prem && prem.mark > 0 && prem.index > 0 ? num((prem.mark - prem.index) / prem.index * 100, 4) : null;
}

/** Futures sembolü → spot sembolü ve fiyat çarpanı (1000PEPEUSDT → PEPEUSDT × 1000) */
function spotOf(sym) {
  const m = /^(1000000|1000|1M)(.+USDT)$/.exec(sym);
  if (!m) return { spot: sym, mult: 1 };
  return { spot: m[2], mult: m[1] === '1000' ? 1000 : 1e6 };
}

const ENRICH_COLS = ['oiChg15', 'oiChg60', 'oiUsd', 'lsTopAcc', 'lsTopPos', 'lsGlobal', 'takerLS', 'obBid1', 'obBid2', 'obAsk1Usd', 'obBid1Usd', 'spotPrem', 'spotShare60'];
const LIQ_COLS = ['liqShort15', 'liqLong15', 'liqShort60', 'liqLong60', 'liqShortPct15'];

/**
 * @param {object} o { client: binanceClient modülü, spotBase, fetchFn, maxBacklogMs, logger }
 */
function createEnricher({ client, spotBase = process.env.BINANCE_SPOT_BASE_URL || 'https://api.binance.com', fetchFn = globalThis.fetch, maxBacklogMs = 15_000, logger = console } = {}) {
  const noSpot = new Set();
  let spotNext = 0;
  const stats = { ok: 0, skipped: 0, errors: 0 };
  const rc = client.restClient;
  const safe = async (p) => { try { return await p; } catch { stats.errors++; return null; } };
  const last = rows => (Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null);

  async function spot(sym, futQ60, futPrice, t) {
    const { spot: ss, mult } = spotOf(sym);
    if (noSpot.has(ss) || !fetchFn) return {};
    const wait = spotNext - Date.now(); spotNext = Math.max(Date.now(), spotNext) + 120;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const res = await fetchFn(`${spotBase}/api/v3/klines?symbol=${ss}&interval=1m&limit=60${t ? `&endTime=${t - 1}` : ''}`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 400) { noSpot.add(ss); return {}; }
      if (!res.ok) return {};
      const k = await res.json();
      if (!Array.isArray(k) || !k.length) return {};
      const sq = k.reduce((a, r) => a + parseFloat(r[7] || 0), 0);
      const sp = parseFloat(k[k.length - 1][4]) * mult;
      return {
        spotPrem: sp > 0 && futPrice > 0 ? num((futPrice - sp) / sp * 100, 3) : null,
        spotShare60: sq + futQ60 > 0 ? num(sq / (sq + futQ60), 3) : null,
      };
    } catch { return {}; }
  }

  /**
   * @param {string} sym  @param {object} ctx { price, futQ60 }
   * @returns {Promise<object|null>} ENRICH_COLS alanları (null = atlandı)
   */
  /** Emir defteri (100 seviye) — tepe anında çağrılır (geçmişi yok) */
  async function orderBook(sym) {
    if (client.restBacklogMs && client.restBacklogMs() > maxBacklogMs) { stats.skipped++; return null; }
    const ob = await safe(client.call(5, `depth ${sym}`, () => rc.getOrderBook({ symbol: sym, limit: 100 })));
    if (!(ob && Array.isArray(ob.bids) && Array.isArray(ob.asks) && ob.bids.length && ob.asks.length)) return null;
    const bb = parseFloat(ob.bids[0][0]), ba = parseFloat(ob.asks[0][0]), mid = (bb + ba) / 2;
    const side = (rows, lo, hi) => rows.reduce((a, [p, q]) => { const x = parseFloat(p); return x >= lo && x <= hi ? a + x * parseFloat(q) : a; }, 0);
    const b1 = side(ob.bids, mid * 0.99, mid), a1 = side(ob.asks, mid, mid * 1.01);
    const b2 = side(ob.bids, mid * 0.98, mid), a2 = side(ob.asks, mid, mid * 1.02);
    return { obBid1: b1 + a1 > 0 ? num(b1 / (b1 + a1), 3) : null, obBid2: b2 + a2 > 0 ? num(b2 / (b2 + a2), 3) : null, obAsk1Usd: num(a1, 0), obBid1Usd: num(b1, 0) };
  }

  /** Tepe anına (t) hizalı: 5m geçmişlerin t'ye kadarki son noktası (aday ≤ 15 dk sonra kaydedildiği için) */
  async function enrich(sym, { t = Date.now(), price, futQ60 } = {}) {
    if (client.restBacklogMs && client.restBacklogMs() > maxBacklogMs) { stats.skipped++; return null; }
    const P = { symbol: sym, period: '5m', endTime: t };
    const [oi, ta, tp, gl, tk] = await Promise.all([
      safe(client.call(1, `oiHist ${sym}`, () => rc.getOpenInterestStatistics({ ...P, limit: 13 }))),
      safe(client.call(1, `topAcc ${sym}`, () => rc.getTopTradersLongShortAccountRatio({ ...P, limit: 1 }))),
      safe(client.call(1, `topPos ${sym}`, () => rc.getTopTradersLongShortPositionRatio({ ...P, limit: 1 }))),
      safe(client.call(1, `globalLS ${sym}`, () => rc.getGlobalLongShortAccountRatio({ ...P, limit: 1 }))),
      safe(client.call(1, `takerLS ${sym}`, () => rc.getTakerBuySellVolume({ ...P, limit: 1 }))),
    ]);
    const out = Object.fromEntries(ENRICH_COLS.filter(k => !k.startsWith('ob')).map(k => [k, null]));
    if (Array.isArray(oi) && oi.length >= 4) {
      const v = oi.map(r => parseFloat(r.sumOpenInterest));
      const n = v.length;
      out.oiChg15 = v[n - 4] > 0 ? num((v[n - 1] / v[n - 4] - 1) * 100) : null;
      out.oiChg60 = v[0] > 0 ? num((v[n - 1] / v[0] - 1) * 100) : null;
      out.oiUsd = num(parseFloat(oi[n - 1].sumOpenInterestValue), 0);
    }
    out.lsTopAcc = num(parseFloat(last(ta)?.longShortRatio), 3);
    out.lsTopPos = num(parseFloat(last(tp)?.longShortRatio), 3);
    out.lsGlobal = num(parseFloat(last(gl)?.longShortRatio), 3);
    out.takerLS = num(parseFloat(last(tk)?.buySellRatio), 3);
    Object.assign(out, await spot(sym, futQ60 || 0, price, t));
    stats.ok++;
    return out;
  }
  return { enrich, orderBook, stats };
}

/** Tüm piyasa likidasyon akışı */
function createLiqStream({ url = `${(process.env.BINANCE_WS_MARKET_URL || 'wss://fstream.binance.com/market/stream')}?streams=!forceOrder@arr`, logger = console } = {}) {
  const bySym = new Map();   // sym → [{t, short, usd}]
  let ws = null, stopped = false, backoff = 1000, timer = null;
  const counters = { messages: 0, reconnects: 0 };

  function onMsg(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const o = (m.data || m).o;
    if (!o || !o.s) return;
    counters.messages++;
    const px = parseFloat(o.ap) || parseFloat(o.p), q = parseFloat(o.z) || parseFloat(o.q);
    if (!(px > 0 && q > 0)) return;
    const a = bySym.get(o.s) || [];
    a.push({ t: Number(o.T) || Date.now(), short: o.S === 'BUY', usd: px * q });
    const cut = Date.now() - 61 * MIN;
    while (a.length && a[0].t < cut) a.shift();
    bySym.set(o.s, a);
  }
  function connect() {
    if (stopped) return;
    try { ws = new WebSocket(url); } catch (err) { logger.warn(`[LİKİDASYON] bağlanamadı: ${err.message}`); schedule(); return; }
    ws.on('open', () => { backoff = 1000; });
    ws.on('message', d => onMsg(d.toString()));
    ws.on('error', err => logger.warn(`[LİKİDASYON] ${err.message}`));
    ws.on('close', () => { ws = null; if (!stopped) { counters.reconnects++; schedule(); } });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(connect, backoff); backoff = Math.min(60_000, backoff * 2); }

  return {
    start() { stopped = false; connect(); return this; },
    stop() { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* yok */ } },
    /** @returns LIQ_COLS (USDT) — futQ15: aynı 15 dk'nın futures hacmi (oran için) */
    liq(sym, now = Date.now(), futQ15 = null) {
      const a = bySym.get(sym) || [];
      const s = (min, short) => a.reduce((x, e) => (e.t >= now - min * MIN && e.t <= now && e.short === short ? x + e.usd : x), 0);
      const s15 = s(15, true);
      return { liqShort15: num(s15, 0), liqLong15: num(s(15, false), 0), liqShort60: num(s(60, true), 0), liqLong60: num(s(60, false), 0),
        liqShortPct15: futQ15 > 0 ? num(s15 / futQ15 * 100, 3) : null };
    },
    _onMsg: onMsg,
    stats: () => ({ ...counters, symbols: bySym.size }),
  };
}

module.exports = { basisPct, spotOf, createEnricher, createLiqStream, ENRICH_COLS, LIQ_COLS };
