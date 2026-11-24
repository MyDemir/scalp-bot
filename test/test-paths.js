'use strict';
// Tepe sonrası 1m yolu: eventLog onPath toplama, cards.db `paths` tablosu (60 gün budama, purgeBefore'a dahil değil), yollar.csv (haftalık + /disaaktar)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createDropLedger } = require(`${REPO}/src/eventLog`);
const { createCardStore, PATH_COLS } = require(`${REPO}/src/cardStore`);
const W = require(`${REPO}/src/weeklyReport`); const { buildExports } = require(`${REPO}/src/exportData`);
const unzip = require('./unzip');
const MIN = 60e3, DAY = 86_400_000; const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);
const t0 = Date.UTC(2026, 0, 1);
const hist = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i / 9) * 0.15);
const candle = (i, c, o, hOver) => ({ t: t0 + i * MIN, o, h: hOver ?? Math.max(o, c) * 1.0004, l: Math.min(o, c) * 0.9996, c, v: 100, tb: 55, q: 100 * c, tq: 55 * c, closed: true });
function run(livePath, { overrides = {}, opts = {} } = {}) {
  const all = [...hist, ...livePath];
  const m1 = all.map((c, i) => candle(i, c, i ? all[i - 1] : c, overrides[i - hist.length]));
  const S = new Series('DROPUSDT');
  const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
    if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; };
  const T0 = m1[hist.length].t;
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const L = createDropLedger({ ...cfg.events, ...opts }); const ev = [];
  for (const c of m1.filter(c => c.t >= T0)) { S.apply1m(c); ev.push(...L.observe(S, s, {})); }
  return { ev, m1 };
}
const seg = (from, to, n) => Array.from({ length: n }, (_, k) => from + (to - from) * (k + 1) / n);
const pump = [...seg(100, 100, 60), ...seg(100, 106, 40)];
const peakIdx = pump.length;
const path1 = [...pump, 105.9, ...seg(105.9, 104.2, 8), ...seg(104.2, 104.5, 260)];
const ov = { [peakIdx]: 106.3 };

(async () => {
// (a) 15 dk sonra yol tam ve girişe (tepe anı 1dk kapanışı) göre
const got = [];
const { ev, m1 } = run(path1, { overrides: ov, opts: { onPath: r => got.push(r) } });
const e = ev.find(x => x.outcome === 'düştü');
const p = got.find(r => r.id === e.id);
assert(p, 'düşüş adayının yolu verildi'); assert.strictEqual(p.n, 15); assert.strictEqual(p.buf.length, 45);
assert.strictEqual(p.t, e.t); assert.strictEqual(p.symbol, 'DROPUSDT');
const pk = m1[hist.length + peakIdx];
assert.strictEqual(p.entry, e.feat.price);
assert(Math.abs(p.entry - pk.c) < 1e-9 && p.entry !== e.price, `giriş = 1dk kapanış (${p.entry}) ≠ tepe (${e.price})`);
for (let k = 1; k <= 15; k++) {
  const c = m1[hist.length + peakIdx + k], en = pk.c;
  for (const [j, v] of [[0, c.h], [1, c.l], [2, c.c]]) assert(Math.abs(p.buf[(k - 1) * 3 + j] - (v - en) / en * 100) < 1e-3, `dk ${k} idx ${j}: ${p.buf[(k - 1) * 3 + j]}`);
}
assert(got.every(r => r.n <= 15) && new Set(got.map(r => r.id)).size === got.length, 'aday başına bir kez');
ok(`Yol: ${got.length} aday, düşüş adayı n=15, giriş ${p.entry.toFixed(3)} (tepe ${e.price}), değerler girişe göre`);

// (b) onPath yok → toplama yok, olaylar aynı
const r2 = run(path1, { overrides: ov });
assert.strictEqual(r2.ev.length, ev.length);
assert.strictEqual(createDropLedger({ ...cfg.events }).E.onPath, undefined);
ok('onPath verilmezse toplama yok (aynı olaylar, geri çağrı yok)');

// (c) addPath + forEachPath + budama
const dir = require('./_tmp') + '/paths-tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const st = createCardStore({ file: dir + '/cards.db', logger: { log() {}, error: x => { throw new Error(x); } } });
const now = Date.UTC(2026, 9, 5, 0, 2);
const mk = (id, t, n = 15) => ({ id, symbol: 'AUSDT', t, entry: 2, n, buf: Float32Array.from({ length: n * 3 }, (_, i) => i / 10) });
for (let i = 0; i < 7; i++) st.addPath(mk('P' + i, now - 2 * DAY + i * MIN));
st.addPath(mk('P0', now));                       // aynı id: yok sayılır
st.addPath(mk('OLD', now - 61 * DAY));
st.addPath(mk('PART', now - 3 * DAY, 4));
const seen = []; const n = await st.forEachPath({ batch: 3 }, r => { seen.push(r); });
assert.strictEqual(n, 9); assert.strictEqual(seen.length, 9);
assert(seen.every(r => r.buf instanceof Float32Array && r.buf.length === r.n * 3) && Math.abs(seen[1].buf[7] - 0.7) < 1e-6);
assert.strictEqual(await st.forEachPath({ since: now - 2 * DAY, until: now - 2 * DAY + 3 * MIN }, () => {}), 3, 'since/until');

st.addEvent({ id: 'E1', symbol: 'AUSDT', t: now - 3 * DAY - MIN, price: 2, dropT: null, dropMin: null, card: false, cardGrade: null, feat: {}, out: {} });   // kapsam başlangıcı (from)
// (d) haftalık zip + dışa aktarma
const w = await W.buildWeekly(st, { now, s: cfg.info, E: cfg.events });
const Z = unzip(w.files.find(f => f.name.endsWith('.zip')).buf);
const lines = Z['yollar.csv'].replace(/^﻿/, '').trim().split('\n');
assert.strictEqual(lines[0], PATH_COLS.join(','));
assert(lines[0].startsWith('id,symbol,time,entry,n,h1,l1,c1,') && lines[0].endsWith(',h15,l15,c15'));
assert.strictEqual(lines.length, 1 + 9, 't < cutoff: 9 yolun hepsi (alt sınır yok)');
const part = lines.find(l => l.startsWith('PART,AUSDT,'));
assert(part && part.includes(',2,4,0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1,1.1,') && part.split(',').length === PATH_COLS.length, 'eksik yol: n=4, kalan boş');
assert(w.md.includes('yollar.csv'), 'MD sütun notu');
const x = await buildExports(st, 90, now);
const Zx = unzip(x.files[0].buf);
assert.strictEqual(Zx['yollar.csv'].trim().split('\n').length, 1 + 9); assert.strictEqual(x.counts.yollar, 9);
ok('Haftalık zip ve /disaaktar: yollar.csv başlığı + satırlar (eksik dakika boş)');

// 60 gün budaması (sweep akışı)
st.sweep(now);
const left = []; await st.forEachPath({}, r => { left.push(r.id); });
assert.strictEqual(left.length, 8); assert(!left.includes('OLD'), '61 günlük yol budandı');
ok('60 gün budaması: 61 günlük yol silindi, 8 kaldı');
// haftalık silme: purgeBefore paths'i de siler
const pr = st.purgeBefore(now - 2 * DAY + 3 * MIN);
assert.strictEqual(pr.paths, 4, 'silinen yol: PART + P0..P2');
assert.strictEqual(await st.forEachPath({}, () => {}), 4, 'kalan yol');
ok('purgeBefore paths tablosunu da siler (4 silindi, 4 kaldı)');
R.forEach(l => console.log(l));
st.close();
})().catch(err => { console.error(err); process.exit(1); });
