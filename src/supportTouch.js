'use strict';

/**
 * Destek teması — src/levelTouch.js'in AYNASI: fiyat bir seviyeye ÜSTTEN değdiğinde olay açılır, sonraki 60 dk izlenir.
 * Kartı etkilemez; yalnız istatistik (cards.db `stouches`, destekler.csv). REST çağrısı yok.
 *
 *   Temas    : önceki 1m kapanış seviyenin %0.3'ten fazla ÜSTÜNDEYDİ, bu 1m mumun dibi seviyenin %0.3 yakınına geldi
 *              (ya da altına indi). Aynı seviye 60 dk içinde tekrar yazılmaz.
 *   Seviyeler: levelsOf (kartlardakiyle aynı: MA200/EMA200, 7/30 g en yüksek, günlük/haftalık bölge, trend çizgisi, 1h/4h tepe,
 *              Fib 0.236–0.786) + destek ekleri: 7/30 günlük dip, 4h/1h dip (swing), Günlük VWAP ve ±1/2/3σ bantları.
 *              lvTouches: levels.annotateTouches ile (4h mumlar ~100 gün; VWAP bandında o anki değer sabit kabul edilir).
 *   Ölçüm    : temastan sonra 5/15/30/60 dk — seviyeye göre en yüksek (upN), en düşük (dnN), kapanış (cN; 60 dk: up/dn/c60) ·
 *              rally (o ana kadarki dipten en yüksek tepki %) ve rallyMin · held (60. dk kapanış seviyenin üstünde) ·
 *              brokeMin (5m kapanış seviyenin %dipAbovePct altında; kırılım dk) · aboveMin (fiyat seviyenin altına indikten sonra
 *              1m kapanışın seviyenin üstüne döndüğü ilk dk; temas mumu altına iğne atıp üstünde kapandıysa 0; hiç altına inmediyse
 *              ya da dönmediyse boş) · wick0 (temas mumunun dibinden kapanışına tepki %)
 *   Temasta  : rsi3/rsi5/rsi15, emaGap (3m EMA21'e uzaklık %), funding, btc1h + orta boy fotoğraf (STOUCH_SNAP_COLS)
 *   Bağlam   : card (±5 dk kart), dip (±5 dk dip defteri adayı; opts.dipNear)
 *
 * Kazanç/kayıp hesabı YOK — yalnızca fiyatın seviyede ne yaptığı. Canlı ve backtest aynı kod; look-ahead yok.
 */

const ta = require('./ta');
const { levelsOf, rsiOf } = require('./infoEngine');
const { annotateTouches, swingHighs, roundPx } = require('./levels');
const { tfIndicators, vwapSet, vwapFeatures, TF_COLS, VWAP_COLS } = require('./marketSnap');
const { extraFeatures, quoteVol24h } = require('./peakFeatures');
const { basisPct, LIQ_COLS } = require('./marketData');

const MIN = 60_000, DAY = 86_400_000;
const TOUCH_PCT = 0.3;
const WINDOW = 60;
const NEAR = 5;            // ±5 dk kart / dip
const SNAPS = [5, 15, 30];

const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const pct = (x, v) => +((x - v) / v * 100).toFixed(3);

const EXTRA_PICK = ['bbB_5m', 'bbB_15m', 'bbB_1h', 'cvdNet15', 'cvdNet60', 'fromLow30', 'dayChg', 'breadth80', 'pumping', 'btc5', 'btc15'];
/** Temas anı orta boy fotoğrafı (kolon adları tepeler.csv ile aynı anlamda) */
const STOUCH_SNAP_COLS = [...TF_COLS, ...VWAP_COLS, ...LIQ_COLS, 'basisPct', ...EXTRA_PICK, 'breadth20', 'dumping', 'q24h'];
const STOUCH_HEAD_COLS = ['id', 'symbol', 'time', 'name', 'kind', 'value', 'lvTouches', 'card', 'dip', 'rsi3', 'rsi5', 'rsi15', 'emaGap', 'funding', 'btc1h',
  'wick0', 'aboveMin', 'brokeMin', 'held', 'rally', 'rallyMin', ...SNAPS.flatMap(w => [`up${w}`, `dn${w}`, `c${w}`]), 'up', 'dn', 'c60'];
