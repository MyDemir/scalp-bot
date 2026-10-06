'use strict';

/**
 * Direnç seviyeleri.
 */

const { emaLast } = require('./ta');

function roundPx(x) {
  return x == null || !Number.isFinite(x) ? null : +x.toPrecision(10);
}

function calcMajorResistance(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 5) return null;
  const highs = dailyCandles.map(c => c.high).sort((a, b) => b - a);
  const top3 = highs.slice(0, 3);
  return roundPx(top3.reduce((s, v) => s + v, 0) / top3.length);
}

const sma200 = arr => (arr.length >= 200 ? arr.slice(-200).reduce((s, v) => s + v, 0) / 200 : null);
const ema200 = arr => (arr.length >= 200 ? emaLast(arr, 200) : null);

function calcLevelSet(h4Closes, dayCandles) {
  const dCloses = dayCandles.map(d => d.close);
  const raw = [
    ['4h MA200',  sma200(h4Closes)],
    ['4h EMA200', ema200(h4Closes)],
    ['1d MA200',  sma200(dCloses)],
    ['1d EMA200', ema200(dCloses)],
    ['30 günlük tepe', calcMajorResistance(dayCandles.slice(-30))],
  ];
  return raw.filter(([, v]) => Number.isFinite(v) && v > 0).map(([name, v]) => ({ name, value: roundPx(v), kind: 'major' }));
}

function impulseLeg(h, l, show = 100, dir = 'up') {
  const n = Math.min(h.length, l.length);
  if (n < 10) return null;
  const start = Math.max(0, n - show);
  const argmax = (a, b) => { let k = a; for (let i = a; i <= b; i++) if (h[i] > h[k]) k = i; return k; };
  const argmin = (a, b) => { let k = a; for (let i = a; i <= b; i++) if (l[i] < l[k]) k = i; return k; };
  let hiI, loI, up;
  if (dir === 'down') { hiI = argmax(start, n - 1); loI = argmin(hiI, n - 1); up = false; }
  else { loI = argmin(start, n - 1); hiI = argmax(loI, n - 1); up = true; }
  const fullHi = h[argmax(start, n - 1)], fullLo = l[argmin(start, n - 1)];
  if ((h[hiI] - l[loI]) < (fullHi - fullLo) * 0.3) { hiI = argmax(start, n - 1); loI = argmin(start, n - 1); up = loI < hiI; }
  if (!(h[hiI] > l[loI])) return null;
  return { hi: h[hiI], lo: l[loI], hiI, loI, up };
}

function swingHighs(h, bars = 3, lookback = 200) {
  const out = [];
  const n = h.length;
  for (let i = Math.max(bars, n - lookback); i < n - bars; i++) {
    let ok = true;
    for (let k = 1; k <= bars && ok; k++) if (!(h[i] > h[i - k]) || !(h[i] >= h[i + k])) ok = false;
    if (ok) out.push({ i, value: h[i] });
  }
  return out;
}

function majorLeg(t, h, l, lookback = 365) {
  const n = Math.min(h.length, l.length);
  if (n < 20) return null;
  let hiI = Math.max(0, n - lookback), loI = hiI;
  for (let i = Math.max(0, n - lookback); i < n; i++) { if (h[i] > h[hiI]) hiI = i; if (l[i] < l[loI]) loI = i; }
  if (!(h[hiI] > l[loI])) return null;
  return { hi: h[hiI], lo: l[loI], hiT: t[hiI], loT: t[loI], up: loI < hiI };
}

function pivots(h, l, bars, from) {
  const out = [];
  for (let i = Math.max(bars, from); i < h.length - bars; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= bars; k++) {
      if (!(h[i] > h[i - k] && h[i] >= h[i + k])) hi = false;
      if (!(l[i] < l[i - k] && l[i] <= l[i + k])) lo = false;
    }
    if (hi) out.push({ i, v: h[i], type: 'high' });
    if (lo) out.push({ i, v: l[i], type: 'low' });
  }
  return out;
}

function dailyZones(t, h, l, { lookback = 365, bars = 3, tol = 0.015, minTouch = 3 } = {}) {
  const pts = pivots(h, l, bars, h.length - lookback).sort((a, b) => a.v - b.v);
  const zones = [];
  let cur = null;
  for (const p of pts) {
    if (cur && p.v <= cur.lo * (1 + tol)) { cur.hi = Math.max(cur.hi, p.v); cur.touches++; cur.last = Math.max(cur.last, t[p.i]); }
    else { cur = { lo: p.v, hi: p.v, touches: 1, last: t[p.i] }; zones.push(cur); }
  }
  return zones.filter(z => z.touches >= minTouch);
}

