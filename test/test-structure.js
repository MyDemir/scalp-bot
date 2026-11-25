'use strict';
// Fiyat yapısı (src/structure.js): pivot, market yapısı, BOS/CHoCH, ikili dip/tepe, FVG, EMA21/50, Tenkan/Kijun — yalnız kapanmış mum
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const S = require(`${REPO}/src/structure`);
const R = []; const ok = x => R.push('✅ ' + x);
const MIN = 60e3, TFM = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60 };

/** Sahte seri: kapanışlardan mum (h = max(o,c)+w, l = min(o,c)−w); her TF aynı dizi */
function mock(closes, { w = 0.05, part = null, over = {} } = {}) {
  const d = { t: [], o: [], h: [], l: [], c: [] };
  closes.forEach((c, i) => { const o = i ? closes[i - 1] : c; d.t.push(i); d.o.push(o); d.h.push(over[i]?.h ?? Math.max(o, c) + w); d.l.push(over[i]?.l ?? Math.min(o, c) - w); d.c.push(c); });
  const col = tf => (k, wp) => { const a = d[k].map((v, i) => (k === 't' ? i * TFM[tf] * MIN : v)); return wp && part ? a.concat([part[k]]) : a; };
  return { col: (tf, k, wp) => col(tf)(k, wp), price: () => closes[closes.length - 1], lastT: () => (closes.length - 1) * MIN, d };
}
const zig = (start, legs) => { const a = [start]; for (const [to, n] of legs) { const f = a[a.length - 1]; for (let k = 1; k <= n; k++) a.push(f + (to - f) * k / n); } return a; };

