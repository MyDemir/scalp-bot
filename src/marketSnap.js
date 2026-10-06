'use strict';

/**
 * Piyasa fotoğrafı — istatistik kaydı için (kartı ETKİLEMEZ).
 *
 *   tfIndicators : 1m / 3m / 5m / 15m / 1h / 4h için RSI(rsiPeriod), EMA21'e uzaklık %, MACD (kesişim / zayıf / güçlü)
 *                  ve histogram (% fiyat), Stoch RSI K/D, ATR %, son kapanmış mumun hacim katı (önceki 20 mumun
 *                  ortalamasına) ve taker alış %.
 *   vwapSet      : VWAP'lar ve ±σ bantları — günlük (UTC gün başı, 5m mumlar), haftalık (Pazartesi 00:00 UTC, 1h),
 *                  aylık (ayın 1'i 00:00 UTC, 4h) · kayan 90 dk (1m) / 24 saat (15m) / 7 gün (1h) ·
 *                  pompa dibinden sabitlenmiş VWAP (1m, son 4 saatin en düşük mumundan bugüne).
 *   refLevels    : tepki aranacak tüm seviyeler — kart seviyeleri (MA200/EMA200, 7/30g en yüksek, günlük/haftalık bölge,
 *                  trend çizgisi, 1h/4h tepe, Fib), Fib uzantıları, 15dk tepe/dip, VWAP ve ±1/2/3σ bantları,
 *                  EMA21 3dk/5dk/15dk/1s.
 *   nearest      : bir fiyatın %tol içindeki en yakın seviyesi (tepede "nereden tepki yedi", dipte "nerede durdu").
 */

const ta = require('./ta');
const { levelsOf, macdState, stochState } = require('./infoEngine');
const { swingHighs, fibExtensions } = require('./levels');

const TFS = ['1m', '3m', '5m', '15m', '1h', '4h'];
const DAY = 86_400_000, WEEK = 7 * DAY, MONDAY0 = 4 * DAY;
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

function lastClosedVol(series, tf) {
  const q = series.col(tf, 'q', false), tq = series.col(tf, 'tq', false);
  const n = q.length;
  if (n < 22) return { x: null, buy: null };
  let a = 0;
  for (let i = n - 21; i < n - 1; i++) a += q[i];
  return { x: a > 0 ? q[n - 1] / (a / 20) : null, buy: q[n - 1] > 0 ? tq[n - 1] / q[n - 1] * 100 : null };
}

/** @returns {object} düz alanlar: rsi_1m, ema21_1m, macd_1m, hist_1m, stk_1m, std_1m, atr_1m, volx_1m, buy_1m, … */
function tfIndicators(series, s = {}, price = series.price()) {
  const out = {};
  for (const tf of TFS) {
    const c = series.col(tf, 'c', true);
    const e = c.length >= 21 ? ta.emaSeries(c, 21) : [];
    const m = c.length >= 40 ? macdState(series, tf) : null;
    const st = c.length >= 40 ? stochState(series, tf) : null;
    const cc = series.col(tf, 'c', false), hh = series.col(tf, 'h', false), ll = series.col(tf, 'l', false);
    const atr = cc.length > 15 ? ta.atrSeries(hh, ll, cc, 14) : [];
    const v = lastClosedVol(series, tf);
    out[`rsi_${tf}`] = num(ta.rsiLast(c, s.rsiPeriod || 14), 1);
    out[`ema21_${tf}`] = e.length && price > 0 ? num((price - e[e.length - 1]) / e[e.length - 1] * 100) : null;
    out[`macd_${tf}`] = m ? (m.cross || (m.weakening ? 'zayıf' : 'güçlü')) : null;
    out[`hist_${tf}`] = m && price > 0 ? num(m.hist / price * 100, 4) : null;
    out[`stk_${tf}`] = st ? num(st.k, 1) : null;
    out[`std_${tf}`] = st ? num(st.d, 1) : null;
    out[`atr_${tf}`] = atr.length && price > 0 ? num(atr[atr.length - 1] / price * 100, 3) : null;
    out[`volx_${tf}`] = num(v.x);
    out[`buy_${tf}`] = num(v.buy, 1);
  }
  return out;
}
const TF_COLS = Object.keys(tfIndicators({ col: () => [], price: () => 1 }, {}, 1));

function vwapFrom(series, tf, fromT, nLast = null) {
  const t = series.col(tf, 't', true);
  if (!t.length) return null;
  let from;
  if (nLast != null) from = Math.max(0, t.length - nLast);
  else { from = t.length; while (from > 0 && t[from - 1] >= fromT) from--; if (from >= t.length) return null; }
  if (fromT != null && nLast == null && t[0] > fromT) return null;           // bellekte başlangıç yok (ör. ay başı çok eski)
  return ta.vwapBands(series.col(tf, 'h', true), series.col(tf, 'l', true), series.col(tf, 'c', true), series.col(tf, 'v', true), from);
}

