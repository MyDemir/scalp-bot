'use strict';
// Destek teması (src/supportTouch.js): desteğe üstten temas → kayıt, held / brokeMin / aboveMin / rally, 60 dk bekleme,
// look-ahead yok, cards.db `stouches`, haftalık destekler.csv (zip bölme dahil), /disaaktar
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createSupportTouches, stouchRow, STOUCH_COLS, STOUCH_SNAP_COLS } = require(`${REPO}/src/supportTouch`);
const { createCardStore } = require(`${REPO}/src/cardStore`);
const W = require(`${REPO}/src/weeklyReport`); const { buildExports } = require(`${REPO}/src/exportData`);
const unzip = require('./unzip');
const MIN = 60e3; const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);
const t0 = Date.UTC(2026, 0, 1);
const seg = (from, to, n) => Array.from({ length: n }, (_, k) => from + (to - from) * (k + 1) / n);

// Geçmiş: ~100 yatay, 2000. dk civarında 97'ye V dip (1h swing dibi = destek)
const hist = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i / 9) * 0.15);
for (let i = 0; i < 240; i++) hist[1880 + i] = i < 120 ? 100 - 3 * (i + 1) / 120 : 97 + 3 * (i - 119) / 120;
const candle = (i, c, o, ov = {}) => ({ t: t0 + i * MIN, o, h: ov.h ?? Math.max(o, c) * 1.0004, l: ov.l ?? Math.min(o, c) * 0.9996, c, v: 100, tb: 50, q: 100 * c, tq: 50 * c, closed: true });
function run(livePath, { overrides = {}, opts = {}, ctx = {}, cards = [] } = {}) {
  const all = [...hist, ...livePath];
  const m1 = all.map((c, i) => candle(i, c, i ? all[i - 1] : c, overrides[i - hist.length]));
  const S = new Series('SUPUSDT');
  const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
    if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; };
  const T0 = m1[hist.length].t;
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const T = createSupportTouches(opts); const ev = [];
  for (const c of m1.filter(c => c.t >= T0)) {
    const closed = S.apply1m(c);
    for (const k of cards) if (k.t === c.t + MIN) T.noteCard('SUPUSDT', k.t);
    ev.push(...T.observe(S, closed, s, ctx));
  }
  return { ev, T, m1, base: hist.length };
}
const near97 = ev => ev.filter(e => Math.abs(e.value - 97) / 97 < 0.006);

