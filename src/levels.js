'use strict';

/**
 * Direnç seviyeleri. Canlı bilgi botu ve backtest AYNI fonksiyonları kullanır. Yan etkisi yok.
 *   majör  : 4h MA200/EMA200, 1d MA200/EMA200, 30 günlük tepe (en yüksek 3 günün ortalaması)
 *   en yüksek: 7 / 30 günlük gerçek en yüksek (kapanmış günler)
 *   salınım: 1h / 4h tepe (solundaki ve sağındaki N mumdan yüksek tepe)
 *   bölge  : günlük bölge — son ~1 yılın günlük tepe/dip noktalarının kümesi (≥ 2 temas; eski destekler dahil)
 *   trend  : günlük düşen trend çizgisi — en yüksek günlük tepeden sonraki tepelere çizilen üst çizgi, bugüne uzatılmış
 *   Fib    : 1 SAATLİK geniş bacağın (son ~2 haftanın 1h en yüksek tepe ↔ en düşük dip) 0.236 / 0.382 / 0.5 / 0.618 / 0.786
 *            düzeltmesi — kart grafiği (1h) ile aynı bacak; yön otomatik (dip tepeden sonraysa düşüş bacağı → seviyeler direnç)
 * Her seviye { name, value, kind: 'major'|'high'|'zone'|'trend'|'swing'|'fib' }.
 */

const { emaLast } = require('./ta');

/**
 * Çok küçük fiyatlı coinlerde toFixed(6) hassasiyet kaybettiriyordu
 * (0.0000123 → 0.000012). Anlamlı basamak bazlı yuvarlama kullanıyoruz.
 */
function roundPx(x) {
  return x == null || !Number.isFinite(x) ? null : +x.toPrecision(10);
}

/**
 * Son 30 günün en yüksek 3 high'ının ortalaması → majör yatay direnç
 * @param {{high:number}[]} dailyCandles
 */
function calcMajorResistance(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 5) return null;
  const highs = dailyCandles.map(c => c.high).sort((a, b) => b - a);
  const top3 = highs.slice(0, 3);
  return roundPx(top3.reduce((s, v) => s + v, 0) / top3.length);
}

const sma200 = arr => (arr.length >= 200 ? arr.slice(-200).reduce((s, v) => s + v, 0) / 200 : null);
const ema200 = arr => (arr.length >= 200 ? emaLast(arr, 200) : null);

/**
 * Direnç seviyeleri (bilgi botu + backtest varyantları ortak kullanır).
 * @param {number[]} h4Closes    - kapanmış 4h kapanışları (eski → yeni; EMA200'ün oturması için ~600)
 * @param {object[]} dayCandles  - günlük mumlar {high, close} (eski → yeni; devam eden gün dahil olabilir)
 * @returns {{ name: string, value: number }[]}  yalnızca hesaplanabilenler (yeni coinlerde eksik olabilir)
 */
function calcLevelSet(h4Closes, dayCandles) {
  const dCloses = dayCandles.map(d => d.close);
  const raw = [
    ['4h MA200',  sma200(h4Closes)],
    ['4h EMA200', ema200(h4Closes)],
    ['1d MA200',  sma200(dCloses)],
    ['1d EMA200', ema200(dCloses)],
    ['30 günlük tepe', calcMajorResistance(dayCandles.slice(-30))],   // son 30 günün en yüksek 3 tepesinin ortalaması
  ];
  return raw.filter(([, v]) => Number.isFinite(v) && v > 0).map(([name, v]) => ({ name, value: roundPx(v), kind: 'major' }));
}

/**
 * Son itki bacağı (grafikteki Fibonacci ile aynı): pencerenin en düşük dibi → ondan sonraki en yüksek tepe
 * (dir='down': en yüksek tepe → ondan sonraki en düşük dip). Bacak pencere aralığının %30'undan kısaysa
 * tüm pencerenin dip–tepesi alınır.
 * @returns {{hi:number, lo:number, hiI:number, loI:number, up:boolean}|null}  indeksler h/l dizisinde
 */
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

