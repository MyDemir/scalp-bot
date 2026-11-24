'use strict';
// Günlük geniş Fib + günlük bölge + günlük düşen trend çizgisi + grafik kenar etiketleri (BONK benzeri senaryo)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const L = require(`${REPO}/src/levels`); const chart = require(`${REPO}/src/chart`);
const DAY = 86_400_000, t0 = Date.UTC(2025, 7, 25);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Günlük kapanış yolu (400 gün, bugün = 399)
const key = [[0, 0.0100], [150, 0.0095], [155, 0.0134], [200, 0.0055], [215, 0.0049], [230, 0.0060], [245, 0.00495], [260, 0.0078],
  [275, 0.0050], [290, 0.0049], [300, 0.0038], [310, 0.00485], [322, 0.0040], [335, 0.00478], [365, 0.00222], [385, 0.0034], [399, 0.00384]];
const path = [];
for (let k = 0; k < key.length - 1; k++) {
  const [i0, v0] = key[k], [i1, v1] = key[k + 1];
  for (let i = i0; i < i1; i++) path.push(v0 + (v1 - v0) * (i - i0) / (i1 - i0));
}
path.push(key[key.length - 1][1]);
const d1 = { t: [], h: [], l: [], c: [] };
path.forEach((v, i) => {
  const isKey = key.some(([k]) => k === i);
  const o = i ? path[i - 1] : v, c = v * (1 + (isKey ? 0 : (rnd() - 0.5) * 0.004));
  d1.t.push(t0 + i * DAY); d1.c.push(c);
  d1.h.push(Math.max(o, c) * (isKey ? 1.0005 : 1 + rnd() * 0.004)); d1.l.push(Math.min(o, c) * (isKey ? 0.9995 : 1 - rnd() * 0.004));
});
const price = d1.c[399];

// ── 1) Günlük Fib bacağı: tepe (gün 155) → dip (gün 365), düşüş ──
const leg = L.majorLeg(d1.t, d1.h, d1.l);
assert(leg && !leg.up && Math.abs(leg.hi - 0.0134) / 0.0134 < 0.006 && Math.abs(leg.lo - 0.00222) / 0.00222 < 0.006, JSON.stringify(leg));
const f236 = leg.lo + 0.236 * (leg.hi - leg.lo);
assert(Math.abs(f236 - 0.004856) / 0.004856 < 0.01, 'Fib 0.236 ≈ 0.004856: ' + f236);

// ── 2) Bölge ve trend çizgisi ──
const zones = L.dailyZones(d1.t, d1.h, d1.l);
const z = zones.find(q => q.lo > price && q.lo < 0.0052 && q.hi > 0.0047);
assert(z && z.touches >= 3, 'eski destek → direnç bölgesi (~0.0048–0.0050) bekleniyordu: ' + JSON.stringify(zones.map(q => [q.lo.toFixed(5), q.hi.toFixed(5), q.touches])));
// hiN/loN: tepe ve dip pivotları ayrı sayılır, toplam touches; küme sınırları eski hesapla aynı
{ const piv = [[10, 'h'], [20, 'l'], [30, 'h'], [40, 'h']]; const n = 60, hh = Array(n).fill(50), ll = Array(n).fill(150);
  for (const [i, k] of piv) { if (k === 'h') hh[i] = 100; else ll[i] = 99.5; }   // 3 tepe (100) + 1 dip (99.5), diğer pivotlar uzakta
  const zs = L.dailyZones(Array.from({ length: n }, (_, i) => i), hh, ll, { lookback: n, bars: 3, minTouch: 3 });
  const zz = zs.find(q => q.lo >= 99 && q.hi <= 100.01);
  assert(zz && zz.hiN === 3 && zz.loN === 1 && zz.touches === zz.hiN + zz.loN && zz.lo === 99.5 && zz.hi === 100 && zz.last === 40, JSON.stringify(zz));
  for (const q of zones.concat(L.weeklyZones(d1))) assert.strictEqual(q.hiN + q.loN, q.touches, 'touches = hiN + loN'); }