const STOUCH_COLS = [...STOUCH_HEAD_COLS, ...STOUCH_SNAP_COLS];

/** Destek ekleri (levelsOf'ta olmayan): 7/30 günlük dip, 4h/1h dip — levelsOf önbelleğiyle aynı anahtarla saklanır */
function extraSupports(series, s, base) {
  const key = series._lv?.key;
  if (key != null && series._slv && series._slv.key === key) return series._slv.levels;
  const out = [];
  const add = (name, v, kind) => {
    if (!(Number.isFinite(v) && v > 0)) return;
    if ([...base, ...out].some(L => Math.abs(L.value - v) / L.value <= 0.003)) return;
    out.push({ name, value: roundPx(v), kind });
  };
  const dl = series.d['1d'].l;
  if (dl.length >= 20) add('30 günlük dip', Math.min(...dl.slice(-30)), 'low');
  if (dl.length >= 7) add('7 günlük dip', Math.min(...dl.slice(-7)), 'low');
  if (s.levelsSwing !== false) {
    const bars = s.swingBars || 3;
    for (const p of swingHighs(series.d['4h'].l.map(x => -x), bars, 180).reverse()) add('4h dip', -p.value, 'swing');
    for (const p of swingHighs(series.d['1h'].l.map(x => -x), bars, 200).reverse()) add('1h dip', -p.value, 'swing');
  }
  const h4 = series.d['4h'], d1 = series.d['1d'];
  annotateTouches(out, { h4: { h: h4.h, c: h4.c }, d1: { t: d1.t, h: d1.h, c: d1.c } });
  series._slv = { key, levels: out };
  return out;
}

/** Günlük VWAP ve ±1/2/3σ (yalnız 5m; vwapSet'in D'siyle aynı tanım) */
function dailyVwapLevels(series) {
  const t = series.col('5m', 't', true);
  if (!t.length) return [];
  const now = series.lastT('1m') ?? t[t.length - 1];
  const dayStart = Math.floor(now / DAY) * DAY;
  if (t[0] > dayStart) return [];
  let from = t.length; while (from > 0 && t[from - 1] >= dayStart) from--;
  if (from >= t.length) return [];
  const x = ta.vwapBands(series.col('5m', 'h', true), series.col('5m', 'l', true), series.col('5m', 'c', true), series.col('5m', 'v', true), from);
  if (!x || !(x.vwap > 0)) return [];
  const out = [{ name: 'Günlük VWAP', value: x.vwap, kind: 'vwap' }];
  if (x.sigma > 0) for (const m of [1, 2, 3]) { out.push({ name: `Günlük VWAP +${m}σ`, value: x.vwap + m * x.sigma, kind: 'vwap' }); out.push({ name: `Günlük VWAP −${m}σ`, value: x.vwap - m * x.sigma, kind: 'vwap' }); }
  return out.filter(L => L.value > 0);
}

function ema21of(series) {
  const e = ta.emaSeries(series.col('3m', 'c', false), 21);
  return e.length ? e[e.length - 1] : null;
}