/** Salınım tepeleri: h[i] solundaki `bars` mumdan büyük ve sağındaki `bars` mumdan büyük-eşit (son `lookback` mum) */
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

/**
 * Günlük geniş bacak (Fibonacci): pencerenin en yüksek tepesi ve en düşük dibi; hangisi sonra geldiyse bacak ona doğru.
 *   up=true  : dip → tepe (yükseliş) · up=false: tepe → dip (düşüş)
 * @returns {{hi, lo, hiT, loT, up}|null}
 */
function majorLeg(t, h, l, lookback = 365) {
  const n = Math.min(h.length, l.length);
  if (n < 20) return null;
  let hiI = Math.max(0, n - lookback), loI = hiI;
  for (let i = Math.max(0, n - lookback); i < n; i++) { if (h[i] > h[hiI]) hiI = i; if (l[i] < l[loI]) loI = i; }
  if (!(h[hiI] > l[loI])) return null;
  return { hi: h[hiI], lo: l[loI], hiT: t[hiI], loT: t[loI], up: loI < hiI };
}

/** Pivot noktaları: tepe = iki yanındaki `bars` mumdan yüksek; dip = düşük */
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

/**
 * Günlük bölgeler: son `lookback` günün pivot tepe VE dipleri fiyata göre sıralanıp %tol içinde kümelenir;
 * ≥ minTouch temas alan küme bölge olur (eski destek, fiyat altına inince dirence döner).
 * @returns {{lo, hi, touches, last}[]}  last: son temasın zamanı
 */
function dailyZones(t, h, l, { lookback = 365, bars = 3, tol = 0.015, minTouch = 2 } = {}) {
  const pts = pivots(h, l, bars, h.length - lookback).sort((a, b) => a.v - b.v);
  const zones = [];
  let cur = null;
  for (const p of pts) {
    if (cur && p.v <= cur.lo * (1 + tol)) { cur.hi = Math.max(cur.hi, p.v); cur.touches++; cur.last = Math.max(cur.last, t[p.i]); }
    else { cur = { lo: p.v, hi: p.v, touches: 1, last: t[p.i] }; zones.push(cur); }
  }
  return zones.filter(z => z.touches >= minTouch);
}

/**
 * Günlük düşen trend çizgisi (log fiyat): pencerenin en yüksek pivot tepesi (A) ile sonraki pivot tepeler arasından
 * çizginin diğer tüm tepelerin üstünde kaldığı (en yatık) B seçilir; çizgi bugüne uzatılır. B'den sonra 2 günlük kapanış
 * çizginin %2'den (ya da 1 kapanış %5'ten) fazla üstündeyse çizgi kırılmış sayılır (yok). En az 10 gün arayla iki tepe gerekir.
 * @returns {{value, a:{v,t}, b:{v,t}}|null}
 */
function dailyTrendline(t, h, c, { lookback = 365, bars = 5 } = {}) {
  // Logaritmik fiyatta düz çizgi (uzun vadeli grafikler log ölçekte okunur; doğrusalda uzun düşüşlerde çizgi fazla dik olur)
  const n = h.length;
  const highs = pivots(h, h, bars, n - lookback).filter(p => p.type === 'high');
  if (highs.length < 2) return null;
  let A = highs[0];
  for (const p of highs) if (p.v > A.v) A = p;
  let best = null;
  for (const p of highs) {
    if (p.i - A.i < 10 || !(p.v < A.v)) continue;
    const slope = (Math.log(p.v) - Math.log(A.v)) / (p.i - A.i);
    if (!best || slope > best.slope) best = { p, slope };      // en yatık = diğer tepeler çizginin altında
  }
  if (!best || !(best.slope < 0)) return null;
  const at = i => Math.exp(Math.log(A.v) + best.slope * (i - A.i));
  // Kırılım: B'den sonra en az 2 günlük kapanış çizginin %2'den fazla üstünde ya da biri %5'ten fazla üstünde
  let over = 0;
  for (let i = best.p.i + 1; i < n; i++) {
    if (c[i] > at(i) * 1.05) return null;
    if (c[i] > at(i) * 1.02 && ++over >= 2) return null;
  }
  const value = at(n);                                          // bugünkü (devam eden gün) değeri
  if (!(value > 0)) return null;
  return { value, a: { v: A.v, t: t[A.i] }, b: { v: best.p.v, t: t[best.p.i] } };
}