// ── Pivotlar: sağda 3 mum yoksa pivot yok (look-ahead yok) ──
{
  const c = zig(100, [[105, 6], [101, 6], [107, 6], [103, 6], [110, 6]]);
  const m = mock(c, { w: 0 });
  const p = S.pivots(m.d.h, m.d.l, 0);
  assert.deepStrictEqual(p.hi, [6, 18], 'pivot tepeler: ' + p.hi); assert.deepStrictEqual(p.lo, [12, 24], 'pivot dipler: ' + p.lo);
  const m2 = mock(c.slice(0, 21), { w: 0 });                         // 18. mum tepe, sağında yalnız 2 mum
  assert.deepStrictEqual(S.pivots(m2.d.h, m2.d.l, 0).hi, [6], 'kesinleşmemiş pivot sayılmaz');
  const st = S.structureTf(m, '15m', (c.length) * 15 * MIN).out;
  assert.strictEqual(st.ms_15m, 'HH-HL');
  assert.strictEqual(st.bos_15m, 'up', 'kapanış son pivot tepenin üstünde → up');
  const kUp = c.findIndex((v, i) => i > 21 && v > 107);
  assert.strictEqual(st.bosMin_15m, (c.length - (kUp + 1)) * 15, 'bosMin: ' + st.bosMin_15m);
  const dn = S.structureTf(mock(zig(110, [[104, 6], [108, 6], [102, 6], [106, 6], [99, 6]]), { w: 0 }), '5m', 0).out;
  assert.strictEqual(dn.ms_5m, 'LH-LL'); assert.strictEqual(dn.bos_5m, 'down');
  // CHoCH: düşen yapı sonra yukarı kırılım
  const ch = S.structureTf(mock(zig(110, [[104, 6], [108, 6], [102, 6], [106, 6], [101, 6], [109, 8]]), { w: 0 }), '5m', 0).out;
  assert.strictEqual(ch.bos_5m, 'up'); assert.strictEqual(ch.choch_5m, 1, 'aşağı kırılımdan sonra yukarı → CHoCH');
  assert.strictEqual(st.choch_15m, 0, 'yükselen yapıda yukarı kırılım devam (CHoCH 0)');
  ok(`Pivot ±3 kapanmış mum (sağda 3 mum yoksa yok); yapı HH-HL / LH-LL; BOS up/down, bosMin ${st.bosMin_15m} dk; CHoCH`);
}
// ── İkili dip / HL / ikili tepe ──
{
  const c = zig(100, [[95, 6], [97, 6], [95.2, 6], [99, 6]]);
  const st = S.structureTf(mock(c, { w: 0 }), '15m', 0);
  const f = S.formation('15m', st);
  assert.strictEqual(f.dblBot_15m, 1, 'iki dip %0.2 farklı, arada %2 tepki'); assert.strictEqual(f.hl_15m, 1);
  const g = S.formation('15m', S.structureTf(mock(zig(100, [[95, 6], [95.5, 6], [95.1, 6], [99, 6]]), { w: 0 }), '15m', 0));
  assert.strictEqual(g.dblBot_15m, 0, 'arada %1 tepki yok');
  const t = S.formation('5m', S.structureTf(mock(zig(100, [[105, 6], [103, 6], [104.9, 6], [100, 6]]), { w: 0 }), '5m', 0));
  assert.strictEqual(t.dblTop_5m, 1); assert.strictEqual(t.hl_5m, null, 'tek pivot dip → hl yok');
  ok('İkili dip (fark ≤ %0.5, arada ≥ %1), HL, ikili tepe; yetersiz pivotta boş');
}
// ── FVG ──
{
  const c = [...Array(10).fill(100), 104, 104, 104, 104];             // mum 11 low 103.95 > mum 9 high 100.05 → boğa FVG
  const m = mock(c);
  const f = S.fvgTf(m, '5m', 104);
  assert(f.fvgBullAge_5m === 2 && f.inFvgBull_5m === 0, 'boğa FVG altta: ' + JSON.stringify(f));
  assert(Math.abs(f.fvgBullDist_5m - (104 - 103.95) / 104 * 100) < 1e-3 && Math.abs(f.fvgBullSize_5m - (103.95 - 100.05) / 100.05 * 100) < 1e-3);
  assert.strictEqual(S.fvgTf(m, '5m', 102).inFvgBull_5m, 1, 'fiyat boşluğun içinde');
  const filled = mock([...c, 100, 104]);                              // sonraki mum boşluğu tamamen kapattı
  assert.strictEqual(S.fvgTf(filled, '5m', 104).fvgBullAge_5m, null, 'dolan FVG sayılmaz: ' + JSON.stringify(S.fvgTf(filled, '5m', 104)));
  const b = mock([...Array(10).fill(100), 96, 96, 96]);
  assert(Math.abs(S.fvgTf(b, '5m', 96).fvgBearDist_5m - (96.05 - 96) / 96 * 100) < 1e-3, 'ayı FVG üstte: ' + JSON.stringify(S.fvgTf(b, '5m', 96)));
  ok('FVG: boğa (altta, mesafe/boy/yaş), içinde, dolan sayılmaz; ayı (üstte)');
}
// ── EMA21/50 ve Tenkan/Kijun ──
{
  const up = Array.from({ length: 120 }, (_, i) => 100 + i * 0.1);
  const m = mock(up);
  const e = S.emaCross(m, '1m');
  assert(e.e2150_1m === 1 && e.e2150Gap_1m > 0 && e.e2150X_1m === null, 'hep yükselen: ' + JSON.stringify(e));
  const vee = [...Array.from({ length: 80 }, (_, i) => 110 - i * 0.2), ...Array.from({ length: 60 }, (_, i) => 94 + i * 0.4)];
  const x = S.emaCross(mock(vee), '3m');
  assert(x.e2150_3m === 1 && x.e2150X_3m > 0, 'yukarı kesişim işaretli: ' + JSON.stringify(x));
  assert.deepStrictEqual(S.emaCross(mock(up.slice(0, 40)), '1m'), { e2150_1m: null, e2150X_1m: null, e2150Gap_1m: null }, 'yetersiz seri boş');
  const tk = S.tkCross(mock(up), '1h');
  assert(tk.tk_1h === 1 && tk.tkGap_1h > 0 && tk.tkCloud_1h === 'üst', 'yükselen: ' + JSON.stringify(tk));
  const tv = S.tkCross(mock(vee), '5m');
  assert(tv.tk_5m === 1 && tv.tkX_5m > 0, 'TK yukarı kesişim: ' + JSON.stringify(tv));
  const td = S.tkCross(mock(Array.from({ length: 120 }, (_, i) => 100 - i * 0.1)), '15m');
  assert(td.tk_15m === 0 && td.tkCloud_15m === 'alt');
  ok(`EMA21/50: yön, işaretli kesişim (${x.e2150X_3m} mum önce yukarı), boşluk; Tenkan/Kijun: tk/tkX (${tv.tkX_5m})/tkGap/tkCloud üst-alt; yetersiz seride boş`);
}
// ── Look-ahead: kısmi (devam eden) mum ve gelecek mumlar sonucu değiştirmez; alanlar tam ──
{
  const c = zig(100, [[105, 12], [101, 12], [107, 12], [103, 12], [110, 12], [104, 30], [108, 30], [100, 30], [106, 30]]);
  const a = S.structureFeatures(mock(c), 106, 0);
  const b = S.structureFeatures(mock(c, { part: { t: 0, o: 106, h: 200, l: 1, c: 150 } }), 106, 0);
  assert.deepStrictEqual(b, a, 'kısmi mum okunmuyor');
  assert.deepStrictEqual(Object.keys(a), S.STRUCT_COLS);
  // süre: KEEP boyutlu seride tek çağrı
  const big = mock(Array.from({ length: 336 }, (_, i) => 100 + Math.sin(i / 7) * 3 + i * 0.01));
  const N = 200, t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) S.structureFeatures(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`structureFeatures: ${ms.toFixed(3)} ms / çağrı (${S.STRUCT_COLS.length} alan, 336 mumluk seri)`);
  assert(ms < 20, 'çağrı başı süre: ' + ms);
  ok(`Kısmi mum ve gelecek okunmuyor; ${S.STRUCT_COLS.length} alan; çağrı başı ~${ms.toFixed(2)} ms`);
}
console.log('\n' + R.join('\n'));
