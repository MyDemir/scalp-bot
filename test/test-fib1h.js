'use strict';
// 1 saatlik geniş Fib bacağı: son 2 haftanın tepe ↔ dip, yön otomatik; grafik bacağın başından çizilir
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const L = require(`${REPO}/src/levels`); const chart = require(`${REPO}/src/chart`);
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const H = 3600e3, t0 = Date.UTC(2026, 8, 16);
// 336 mum: 0–150 yükseliş (0.030 → 0.040 tepe), 150–300 düşüş (→ 0.029 dip), 300–335 tepki (→ 0.0335)
const key = [[0, 0.030], [150, 0.040], [300, 0.029], [335, 0.0335]];
const cs = [];
for (let k = 0; k < key.length - 1; k++) {
  const [i0, v0] = key[k], [i1, v1] = key[k + 1];
  for (let i = i0; i < i1; i++) { const p = v0 + (v1 - v0) * (i - i0) / (i1 - i0); cs.push(p * (1 + (rnd() - 0.5) * 0.006)); }
}
cs.push(0.0335);
const candles = cs.map((c, i) => { const o = i ? cs[i - 1] : c; const pk = i === 150 ? 0.0402 : null, dp = i === 300 ? 0.0288 : null;
  return { t: t0 + i * H, o, c, h: pk || Math.max(o, c) * (1 + rnd() * 0.003), l: dp || Math.min(o, c) * (1 - rnd() * 0.003), v: 100 + rnd() * 80 }; });
const h1 = { t: candles.map(k => k.t), h: candles.map(k => k.h), l: candles.map(k => k.l) };
const { levels, leg } = L.calcExtraLevels({ h1, h4: { h: [] }, d1: { t: [], h: [], l: [], c: [] } }, { swing: false, fib: true, bars: 3 }, []);
assert(leg && !leg.up && leg.hi === 0.0402 && leg.lo === 0.0288 && leg.hiT === t0 + 150 * H && leg.loT === t0 + 300 * H, JSON.stringify(leg));
const f382 = 0.0288 + 0.382 * (0.0402 - 0.0288);
const fl = levels.find(x => x.name === 'Fib 0.382');
assert(fl && Math.abs(fl.value - f382) < 1e-9, 'Fib 0.382 (düşüş bacağında dipten yukarı): ' + JSON.stringify(fl));
const png = chart.renderChart({ symbol: 'NIGHTUSDT', candles, tf: '1h', levels: [], fibLeg: leg, subtitle: 'Kart 2' });
assert(png && png.length > 20000);
fs.writeFileSync(require('./_tmp') + '/chart-fib1h.png', png);
console.log(`✅ 1s geniş Fib: tepe 0.0402 (16.09+150s) → dip 0.0288 (+300s), düşüş bacağı; 0.382 = ${f382.toFixed(5)} dipten yukarı (direnç); grafik bacağın başından (190 mum) çizildi → chart-fib1h.png`);
