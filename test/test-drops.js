'use strict';
// Düşüş defteri: pompa tepesi → 15 dk'da ≥ %1.5 düşüş (kartlı/kartsız), göstergeler, sonrası pencereleri, bekleme,
// kayıt (events tablosu), /kacan metni, CSV dışa aktarma
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createDropLedger, dropText, teyitText, teyitRows, FEATURE_COLS, toCsv, flatDrop, dropCols } = require(`${REPO}/src/eventLog`);
const { createCardStore } = require(`${REPO}/src/cardStore`);
const { buildExports } = require(`${REPO}/src/exportData`);
const { toPlain } = require(`${REPO}/src/infoCard`);
const MIN = 60e3; const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);
const t0 = Date.UTC(2026, 0, 1);

// Geçmiş: 3000 dk ~100 civarı yatay (hafif dalga)
const hist = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i / 9) * 0.15);
const candle = (i, c, o, hOver) => ({ t: t0 + i * MIN, o, h: hOver ?? Math.max(o, c) * 1.0004, l: Math.min(o, c) * 0.9996, c, v: 100, tb: 55, q: 100 * c, tq: 55 * c, closed: true });
const drops = ev => ev.filter(e => e.outcome === 'düştü');
function run(livePath, { overrides = {}, cards = [], opts = {}, ctx = {} } = {}) {
  const all = [...hist, ...livePath];
  const m1 = all.map((c, i) => candle(i, c, i ? all[i - 1] : c, overrides[i - hist.length]));
  const S = new Series('DROPUSDT');
  const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
    if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; };
  const T0 = m1[hist.length].t;
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const L = createDropLedger({ ...cfg.events, ...opts }); const ev = [];
  for (const c of m1.filter(c => c.t >= T0)) {
    S.apply1m(c);
    for (const k of cards) if (k.t === c.t + MIN) L.noteCard('DROPUSDT', k.t, k.grade);
    ev.push(...L.observe(S, s, ctx));
  }
  return { ev, L, m1, base: hist.length };
}
const seg = (from, to, n) => Array.from({ length: n }, (_, k) => from + (to - from) * (k + 1) / n);