/** Temas anı fotoğrafı (yalnız kapanmış 1m'e kadar olan veri) */
function snapshot(series, s, ctx, tClose, price) {
  const sym = series.symbol;
  const prem = ctx.funding ? ctx.funding(sym) : null;
  const d = series.d['1m'], n = d.q.length;
  let q15 = 0; for (let i = Math.max(0, n - 15); i < n; i++) q15 += d.q[i];
  const ex = extraFeatures(series, { s, ctx, price, t: tClose, funding: prem });
  const mk = ctx.market ? ctx.market(tClose) : null;
  const o = {
    // avwLow_pct (pompa dibi VWAP) temasta sabitleme noktası olmadığı için hep boş
    ...tfIndicators(series, s, price), ...vwapFeatures(vwapSet(series, null), price),
    ...(ctx.liq ? ctx.liq(sym, tClose, q15) : Object.fromEntries(LIQ_COLS.map(k => [k, null]))),
    basisPct: basisPct(prem),
    ...Object.fromEntries(EXTRA_PICK.map(k => [k, ex[k] ?? null])),
    breadth20: mk?.breadth20 ?? null, dumping: mk?.dumping ?? null, q24h: quoteVol24h(series),
    funding: prem ? num(prem.rate * 100, 4) : null,
    btc1h: ctx.btc1h ? num(ctx.btc1h(tClose)) : null,
  };
  return o;
}

/**
 * @param {object} o  { window, touchPct, dipNear(sym, t, winMin) → bool }
 */