const FIB_RET = [0.236, 0.382, 0.5, 0.618, 0.786];
const FIB_EXT = [1.272, 1.618, 2, 2.618];

/**
 * Ek seviyeler (kapanmış mumlardan).
 * @param {object} p
 * @param {{h:number[], l:number[]}} p.h1  1h mumlar
 * @param {{h:number[]}} p.h4              4h mumlar
 * @param {{t:number[],h:number[],l:number[],c:number[]}} p.d1  1d mumlar (kapanmış)
 * @param {object} o  { swing:boolean, fib:boolean, bars:number }
 * @param {{name,value}[]} base  mevcut (majör) seviyeler — bunlara %0.3'ten yakın ek seviye eklenmez
 * @returns {{levels:object[], leg:object|null}}
 */
function calcExtraLevels({ h1, h4, d1 }, o, base = []) {
  const out = [];
  const add = (name, v, kind, extra = null) => {
    if (!(Number.isFinite(v) && v > 0)) return;
    // yakın kopya eklenmez (öncelik: majör → en yüksek → bölge → trend → salınım → Fib); çakışma kalan seviyeye not edilir
    const hit = [...base, ...out].find(L => Math.abs(L.value - v) / L.value <= 0.003);
    if (hit) { if (kind !== 'swing') (hit.also = hit.also || []).push(name); return; }
    out.push({ name, value: roundPx(v), kind, ...(extra || {}) });
  };
  const dh = d1?.h || [];
  if (dh.length >= 20) add('30 günlük en yüksek', Math.max(...dh.slice(-30)), 'high');
  if (dh.length >= 7) add('7 günlük en yüksek', Math.max(...dh.slice(-7)), 'high');   // 30 günlükle aynıysa tek seviye
  const d1ok = d1 && d1.t && d1.l && d1.c && dh.length >= 30;
  // Günlük bölgeler (değer = bölgenin alt kenarı: direnç orada başlar) ve düşen trend çizgisi
  const zones = d1ok ? dailyZones(d1.t, dh, d1.l) : [];
  for (const z of zones) add('Günlük bölge', z.lo, 'zone', { zoneInfo: z });   // ("zone" alanı dirençte/yaklaşıyor için kullanılıyor)
  const tl = d1ok ? dailyTrendline(d1.t, dh, d1.c) : null;
  if (tl) add('Günlük trend çizgisi', tl.value, 'trend', { trend: tl });
  if (o.swing) {
    for (const p of swingHighs(h4?.h || [], o.bars, 180).reverse()) add('4h tepe', p.value, 'swing');
    for (const p of swingHighs(h1?.h || [], o.bars, 200).reverse()) add('1h tepe', p.value, 'swing');
  }
  // Fib: 1 SAATLİK geniş bacak (son ~2 hafta = 336 mum), yön otomatik — grafikteki bacakla aynı
  const leg = h1 && h1.t && h1.h.length >= 30 ? majorLeg(h1.t, h1.h, h1.l, 336) : null;
  if (o.fib && leg) {
    const R = leg.hi - leg.lo;
    for (const r of FIB_RET) add(`Fib ${r}`, leg.up ? leg.hi - r * R : leg.lo + r * R, 'fib');
  }
  return { levels: out, leg };
}

/** Fib uzantı hedefleri (yükseliş bacağı: dip + oran × bacak) — fiyatın üstündekiler, en fazla `max` tane */
function fibExtensions(leg, price, max = 2) {
  if (!leg || !leg.up) return [];
  const R = leg.hi - leg.lo;
  return FIB_EXT.map(r => ({ r, value: roundPx(leg.lo + r * R) })).filter(x => x.value > price).slice(0, max);
}

module.exports = { roundPx, calcMajorResistance, calcLevelSet, impulseLeg, majorLeg, dailyZones, dailyTrendline, swingHighs, calcExtraLevels, fibExtensions, FIB_RET, FIB_EXT };