(async () => {
// ── 1) Pompa (+%6, 40 dk) → tepe 106.3 → 8 dk'da −%2 → yatay ──
const pump = [...seg(100, 100, 60), ...seg(100, 106, 40)];
const peakIdx = pump.length;                      // tepe mumu
const path1 = [...pump, 105.9, ...seg(105.9, 104.2, 8), ...seg(104.2, 104.5, 260)];
const ov = { [peakIdx]: 106.3 };
let { ev } = run(path1, { overrides: ov });
assert.strictEqual(drops(ev).length, 1, 'tek düşüş: ' + ev.map(x => x.outcome).join(','));
assert(ev.every(x => ['düştü', 'devam', 'yatay'].includes(x.outcome)), 'sonuçlar');
const dv = ev.filter(x => x.outcome === 'devam').sort((a, b) => a.t - b.t);
assert(dv.length >= 3 && dv.every((x, i) => i === 0 || x.t - dv[i - 1].t >= 5 * MIN), 'pompa boyunca devam örnekleri (en fazla 5 dk\'da bir): ' + dv.length);
assert(dv.every(x => x.out[15].high > 0), 'devam = önce daha yüksek tepe');
let e = drops(ev)[0];
assert.strictEqual(e.price, 106.3);
assert.strictEqual(e.t, t0 + (hist.length + peakIdx) * MIN + MIN, 'tepe = tepe mumunun kapanışı');
assert(e.dropMin >= 2 && e.dropMin <= 8, 'düşüşe kadar dk: ' + e.dropMin);
assert(!e.card && e.cardGrade == null);
for (const w of [5, 15, 60, 240]) assert(e.out[w] && e.out[w].low < 0 && Number.isFinite(e.out[w].close), 'pencere ' + w);
assert(e.out[15].low <= -1.5 && e.out[240].close < -1.5);
assert(Math.abs(e.feat.pumpPct - 6.3) < 0.4 && e.feat.pumpMin >= 40, 'pompa: ' + e.feat.pumpPct + ' / ' + e.feat.pumpMin + ' dk');
assert(e.feat.rsi3 > 80 && e.feat.rsi5 > 80 && e.feat.rsi15 > 70, 'tepe RSI: ' + [e.feat.rsi3, e.feat.rsi5, e.feat.rsi15]);
assert(e.feat.sep3 > 1 && e.feat.sep15 > e.feat.sep3 * 0.5 && typeof e.feat.fails === 'string' && Number.isFinite(e.feat.atr5Pct));
assert.deepStrictEqual(Object.keys(e.feat).sort(), [...FEATURE_COLS].sort(), 'özellik sütunları: ' + FEATURE_COLS.filter(k => !(k in e.feat)).join(','));
for (const tf of ['1m', '3m', '5m', '15m', '1h']) assert(Number.isFinite(e.feat[`rsi_${tf}`]) && Number.isFinite(e.feat[`ema21_${tf}`]) && Number.isFinite(e.feat[`atr_${tf}`]), 'tf göstergeleri ' + tf);
assert(e.feat.rsi_1m > 80 && e.feat.ema21_1m > 0, '1m RSI/EMA tepede');
assert(Number.isFinite(e.feat.vwD_sig) && e.feat.vwD_pct > 0 && Number.isFinite(e.feat.vw90_pct) && Number.isFinite(e.feat.avwLow_pct) && e.feat.avwLow_pct > 2, 'VWAP seti: ' + JSON.stringify({ D: e.feat.vwD_pct, W: e.feat.vwW_pct, M: e.feat.vwM_pct, a: e.feat.avwLow_pct }));
assert('pkLvTouches' in e.feat && 'trLvTouches' in e.feat, 'seviye gücü sütunları');
assert(e.feat.outcome === 'düştü' && e.feat.upBeforeDrop >= 0 && e.feat.t1 != null && e.feat.t1 <= e.dropMin && e.feat.t2 != null, 'sonuç alanları: ' + JSON.stringify({ up: e.feat.upBeforeDrop, t1: e.feat.t1, t2: e.feat.t2, t3: e.feat.t3 }));
assert(typeof e.feat.c5Red === 'boolean' && Number.isFinite(e.feat.c5ClosePct) && Number.isFinite(e.feat.c5Next60Low), '5dk teyit mumu: ' + JSON.stringify({ r: e.feat.c5Red, c: e.feat.c5ClosePct, n: e.feat.c5Next60Low }));
assert(Number.isFinite(e.feat.cvdNet15) && typeof e.feat.cvdDiv === 'boolean' && Number.isFinite(e.feat.wick_5m) && Number.isFinite(e.feat.bbB_5m) && e.feat.bbB_5m > 0.5, 'CVD / mum / Bollinger');
assert(Number.isFinite(e.feat.spd15) && Number.isFinite(e.feat.volTrend15) && Number.isFinite(e.feat.hourTR) && ['Asya', 'Avrupa', 'ABD', 'Gece'].includes(e.feat.session) && e.feat.dow >= 1 && e.feat.dow <= 7, 'hız / hacim / zaman');
assert(e.feat.samples24h >= 3 && e.feat.drops24h === 0 && e.feat.lastOutcome === 'devam', 'coin geçmişi: ' + JSON.stringify({ s: e.feat.samples24h, d: e.feat.drops24h, l: e.feat.lastOutcome }));
assert(typeof e.feat.pkNear === 'string' && (e.feat.pkLv == null || Math.abs(e.feat.pkLvDist) <= 0.3), 'tepki seviyesi');
assert(e.feat.trPct < -1.5 && e.feat.trMin > 0 && e.feat.trMin <= 60 && !e.feat.trFalling && typeof e.feat.trNear === 'string', 'dip: ' + JSON.stringify({ trPct: e.feat.trPct, trMin: e.feat.trMin, trLv: e.feat.trLv, trEma: e.feat.trEma }));
console.log('olay:', JSON.stringify({ ...e, feat: Object.fromEntries(Object.entries(e.feat).slice(0, 22)) }));
ok(`Tepe/dip: 1m–4h göstergeleri (RSI 1m ${e.feat.rsi_1m}, 4h ${e.feat.rsi_4h}), VWAP gün ${e.feat.vwD_sig}σ / pompa dibi VWAP +%${e.feat.avwLow_pct}, tepki "${e.feat.pkLv ?? 'yok'}", dip %${e.feat.trPct} (${e.feat.trMin}. dk) "${e.feat.trLv ?? 'yok'}" · EMA21: ${e.feat.trEma}`);
ok(`Pompa +%${e.feat.pumpPct} (${e.feat.pumpMin} dk) → tepe 106.3, ${e.dropMin}. dk'da −%1.5; tepe anı RSI 3/5/15dk ${e.feat.rsi3}/${e.feat.rsi5}/${e.feat.rsi15}, EMA21 3dk +%${e.feat.sep3}, eksik şart "${e.feat.fails || '—'}"; sonrası 5/15/60/240 dk (240 dk kapanış %${e.out[240].close}); ${FEATURE_COLS.length} gösterge sütunu`);

// ── 2) Kart tepeden 3 dk önce → kartlı ──
const peakT = e.t;
({ ev } = run(path1, { overrides: ov, cards: [{ t: peakT - 3 * MIN, grade: 3 }] }));
assert(drops(ev).length === 1 && drops(ev)[0].card && drops(ev)[0].cardGrade === 3);
({ ev } = run(path1, { overrides: ov, cards: [{ t: peakT - 40 * MIN, grade: 2 }] }));
assert(drops(ev).length === 1 && !drops(ev)[0].card, '15 dk penceresi dışındaki kart sayılmaz');
ok('Kartlı: tepeden 3 dk önceki kart (derece 3) eşleşti; 40 dk önceki kart sayılmadı');

// ── 3) Olay olmaması gerekenler ──
({ ev } = run([...seg(100, 100, 120), ...seg(100, 98, 6), ...seg(98, 98, 260)]));
assert.strictEqual(ev.length, 0, 'pompa yok → olay yok');
({ ev } = run([...pump, 105.9, ...seg(105.9, 105.2, 14), ...seg(105.2, 103, 20), ...seg(103, 103, 260)], { overrides: ov }));
assert.strictEqual(drops(ev).length, 0, 'düşüş 15 dk içinde %1.5 değil → düştü yok');
assert(ev.some(x => x.outcome === 'yatay' && x.price === 106.3), 'son tepe "yatay" olarak kaydedilir');
ok('Olay yok: pompasız %2 düşüşte aday yok · tepeden 15 dk içinde %1.5 düşmeyen yavaş geri çekilme "yatay"');

// ── 4) İki düşüş art arda (bekleme yok — her tepe adayı ayrı) ──
const again = (gap) => [...pump, 105.9, ...seg(105.9, 104.2, 8), ...seg(104.2, 104, gap), ...seg(104, 108, 15), 107.8, ...seg(107.8, 105.5, 6), ...seg(105.5, 105.5, 260)];
({ ev } = run(again(15), { overrides: ov }));
assert.strictEqual(drops(ev).length, 2, 'iki düşüş: ' + ev.map(x => x.outcome).join(','));
assert(drops(ev)[1].feat.drops24h === 1 && drops(ev)[1].feat.minsSinceDrop > 0, 'ikinci tepede önceki düşüş geçmişte');
ok('İki ayrı tepe → iki "düştü" (bekleme yok); ikinci tepenin coin geçmişinde önceki düşüş var');

// ── 4b) Piyasa / baz / likidasyon / Binance ek verisi ──
{
  const enrichCalls = [], obCalls = [];
  const opts = {
    enrich: (sym, o) => { enrichCalls.push(o); return { oiChg15: -1.2, oiChg60: 4.5, oiUsd: 1e6, lsTopAcc: 1.1, lsTopPos: 1.6, lsGlobal: 2.0, takerLS: 0.8, spotPrem: 0.35, spotShare60: 0.15 }; },
    orderBook: () => { obCalls.push(1); return { obBid1: 0.35, obBid2: 0.4, obAsk1Usd: 5000, obBid1Usd: 2700 }; },
  };
  const ctx = { funding: () => ({ rate: 0.0003, next: null, mark: 100.2, index: 100 }), market: () => ({ breadth80: 12.5, pumping: 7, btc5: 0.1, btc15: -0.2, btcRsi15: 55 }),
    liq: (sym, t, q15) => ({ liqShort15: 50000, liqLong15: 0, liqShort60: 80000, liqLong60: 1000, liqShortPct15: 1.4 }) };
  const r = run(path1, { overrides: ov, opts, ctx });
  await new Promise(res => setImmediate(res));
  const x = drops(r.ev)[0];
  assert(x.feat.basisPct === 0.2 && x.feat.breadth80 === 12.5 && x.feat.pumping === 7 && x.feat.liqShortPct15 === 1.4 && x.feat.funding === 0.03, 'baz / piyasa / likidasyon');
  assert(x.feat.oiChg15 === -1.2 && x.feat.lsTopPos === 1.6 && x.feat.spotPrem === 0.35 && x.feat.obBid1 === 0.35, 'ek veri: ' + JSON.stringify({ oi: x.feat.oiChg15, ob: x.feat.obBid1 }));
  assert(enrichCalls.length === r.ev.length + r.L.openCount() && enrichCalls.every(o => Number.isFinite(o.t) && o.price > 0 && o.futQ60 > 0), 'ek veri yalnız KAYDEDİLEN adaylar için, tepe anına hizalı: ' + enrichCalls.length + ' / ' + r.ev.length + ' + açık ' + r.L.openCount());
  assert(r.ev.every(e => e.feat.oiChg15 === -1.2), 'biten her kayıtta ek veri');
  const ct = enrichCalls.map(o => o.t), ts = new Set(ct);
  assert(ts.size === ct.length, 'aynı tepe iki kez kaydedilmez');
  assert(obCalls.length >= 1 && obCalls.length <= path1.length, 'emir defteri coin başına dakikada en fazla 1: ' + obCalls.length);
  ok(`Ek veri: baz %${x.feat.basisPct}, piyasa (15m RSI≥80 %${x.feat.breadth80}, ${x.feat.pumping} pompa), short likidasyon %${x.feat.liqShortPct15}; açık pozisyon / long-short / spot ${enrichCalls.length} kayıtlı adaya tepe anına hizalı; emir defteri ${obCalls.length} kez`);
}

// ── 5) Kayıt + rapor + CSV ──
{
  ev = drops(run(path1, { overrides: ov }).ev);
  const kartli = drops(run(path1, { overrides: ov, cards: [{ t: peakT - 3 * MIN, grade: 3 }] }).ev)[0];
  const file = require('./_tmp') + '/drops-test.db'; for (const f of [file, file + '-wal', file + '-shm']) try { fs.unlinkSync(f); } catch { /* yok */ }
  const st = createCardStore({ file, logger: { log() {}, error: x => { throw new Error(x); } } });
  const now = Date.now();
  const rows = [
    { ...ev[0], id: 'a', t: now - 3600e3 }, { ...kartli, id: 'b', t: now - 7200e3 },
    { ...ev[0], id: 'c', t: now - 9000e3, feat: { ...ev[0].feat, fails: 'seviye', hits: 2, rsiOk: true } },
    { ...ev[0], id: 'd', t: now - 40 * 86400e3 },                                       // 7 günün dışında
  ];
  for (const r of rows) st.addEvent(r);
  st.addEvent(rows[0]);                                                               // aynı id → yok sayılır
  const back = st.eventsSince(now - 7 * 86400e3);
  assert.strictEqual(back.length, 3);
  const a = back.find(x => x.id === 'a');
  assert.deepStrictEqual(a.feat, ev[0].feat); assert.deepStrictEqual(a.out, ev[0].out);
  assert(a.price === 106.3 && a.dropMin === ev[0].dropMin && a.card === false && back.find(x => x.id === 'b').card === true);
  const txt = dropText(back, { title: 'son 7 gün · 3 düşüş', s });
  const plain = toPlain(txt);
  console.log('\n' + plain);
  assert(txt.includes('✅ Kartlı: 1 (%33)') && txt.includes('❌ Kartsız: 2 (%67)') && txt.includes('❓ <b>Kartsızlarda eksik şart</b>'));
  assert(txt.includes('▫️ Direnç yok (%2.5 içinde) — %50 (1)') && txt.includes('▫️ Şart vardı, kart çıkmadı* — %50 (1)'), 'eksik şart dağılımı');
  const t2 = dropText([{ ...rows[0], feat: { ...rows[0].feat, fails: 'rsi|seviye', hits: 1 } }], { s });
  assert(/RSI 85\+ \(3'te 2\) yok — %100 \(1\)/.test(t2) && t2.includes('1 → %100'), 'RSI eksik + dilim dağılımı');
  assert(txt.includes('<blockquote expandable>ℹ️ <b>Nasıl ölçülür</b>') && txt.length <= 4096);
  assert(txt.includes('🎯 <b>Tepe nereden tepki aldı</b>') && txt.includes('🛑 <b>Düşüş nerede durdu</b>') && txt.includes('📐 <b>Tepede VWAP</b>'), 'tepki / dip / VWAP bölümleri');
  const maxLine = Math.max(...txt.replace(/<blockquote[\s\S]*<\/blockquote>/, '').replace(/<[^>]+>/g, '').split('\n').map(l => [...l].length));
  assert(maxLine <= 42, 'telefon: satır ≤ 42 karakter, en uzun ' + maxLine);
  assert(dropText([], {}).includes('Kayıt yok'));
  // CSV
  const csv = toCsv(back.map(r => flatDrop(r)), dropCols());
  const lines = csv.trim().split('\n');
  assert(csv.startsWith('﻿') && lines.length === 4 && lines[0].replace('﻿', '').split(',').length === dropCols().length);
  assert(lines[0].includes('low240') && lines[0].includes('rsi15') && lines[0].includes('fails') && lines[0].includes('rsi_4h') && lines[0].includes('vwW_sig') && lines[0].includes('trLv'));
  st.addTouch({ id: 't1', symbol: 'DROPUSDT', t: now - 1000, name: 'Fib 0.786', kind: 'fib', value: 1, hits: 2, rsiOk: true, card: false, emaGap: 1, pb: 2, pbMin: 5, emaMin: 3, brokeMin: null, brokeAfterEma: false, held: false, up: 0.1, dn: -2, c60: -1, stop: '3dk EMA21', stopDepth: 0, falling: false });
  const ex = buildExports(st, 7);
  assert.deepStrictEqual(ex.map(f => [f.name, f.n]), [['tepeler.csv', 3], ['kartlar.csv', 0], ['temaslar.csv', 1]]);
  assert(ex[2].csv.includes('stop') && ex[2].csv.includes('3dk EMA21'));
  st.close();
  ok(`Kayıt: events tablosuna yazıldı/okundu (göstergeler + 4 pencere birebir, tekrar id yok, 7 gün süzgeci); /kacan: kartlı/kartsız, eksik şart dağılımı, kartlı/kartsız karşılaştırma, tanımlar açılır blokta, satır ≤ ${maxLine}; CSV: ${dropCols().length} sütun, BOM'lu; dışa aktarma 3 dosya`);
}

// ── 6) /teyit: tüm adaylar (düştü/devam/yatay) üzerinde koşul karşılaştırması ──
{
  const all = [...run(path1, { overrides: ov }).ev, ...run(again(15), { overrides: ov }).ev];
  const T = teyitRows(all, 1);
  assert(Array.isArray(T) && T.length > 0, 'teyit satırları');
  const txt = teyitText(all, { title: 'test', minN: 1 });
  console.log('\n' + toPlain(txt));
  assert(txt.includes('aday') && txt.includes('Nasıl okunur') && txt.length <= 4096, 'teyit metni');
  const maxLine = Math.max(...txt.replace(/<blockquote[\s\S]*<\/blockquote>/, '').replace(/<[^>]+>/g, '').split('\n').map(l => [...l].length));
  assert(maxLine <= 42, 'teyit satır ≤ 42: ' + maxLine + ' ' + txt.replace(/<blockquote[\s\S]*<\/blockquote>/, '').replace(/<[^>]+>/g, '').split('\n').filter(l => [...l].length > 42).join(' / '));
  assert(teyitText([], {}).length > 0);
  ok(`/teyit: ${all.length} aday (${drops(all).length} düştü), ${T.length} koşul karşılaştırıldı, satır ≤ ${maxLine}`);
}

console.log('\n' + R.join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
