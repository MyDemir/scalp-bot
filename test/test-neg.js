const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const { Series } = require(`${REPO}/src/series`); const eng = require(`${REPO}/src/infoEngine`); const ta = require(`${REPO}/src/ta`);
const MIN = 60e3, t0 = Date.UTC(2026, 0, 1);
function mk(closes) { return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: t0 + i * MIN, o, h: Math.max(o, c) * 1.0002, l: Math.min(o, c) * 0.9998, c, v: 100, tb: 50, q: 1e4, tq: 5e3, closed: true }; }); }
// 40 mum yavaş yükseliş, sonra 3 dalga: her tepe biraz daha yüksek ama arada daha derin geri çekilme → RSI tepeleri düşer
const cl = []; let p = 100; for (let i = 0; i < 40; i++) cl.push(p *= 1.002);
const wave = (up, n, down, m) => { for (let i = 0; i < n; i++) cl.push(p *= 1 + up); for (let i = 0; i < m; i++) cl.push(p *= 1 - down); };
wave(0.008, 6, 0.006, 4);   // tepe 1 (güçlü)
wave(0.0065, 4, 0.006, 3);  // tepe 2: +%2.6 − %1.8 → biraz daha yüksek, daha zayıf
wave(0.005, 4, 0.005, 3);   // tepe 3
wave(0.004, 4, 0.002, 1);   // tepe 4 (son, taze)
const S = new Series('N'); S.seed('1m', mk(cl));
const r = eng.negPeaks(S, '1m');
// bağımsız kontrol: pivotlar ve RSI
const h = S.col('1m', 'h', false), c = S.col('1m', 'c', false); const rs = ta.rsiSeries(c, 14), off = c.length - rs.length;
const piv = []; for (let i = c.length - 40; i < c.length - 1; i++) if (h[i] > h[i - 1] && h[i] >= h[i + 1]) piv.push([i, h[i].toFixed(3), rs[i - off].toFixed(1)]);
console.log('pivotlar', JSON.stringify(piv), '→', JSON.stringify(r));
assert(r.count >= 2, 'negatif tepe bekleniyordu');
// kontrol: güçlenen yükseliş (her dalga daha güçlü) → 0
const cl2 = []; p = 100; for (let i = 0; i < 40; i++) cl2.push(p *= 1.001);
const w2 = (up, n, down, m) => { for (let i = 0; i < n; i++) cl2.push(p *= 1 + up); for (let i = 0; i < m; i++) cl2.push(p *= 1 - down); };
w2(0.002, 3, 0.003, 3); w2(0.004, 4, 0.002, 2); w2(0.007, 5, 0.001, 1);
const S2 = new Series('M'); S2.seed('1m', mk(cl2));
const r2 = eng.negPeaks(S2, '1m'); console.log('güçlenen:', JSON.stringify(r2)); assert.strictEqual(r2.count, 0);
console.log('✅ Negatif tepe: zayıflayan dalgalarda', r.count, 'ardışık negatif tepe; güçlenen yükselişte 0');
