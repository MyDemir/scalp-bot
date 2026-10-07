// Fibonacci bacak seçimi: eski büyük tepe → düşüş → yeni pompa. Bacak = pompanın dibi → pompanın tepesi olmalı.
const chart = require(__dirname + '/../src/chart');
const H = 3600e3; const cs = []; let p = 100;
const push = (dp) => { const o = p; p *= 1 + dp; cs.push({ t: Date.UTC(2026, 0, 1) + cs.length * H, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 100 }); };
for (let i = 0; i < 20; i++) push(0.01);     // eski yükseliş → eski tepe ~122
for (let i = 0; i < 50; i++) push(-0.008);   // düşüş → dip ~82
for (let i = 0; i < 60; i++) push(0.005);    // yeni pompa → ~110
const png = chart.renderChart({ symbol: 'FIBTEST', candles: cs, tf: '1h', show: 120, showIchi: false });
require('fs').writeFileSync(require('./_tmp') + '/fib.png', png); console.log('ok');