/**
 * @param {number} [anchorT]  sabitlenmiş VWAP başlangıcı (pompa dibinin 1m mum zamanı)
 * @returns {{D,W,M,r90,r24,r7d,aLow}}  her biri {vwap, sigma} | null
 */
function vwapSet(series, anchorT = null) {
  const now = series.lastT('1m') ?? Date.now();
  const dayStart = Math.floor(now / DAY) * DAY;
  const weekStart = Math.floor((now - MONDAY0) / WEEK) * WEEK + MONDAY0;
  const d = new Date(now); const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return {
    D: vwapFrom(series, '5m', dayStart), W: vwapFrom(series, '1h', weekStart), M: vwapFrom(series, '4h', monthStart),
    r90: vwapFrom(series, '1m', null, 90), r24: vwapFrom(series, '15m', null, 96), r7d: vwapFrom(series, '1h', null, 168),
    aLow: anchorT != null ? vwapFrom(series, '1m', anchorT) : null,
  };
}

/** VWAP alanları: vwD_pct (fiyatın VWAP'a uzaklığı %) · vwD_sig (σ cinsinden) … */
function vwapFeatures(vw, price) {
  const pct = x => (x && x.vwap > 0 ? num((price - x.vwap) / x.vwap * 100) : null);
  const sig = x => (x && x.sigma > 0 ? num((price - x.vwap) / x.sigma) : null);
  return {
    vwD_pct: pct(vw.D), vwD_sig: sig(vw.D), vwW_pct: pct(vw.W), vwW_sig: sig(vw.W), vwM_pct: pct(vw.M), vwM_sig: sig(vw.M),
    vw90_pct: pct(vw.r90), vw90_sig: sig(vw.r90), vw24h_pct: pct(vw.r24), vw7d_pct: pct(vw.r7d), avwLow_pct: pct(vw.aLow),
  };
}
const VWAP_COLS = Object.keys(vwapFeatures({}, 1));

const VW_NAME = { D: 'Günlük VWAP', W: 'Haftalık VWAP', M: 'Aylık VWAP', r90: '90dk VWAP', r24: '24s VWAP', r7d: '7g VWAP', aLow: 'Pompa dibi VWAP' };

/** Tepki aranacak tüm seviyeler [{name, value, kind}] */
function refLevels(series, s, vw) {
  const out = [];
  const push = (name, value, kind) => { if (Number.isFinite(value) && value > 0) out.push({ name, value, kind }); };
  for (const L of levelsOf(series, s)) push(L.name, L.value, L.kind);
  const leg = series._lv?.leg;
  if (leg && leg.up) for (const r of [1.272, 1.618, 2]) push(`Fib ${r}`, leg.lo + r * (leg.hi - leg.lo), 'fibext');
  const h15 = series.col('15m', 'h', false), l15 = series.col('15m', 'l', false);
  for (const p of swingHighs(h15, 3, 200).slice(-6)) push('15dk tepe', p.value, 'swing');
  for (const p of swingHighs(l15.map(x => -x), 3, 200).slice(-6)) push('15dk dip', -p.value, 'swing');
  for (const [k, x] of Object.entries(vw || {})) {
    if (!x) continue;
    push(VW_NAME[k], x.vwap, 'vwap');
    if (['D', 'W', 'M'].includes(k) && x.sigma > 0) for (const m of [1, 2, 3]) { push(`${VW_NAME[k]} +${m}σ`, x.vwap + m * x.sigma, 'vwap'); push(`${VW_NAME[k]} −${m}σ`, x.vwap - m * x.sigma, 'vwap'); }
  }
  for (const tf of ['3m', '5m', '15m', '1h']) {
    const c = series.col(tf, 'c', true);
    if (c.length < 21) continue;
    const e = ta.emaSeries(c, 21);
    push(`${tf.replace('m', 'dk').replace('1h', '1s')} EMA21`, e[e.length - 1], 'ema');
  }
  return out;
}

/** Fiyata %tol içindeki en yakın seviye + %near içindeki tüm seviye adları */
function nearest(levels, price, tol = 0.3, near = 0.5) {
  let best = null;
  const names = [];
  for (const L of levels) {
    const d = (price - L.value) / L.value * 100;
    if (Math.abs(d) <= near) names.push(L.name);
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.dist))) best = { name: L.name, kind: L.kind, value: L.value, dist: num(d, 3) };
  }
  return { best, near: [...new Set(names)] };
}

module.exports = { TFS, TF_COLS, VWAP_COLS, tfIndicators, vwapSet, vwapFeatures, refLevels, nearest };