function dailyTrendline(t, h, c, { lookback = 365, bars = 5 } = {}) {
  const n = h.length;
  const highs = pivots(h, h, bars, n - lookback).filter(p => p.type === 'high');
  if (highs.length < 2) return null;
  let A = highs[0];
  for (const p of highs) if (p.v > A.v) A = p;
  let best = null;
  for (const p of highs) {
    if (p.i - A.i < 10 || !(p.v < A.v)) continue;
    const slope = (Math.log(p.v) - Math.log(A.v)) / (p.i - A.i);
    if (!best || slope > best.slope) best = { p, slope };
  }
  if (!best || !(best.slope < 0)) return null;
  const at = i => Math.exp(Math.log(A.v) + best.slope * (i - A.i));
  let over = 0;
  for (let i = best.p.i + 1; i < n; i++) {
    if (c[i] > at(i) * 1.05) return null;
    if (c[i] > at(i) * 1.02 && ++over >= 2) return null;
  }
  const value = at(n);
  if (!(value > 0)) return null;
  return { value, a: { v: A.v, t: t[A.i] }, b: { v: best.p.v, t: t[best.p.i] } };
}

/**
 * Haftalık bölgeler: günlük mumlar Binance haftasına (Pazartesi 00:00 UTC) toplanır; haftalık pivot tepe/dipleri
 * (iki yanında 2 hafta) %2 içinde kümelenir, en az 2 temas alan küme bölge olur. ~400 gün ≈ 57 hafta.
 * Devam eden hafta pivot olamaz (sağında 2 hafta gerekir). @returns {{lo, hi, touches, last}[]}
 */
const WEEK = 7 * 86_400_000, MONDAY0 = 4 * 86_400_000;   // 1970-01-05 Pazartesi
function toWeekly(d1) {
  const w = { t: [], h: [], l: [] };
  for (let i = 0; i < d1.t.length; i++) {
    const ws = Math.floor((d1.t[i] - MONDAY0) / WEEK) * WEEK + MONDAY0;
    const n = w.t.length;
    if (n && w.t[n - 1] === ws) { if (d1.h[i] > w.h[n - 1]) w.h[n - 1] = d1.h[i]; if (d1.l[i] < w.l[n - 1]) w.l[n - 1] = d1.l[i]; }
    else { w.t.push(ws); w.h.push(d1.h[i]); w.l.push(d1.l[i]); }
  }
  return w;
}
function weeklyZones(d1, { bars = 2, tol = 0.02, minTouch = 2 } = {}) {
  const w = toWeekly(d1);
  if (w.t.length < 12) return [];
  return dailyZones(w.t, w.h, w.l, { lookback: w.t.length, bars, tol, minTouch });
}

const FIB_RET = [0.236, 0.382, 0.5, 0.618, 0.786];
const FIB_EXT = [1.272, 1.618, 2, 2.618];

function calcExtraLevels({ h1, h4, d1 }, o, base = []) {
  const out = [];
  const add = (name, v, kind, extra = null) => {
    if (!(Number.isFinite(v) && v > 0)) return;
    const hit = [...base, ...out].find(L => Math.abs(L.value - v) / L.value <= 0.003);
    if (hit) { if (kind !== 'swing') (hit.also = hit.also || []).push(name); return; }
    out.push({ name, value: roundPx(v), kind, ...(extra || {}) });
  };
  const dh = d1?.h || [];
  if (dh.length >= 20) add('30 günlük en yüksek', Math.max(...dh.slice(-30)), 'high');
  if (dh.length >= 7) add('7 günlük en yüksek', Math.max(...dh.slice(-7)), 'high');
  const d1ok = d1 && d1.t && d1.l && d1.c && dh.length >= 30;

  // Haftalık bölgeler önce (daha güçlü): günlük bölge aynı yere düşerse haftalığın "also" notu olur
  if (o.weeklyZone !== false && d1ok) {
    for (const z of weeklyZones(d1)) add('Haftalık bölge', z.lo, 'zone', { zoneInfo: { ...z, weekly: true } });
  }
  const zones = d1ok ? dailyZones(d1.t, dh, d1.l, { minTouch: o.zoneTouches || 3 }) : [];
  for (const z of zones) add('Günlük bölge', z.lo, 'zone', { zoneInfo: z });
  const tl = d1ok ? dailyTrendline(d1.t, dh, d1.c) : null;
  if (tl) add('Günlük trend çizgisi', tl.value, 'trend', { trend: tl });

  if (o.swing) {
    for (const p of swingHighs(h4?.h || [], o.bars, 180).reverse()) add('4h tepe', p.value, 'swing');
    for (const p of swingHighs(h1?.h || [], o.bars, 200).reverse()) add('1h tepe', p.value, 'swing');
  }

  const leg = h1 && h1.t && h1.h.length >= 30 ? majorLeg(h1.t, h1.h, h1.l, 336) : null;
  if (o.fib && leg) {
    const R = leg.hi - leg.lo;
    for (const r of FIB_RET) add(`Fib ${r}`, leg.up ? leg.hi - r * R : leg.lo + r * R, 'fib');
  }
  return { levels: out, leg };
}

function fibExtensions(leg, price, max = 2) {
  if (!leg || !leg.up) return [];
  const R = leg.hi - leg.lo;
  return FIB_EXT.map(r => ({ r, value: roundPx(leg.lo + r * R) })).filter(x => x.value > price).slice(0, max);
}

module.exports = { toWeekly, weeklyZones, roundPx, calcMajorResistance, calcLevelSet, impulseLeg, majorLeg, dailyZones, dailyTrendline, swingHighs, calcExtraLevels, fibExtensions, FIB_RET, FIB_EXT };