function createSupportTouches({ window = WINDOW, touchPct = TOUCH_PCT, dipNear = null } = {}) {
  const open = new Map();       // sym → açık olaylar
  const cool = new Map();       // sym → Map(seviye anahtarı → bu zamana kadar yeni temas yok)
  const cardT = new Map();
  let openN = 0;

  function finish(e, c) {
    const v = e.value;
    const nearCard = (cardT.get(e.symbol) || []).some(t => Math.abs(t - e.t) <= NEAR * MIN);
    let dip = null;
    if (dipNear) { try { dip = Boolean(dipNear(e.symbol, e.t, NEAR)); } catch { dip = null; } }
    return {
      id: e.id, symbol: e.symbol, t: e.t, name: e.name, kind: e.kind, value: v, lvTouches: e.lvTouches ?? null,
      card: nearCard, dip,
      rsi3: e.rsi['3m'], rsi5: e.rsi['5m'], rsi15: e.rsi['15m'], emaGap: e.emaGap,
      wick0: e.wick0, aboveMin: e.aboveMin, brokeMin: e.brokeMin, held: c > v,
      rally: +e.rally.toFixed(3), rallyMin: e.rallyMin,
      ...Object.fromEntries(SNAPS.flatMap(w => ['up', 'dn', 'c'].map(k => [`${k}${w}`, e.snap?.[w]?.[k] ?? null]))),
      up: pct(e.hi, v), dn: pct(e.lo, v), c60: pct(c, v),
      ...e.feat,
    };
  }

  return {
    /** Kapanmış her 1m mumda (series.apply1m'den sonra). @returns {object[]} 60 dk'sı dolan temaslar */
    observe(series, closedTfs, s, ctx = {}) {
      const sym = series.symbol;
      const d = series.d['1m'];
      const i = d.c.length - 1;
      if (i < 1) return [];
      const h = d.h[i], l = d.l[i], c = d.c[i], tClose = d.t[i] + MIN;
      const done = [];

      const arr = open.get(sym);
      if (arr && arr.length) {
        const dn = (s.dipAbovePct ?? 0.3) / 100;
        const c5 = closedTfs && closedTfs.has('5m') ? series.d['5m'].c[series.d['5m'].c.length - 1] : null;
        for (let k = arr.length - 1; k >= 0; k--) {
          const e = arr[k];
          const m = Math.round((tClose - e.t) / MIN);
          if (l < e.trough) e.trough = l;
          const rr = (h - e.trough) / e.trough * 100;
          if (rr > e.rally) { e.rally = rr; e.rallyMin = m; }
          if (h > e.hi) e.hi = h;
          if (l < e.lo) e.lo = l;
          if (l < e.value) e.below = true;
          if (e.aboveMin == null && e.below && m <= window && c > e.value) e.aboveMin = m;
          if (e.brokeMin == null && c5 != null && c5 < e.value * (1 - dn)) e.brokeMin = m;
          for (const w of SNAPS) {
            if (m >= w && !(e.snap && e.snap[w])) (e.snap || (e.snap = {}))[w] = { up: pct(e.hi, e.value), dn: pct(e.lo, e.value), c: pct(c, e.value) };
          }
          if (m >= window) { done.push(finish(e, c)); arr.splice(k, 1); openN--; }
        }
        if (!arr.length) open.delete(sym);
      }

      // Yeni temaslar (üstten)
      if (d.t[i - 1] !== d.t[i] - MIN) return done;             // kopukluk: önceki kapanış yok
      const prev = d.c[i - 1];
      const base = levelsOf(series, s);
      const levels = [...base, ...extraSupports(series, s, base), ...dailyVwapLevels(series)];
      let cm = cool.get(sym);
      let rsi = null, ema = null, feat = null;
      for (const L of levels) {
        const thr = L.value * (1 + touchPct / 100);
        if (!(prev > thr && l <= thr)) continue;
        const key = L.kind === 'vwap' ? L.name : `${L.name}@${L.value}`;   // VWAP her dakika kayar: adla bekletilir
        if (cm && cm.get(key) > tClose) continue;
        if (!cm) { cm = new Map(); cool.set(sym, cm); }
        cm.set(key, tClose + window * MIN);
        if (!rsi) {
          rsi = {};
          for (const tf of ['3m', '5m', '15m']) { const v = rsiOf(series, tf, s.rsiPeriod).v; rsi[tf] = v != null ? +v.toFixed(1) : null; }
          ema = ema21of(series);
          feat = snapshot(series, s, ctx, tClose, c);
        }
        let lvTouches = L.touches;
        if (lvTouches == null) {   // VWAP bandı: o anki değer sabit kabul edilerek (4h ~100 gün)
          const one = [{ ...L }];
          annotateTouches(one, { h4: { h: series.d['4h'].h, c: series.d['4h'].c }, d1: { t: [], h: [], c: [] } });
          lvTouches = one[0].touches ?? null;
        }
        const below = l < L.value;
        const e = {
          id: `${sym}-${tClose}-S-${L.name}-${num(L.value, 8)}`, symbol: sym, t: tClose, name: L.name, kind: L.kind, value: L.value, lvTouches,
          rsi, emaGap: ema ? +((c - ema) / ema * 100).toFixed(3) : null,
          wick0: +((c - l) / l * 100).toFixed(3), below, aboveMin: below && c > L.value ? 0 : null, brokeMin: null,
          trough: l, rally: 0, rallyMin: 0, hi: h, lo: l, feat,
        };
        if (!open.has(sym)) open.set(sym, []);
        open.get(sym).push(e);
        openN++;
      }
      return done;
    },

    noteCard(sym, t) {
      const a = cardT.get(sym) || [];
      a.push(t);
      while (a.length && a[0] < t - 2 * window * MIN) a.shift();
      cardT.set(sym, a);
    },

    sweep(now = Date.now()) {
      for (const [sym, arr] of open) {
        for (let k = arr.length - 1; k >= 0; k--) if (now - arr[k].t > (window + 15) * MIN) { arr.splice(k, 1); openN--; }
        if (!arr.length) open.delete(sym);
      }
      for (const [sym, cm] of cool) {
        for (const [k, until] of cm) if (until < now) cm.delete(k);
        if (!cm.size) cool.delete(sym);
      }
      for (const [sym, a] of cardT) if (!a.length || a[a.length - 1] < now - 2 * window * MIN) cardT.delete(sym);
    },
    openCount: () => openN,
  };
}

/** Destek teması → düz CSV satırı (STOUCH_COLS) */
function stouchRow(r) {
  const o = {};
  for (const k of STOUCH_COLS) {
    const v = k === 'time' ? (Number.isFinite(r.t) ? new Date(r.t).toISOString() : null) : r[k];
    o[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null;
  }
  return o;
}

module.exports = { createSupportTouches, stouchRow, STOUCH_COLS, STOUCH_SNAP_COLS, extraSupports, dailyVwapLevels, TOUCH_PCT, WINDOW, SNAPS };