(async () => {
// ── 1) Tutunan temas (iğne altına, üstünde kapanış → aboveMin 0), sonra yükseliş ──
const lead = [...seg(100, 100, 30), ...seg(100, 97.6, 30)];
const tIdx = lead.length;
const pathA = [...lead, 97.4, ...seg(97.4, 99.5, 20), ...seg(99.5, 99.4, 80)];
const ovA = { [tIdx]: { l: 96.7 } };
const rA = run(pathA, { overrides: ovA, opts: { dipNear: (sym, t, w) => sym === 'SUPUSDT' && w === 5 } });
const A = near97(rA.ev);
assert(A.length >= 1, 'destek teması: ' + rA.ev.map(e => `${e.name}@${e.value}`).join(', '));
const a = A[0];
assert(a.name && a.kind && Number.isFinite(a.value) && Number.isInteger(a.lvTouches), 'seviye adı/tür/değer/lvTouches dolu: ' + JSON.stringify([a.name, a.kind, a.value, a.lvTouches]));
assert.strictEqual(a.t, t0 + (hist.length + tIdx) * MIN + MIN, 'temas = temas mumunun kapanışı');
assert(a.value < 97.4 && a.aboveMin === 0 && a.held === true && a.brokeMin === null, 'tutundu: ' + JSON.stringify({ above: a.aboveMin, held: a.held, broke: a.brokeMin }));
assert(Math.abs(a.wick0 - (97.4 - 96.7) / 96.7 * 100) < 1e-3, 'wick0: ' + a.wick0);
assert(a.rally > 2 && a.rallyMin > 0 && a.rallyMin <= 60 && a.up > 2 && a.dn < 0 && a.c60 > 2, 'rally/up/dn/c60: ' + JSON.stringify({ r: a.rally, m: a.rallyMin, up: a.up, dn: a.dn, c60: a.c60 }));
assert(a.up5 != null && a.c15 != null && a.dn30 != null && a.up5 <= a.up15 && a.up15 <= a.up30 && a.up30 <= a.up, 'kısa pencereler');
assert(Number.isFinite(a.rsi3) && Number.isFinite(a.rsi5) && Number.isFinite(a.rsi15) && Number.isFinite(a.emaGap) && a.dip === true && a.card === false, 'temas anı RSI/EMA, dip ±5 dk');
for (const k of STOUCH_SNAP_COLS) assert(k in a, 'fotoğraf alanı: ' + k);
assert(Number.isFinite(a.rsi_1m) && Number.isFinite(a.vwD_sig) && Number.isFinite(a.bbB_5m) && Number.isFinite(a.cvdNet15) && Number.isFinite(a.q24h) && a.avwLow_pct === null, 'orta boy fotoğraf');
const m = rA.m1, i0 = rA.base + tIdx;
const hi60 = Math.max(...m.slice(i0, i0 + 61).map(c => c.h));
assert(Math.abs(a.up - (hi60 - a.value) / a.value * 100) < 1e-3, 'up = 60 dk en yüksek (temas mumu dahil)');
ok(`Tutunan temas: "${a.name}" (${a.kind}, ${a.value}, ${a.lvTouches} test) · iğne altına, üstte kapanış → aboveMin 0, wick0 %${a.wick0}, rally %${a.rally} (${a.rallyMin}. dk), held, brokeMin yok; ${STOUCH_SNAP_COLS.length} fotoğraf alanı`);

// ── 2) Kırılan temas: 5m kapanış seviyenin %0.3 altında → brokeMin, held false; altında kapanıp üstüne dönmedi → aboveMin boş ──
{
  const r = run([...lead, 96.6, ...seg(96.6, 95, 20), ...seg(95, 95, 80)], { overrides: { [tIdx]: { l: 96.5 } } });
  const x = near97(r.ev)[0];
  assert(x && x.brokeMin != null && x.brokeMin > 0 && x.brokeMin <= 25 && x.held === false && x.aboveMin === null && x.c60 < -1.5, 'kırıldı: ' + JSON.stringify(x && { b: x.brokeMin, h: x.held, a: x.aboveMin }));
  assert(x.dip === null, 'dipNear verilmezse dip boş');
  ok(`Kırılan temas: brokeMin ${x.brokeMin}. dk (5dk kapanış %0.3 altında), held=false, aboveMin boş, c60 %${x.c60}`);
}
// ── 3) Süpürme: seviyenin altında kapandı, 3. dk'da üstünde kapanış → aboveMin 3 ──
let rC;
{
  const v = a.value;
  rC = run([...lead, v * 0.998, v * 0.997, v * 0.998, v * 1.004, ...seg(v * 1.004, v * 1.02, 20), ...seg(v * 1.02, v * 1.02, 80)], { overrides: { [tIdx]: { l: v * 0.997 } } });
  const x = rC.ev.find(e => e.value === v);
  assert(x && x.aboveMin === 3 && x.held === true, 'süpürme: ' + JSON.stringify(x && { a: x.aboveMin, h: x.held }));
  ok(`Süpürme: seviyenin altında kapanış, ${x.aboveMin}. dk'da üstüne döndü (aboveMin), 60. dk üstte`);
}
// ── 4) Aynı seviye 60 dk içinde tekrar yazılmaz; 60 dk sonra yeni temas yazılır ──
{
  const back = [...seg(97.4, 99, 10), ...seg(99, 97.15, 10)];
  const r = run([...lead, 97.4, ...back, ...seg(97.15, 99, 50), ...seg(99, 97.15, 10), ...seg(97.15, 99, 80)], { overrides: { [tIdx]: { l: 97.1 } } });
  const xs = r.ev.filter(e => e.value === a.value);
  assert.strictEqual(xs.length, 2, 'iki temas (biri 60 dk bekleme içinde atlandı): ' + xs.map(e => (e.t - xs[0].t) / MIN).join(','));
  assert(xs[1].t - xs[0].t >= 60 * MIN);
  ok(`Bekleme: aynı seviyeye 20. dk'daki ikinci temas yazılmadı; ${(xs[1].t - xs[0].t) / MIN}. dk'daki yazıldı`);
}
// ── 5) Look-ahead yok: aynı temasta farklı gelecek → temas anı alanları aynı ──
{
  const rB = run([...lead, 97.4, ...seg(97.4, 94, 20), ...seg(94, 94, 80)], { overrides: ovA });
  const b = rB.ev.find(e => e.value === a.value);
  const OUT = new Set(['aboveMin', 'brokeMin', 'held', 'rally', 'rallyMin', 'up', 'dn', 'c60', 'up5', 'dn5', 'c5', 'up15', 'dn15', 'c15', 'up30', 'dn30', 'c30', 'dip']);
  const snap = x => Object.fromEntries(Object.entries(x).filter(([k]) => !OUT.has(k)));
  assert(b && b.held !== a.held, 'farklı gelecek');
  assert.deepStrictEqual(snap(b), snap(a), 'temas anı alanları gelecekten bağımsız');
  ok(`Look-ahead yok: tutunan / kırılan iki gelecekte temas anı alanları (${Object.keys(snap(a)).length}) birebir aynı`);
}
// ── 6) Kart ±5 dk ──
{
  const r = run(pathA, { overrides: ovA, cards: [{ t: a.t + 2 * MIN }] });
  assert.strictEqual(r.ev.find(e => e.value === a.value).card, true);
  ok('Kart: temastan 2 dk sonraki kart card=1');
}

// ── 7) cards.db stouches + haftalık destekler.csv (zip bölme) + /disaaktar + silme ──
const dir = require('./_tmp') + '/stouch-tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const now = Date.UTC(2026, 9, 5, 0, 2), D = 86_400_000;
{
  const st = createCardStore({ file: dir + '/cards.db', logger: { log() {}, error: x => { throw new Error(x); } } });
  const N = 3000;
  st.addSTouch({ ...a, id: 'OLD', t: now - 61 * D });
  // gerçekçi sıkıştırma için sayısal alanlar satır satır farklı (aynı basamak sayısı)
  const rnd = () => Object.fromEntries(Object.entries(a).filter(([k, v]) => typeof v === 'number' && !['t', 'value', 'lvTouches'].includes(k)).map(([k, v]) => [k, +(v * (0.5 + Math.random())).toFixed(3)]));
  for (let k = 0; k < N; k++) st.addSTouch({ ...a, ...rnd(), id: 'S' + k, t: now - 3 * D + k * 20e3, name: ['Fib 0.618', '1h dip', 'Günlük VWAP −1σ'][k % 3] });
  st.addSTouch({ ...a, id: 'S0', t: now - 3 * D });   // tekrar
  st.addSTouch({ ...a, id: 'EXACT', t: now - 3 * D - MIN });
  let back = null; await st.forEachSTouch({}, r => { if (r.id === 'EXACT') back = r; });
  assert.strictEqual(JSON.stringify(stouchRow(back)), JSON.stringify(stouchRow({ ...a, id: back.id, t: back.t })), 'DB\'den okunan satır CSV\'de aynı');
  st.sweep(now);
  assert.strictEqual(await st.forEachSTouch({}, () => {}), N + 1, '61 günlük temas budandı, tekrar id yok');
  const jsonBytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => STOUCH_SNAP_COLS.includes(k) || ['rsi3', 'rsi5', 'rsi15', 'emaGap', 'funding', 'btc1h'].includes(k)))));
  const csvBytes = Buffer.byteLength(require(`${REPO}/src/eventLog`).csvLine(stouchRow(a), STOUCH_COLS));
  const w = await W.buildWeekly(st, { now, s: cfg.info, E: cfg.events, maxZipBytes: 1e5 });
  assert(w.files.length > 1 && w.files[1].name.endsWith('-2.zip'), 'zip bölündü: ' + w.files.map(f => f.name + ' ' + f.buf.length).join(', '));
  let n = 0, heads = new Set();
  for (const f of w.files) for (const [k, v] of Object.entries(unzip(f.buf))) if (k.startsWith('destekler')) { const L = v.replace('﻿', '').trim().split('\n'); heads.add(L[0]); n += L.length - 1; }
  assert.strictEqual(n, N + 1, 'tüm temaslar zip parçalarında'); assert.deepStrictEqual([...heads], [STOUCH_COLS.join(',')], 'her parçada aynı başlık');
  assert.strictEqual(w.stouches, N + 1); assert(w.md.includes(`Destek teması: ${N + 1}`) && w.md.includes('- destekler.csv:'));
  const ex = await buildExports(st, 7, now, { supports: true });
  assert.strictEqual(ex.counts.destekler, N + 1);
  assert.strictEqual((await buildExports(st, 7, now)).counts.destekler, undefined, 'varsayılan (/disaaktar): destekler.csv yok');
  const zipBytes = w.files.reduce((x, f) => x + f.buf.length, 0);
  const pr = st.purgeBefore(now - 3 * D + 1500 * 20e3);
  assert.strictEqual(pr.stouches, 1501); assert.strictEqual(await st.forEachSTouch({}, () => {}), N - 1500);
  const errs = []; const st3 = createCardStore({ file: dir + '/err.db', logger: { log() {}, error: x => errs.push(x) } });
  st3.addSTouch({ id: 'X', symbol: 'A', t: 1, name: 'n', value: {} }); assert(errs.some(x => x.includes('[DESTEK]'))); st3.close();
  st.close();
  console.log(`satır başı: JSON (fotoğraf) ${jsonBytes} B · CSV ${csvBytes} B · ${STOUCH_COLS.length} kolon · ${N + 1} satır zip toplamı ${zipBytes} B`);
  ok(`cards.db stouches: ${N} satır (500'lük parça), tekrar yok, 60 gün budama; haftalık destekler.csv ${w.files.length} zip parçasına bölündü (sınır 100 KB, -2.zip), satırlar tam; /disaaktar; purgeBefore stouches'u siler; hata [DESTEK] ile loglanır · satır JSON ~${jsonBytes} B, CSV ~${csvBytes} B`);
}

console.log('\n' + R.join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