const wz = L.weeklyZones(d1);
assert(wz.some(q => q.lo > 0.0047 && q.lo < 0.0050 && q.touches >= 2) && wz.every(q => q.lo > 0), 'haftalık bölge (haftalık mumlardan) ~0.0048: ' + JSON.stringify(wz.map(q => [q.lo.toFixed(5), q.touches])));
assert(L.toWeekly(d1).t.every(t => new Date(t).getUTCDay() === 1 && t % 86400000 === 0), 'haftalar Pazartesi 00:00 UTC');
// Temas sayısı: ayrı testler (art arda değen mumlar tek), üstünde kapanan sayılmaz, hareketli MA kendi değeriyle
{ const h = [], c = []; for (let i = 0; i < 120; i++) { const tch = [10, 11, 30, 50, 51, 52, 80, 100].includes(i); h.push(tch ? 100.2 : 97); c.push(tch ? 99.5 : 96.5); }
  assert.strictEqual(L.countTouches(h, c, () => 100), 5);
  assert.deepStrictEqual(L.countTouchesDir(h, c, () => 100), { up: 5, down: 0 }, 'alttan yaklaşma = up');
  // üstten geri geliş = down: 102'den inip 100'e değen mum; sonra alttan (96) gelen = up
  assert.deepStrictEqual(L.countTouchesDir([103, 100.2, 97, 97, 97, 100.2], [102, 99.5, 96, 96, 96, 99.5], () => 100), { up: 1, down: 1 }, 'yönlü sayım');
  { let sd = 7; const rnd = () => (sd = (sd * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let t = 0; t < 300; t++) { const n = 30 + Math.floor(rnd() * 120), hh = [], cc = [];
      for (let i = 0; i < n; i++) { const m = 100 * (1 + (rnd() - 0.5) * 0.04); cc.push(m); hh.push(m * (1 + rnd() * 0.01)); }
      const o = { gap: 1 + Math.floor(rnd() * 3), range: rnd() < 0.3 ? [99.5, 100.5] : null }, r = L.countTouchesDir(hh, cc, () => 100, o);
      assert.strictEqual(r.up + r.down, L.countTouches(hh, cc, () => 100, o), 'up+down === countTouches'); } }
  assert.strictEqual(L.countTouches([101, 101], [100.8, 100.9], () => 100), 0, 'üstünde kapanan test sayılmaz');
  assert.strictEqual(L.countTouches([99.9, 97, 97, 99.9], [99, 96, 96, 99], () => 100, { range: [99.5, 101] }), 2, 'bölge aralığı');
  { const lx = L.annotateTouches([{ name: 'X', value: 100, kind: 'high' }], { h4: { h: [103, 100.2, 97, 97, 97, 100.2], c: [102, 99.5, 96, 96, 96, 99.5] } })[0]; assert(lx.touches === 2 && lx.touchesUp === 1 && lx.touchesDn === 1, 'annotateTouches yönlü alanlar'); }
  const lv = L.annotateTouches([{ name: '4h MA200', value: 1, kind: 'major' }, { name: 'X', value: 100, kind: 'high' }],
    { h4: { h: [...Array(250).fill(97), 100.1], c: [...Array(250).fill(96), 99.8] }, d1: { t: [], h: [], c: [] } });
  assert(lv[1].touches === 1 && Number.isFinite(lv[0].touches), 'annotate: ' + JSON.stringify(lv)); }
const tl = L.dailyTrendline(d1.t, d1.h, d1.c);
assert(tl && tl.a.v > 0.013 && Math.abs(tl.value - price) / price < 0.05, 'düşen trend çizgisi: ' + JSON.stringify(tl));
const { levels } = L.calcExtraLevels({ h1: { h: [], l: [] }, h4: { h: [] }, d1 }, { swing: true, fib: true, bars: 3, weeklyZone: true }, []);
assert(levels.some(x => x.name === 'Haftalık bölge' && x.zoneInfo?.weekly), 'haftalık bölge seviyesi eklendi');
const names = levels.filter(x => x.value > price).sort((a, b) => a.value - b.value).map(x => `${x.name} ${x.value.toPrecision(4)}`);
assert(levels.some(x => x.kind === 'zone' && x.zoneInfo) && levels.some(x => x.kind === 'trend' && x.trend));
console.log('Fiyat', price.toPrecision(4), '→ üstteki seviyeler:\n  ' + names.join('\n  '));
console.log(`Bölge: ${z.lo.toPrecision(4)}–${z.hi.toPrecision(4)} (${z.touches} temas) · Trend: ${tl.a.v.toPrecision(4)} → ${tl.b.v.toPrecision(4)} · bugün ${tl.value.toPrecision(4)} · Fib 0.236 ${f236.toPrecision(4)}`);

// ── 3) Grafik: 1h mumlar (son ~4 gün) + günlük bacak + uzak seviyeler kenarda ──
const h1 = [];
let p = 0.0034;
for (let i = 0; i < 110; i++) { const o = p; p = p * (1 + (rnd() - 0.45) * 0.012); h1.push({ t: d1.t[399] - (110 - i) * 3600e3, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: 100 + rnd() * 50 }); }
h1[h1.length - 1].c = price;
const all = levels.concat([{ name: '1d MA200', value: 0.0061, kind: 'major' }, { name: '1d EMA200', value: 0.0055, kind: 'major' }]).map(x => ({ ...x, dist: (price - x.value) / x.value * 100 }));
const png = chart.renderChart({ symbol: '1000BONKUSDT', candles: h1, tf: '1h', level: null, levels: all, fibLeg: leg, subtitle: 'Kart 1' });
assert(png && png.length > 20000);
fs.writeFileSync(require('./_tmp') + '/chart-daily.png', png);
console.log('\n✅ Günlük geniş Fib (tepe 0.0134 → dip 0.00222, 0.236 = ' + f236.toPrecision(4) + ' — kırmızı bölgenin içinde); eski destek → direnç bölgesi ' + z.touches + ' temasla; düşen trend çizgisi bugün ' + tl.value.toPrecision(4) + '; grafik çizildi (chart-daily.png)');
