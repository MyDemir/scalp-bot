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
function run(livePath, { overrides = {}, cards = [], opts = {}, ctx = {}, sets = s, skip = [] } = {}) {
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
    if (skip.includes((c.t - T0) / MIN)) continue;     // 1m veri boşluğu (mum hiç gelmedi)
    S.apply1m(c);
    for (const k of cards) if (k.t === c.t + MIN) L.noteCard('DROPUSDT', k.t, k.grade);
    ev.push(...L.observe(S, sets, ctx));
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

// ── 4c) Yeni tepe adayı kancası (defter API'si; canlıda artık kullanılmıyor) ──
{
  const seen = [];
  const r = run(path1, { overrides: ov, opts: { onCandidate: (sr, e) => seen.push({ sym: sr.symbol, t: e.t, f: e.feat }) } });
  assert(seen.length >= r.ev.length && seen.every(x => x.sym === 'DROPUSDT' && Number.isFinite(x.f.wick_5m) && Number.isFinite(x.f.volx_3m) && typeof x.f.session === 'string'), 'aday kancası: ' + seen.length);
  const r2 = run(path1, { overrides: ov, opts: { onCandidate: () => { throw new Error('x'); } } });
  assert.strictEqual(drops(r2.ev).length, 1, 'kanca hatası defteri bozmaz');
  ok(`Aday kancası: ${seen.length} yeni tepe adayında çağrıldı, hatası defteri bozmuyor`);
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
  const ex = await buildExports(st, 7);
  assert.deepStrictEqual(ex.counts, { tepeler: 3, kartlar: 0, temaslar: 1 });
  assert.deepStrictEqual(ex.files.map(f => f.name), ['veri.zip']);
  const Z = require('./unzip')(ex.files[0].buf);
  assert.deepStrictEqual(Object.keys(Z), ['tepeler.csv', 'kartlar.csv', 'temaslar.csv']);
  assert(Z['temaslar.csv'].includes('stop') && Z['temaslar.csv'].includes('3dk EMA21') && Z['tepeler.csv'].trim().split('\n').length === 4);
  // /kacan büyük veri yolu: yalnız "düştü"ler sade biçimde + sayaçlar → aynı metin
  const slim = []; await st.forEachEvent({ since: now - 7 * 86400e3, outcome: 'düştü' }, r => slim.push(require(`${REPO}/src/eventLog`).slimDrop(r)));
  slim.sort((a, b) => a.t - b.t);
  assert.strictEqual(dropText(slim, { title: 'son 7 gün · 3 düşüş', s, counts: st.eventCounts({ since: now - 7 * 86400e3 }) }), txt, 'sade satırlarla /kacan metni aynı');
  st.close();
  ok(`Kayıt: events tablosuna yazıldı/okundu (göstergeler + 4 pencere birebir, tekrar id yok, 7 gün süzgeci); /kacan: kartlı/kartsız, eksik şart dağılımı, kartlı/kartsız karşılaştırma, tanımlar açılır blokta, satır ≤ ${maxLine}; CSV: ${dropCols().length} sütun, BOM'lu; dışa aktarma tek zip (3 CSV); /kacan sade satırlarla aynı metin`);
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
  { const { createTeyitAcc } = require(`${REPO}/src/eventLog`); const acc = createTeyitAcc(); for (const r of all) acc.add(r);
    assert.strictEqual(teyitText(acc, { title: 'test', minN: 1 }), txt, 'sayaçla /teyit metni diziyle aynı'); }
  ok(`/teyit: ${all.length} aday (${drops(all).length} düştü), ${T.length} koşul karşılaştırıldı, satır ≤ ${maxLine}`);
}

// ── 8) H46 K19-K22 yeni kolonlar ──
{
  const { extraFeatures } = require(`${REPO}/src/peakFeatures`);
  const mk = (n, gapAt = [], tStart = t0) => { const S = new Series('XUSDT'); const a = [];
    for (let i = 0; i < n; i++) { if (gapAt.includes(i)) continue; a.push({ t: tStart + i * MIN, o: 100, h: 101, l: 99, c: 100, v: 1, tb: 1, q: 100, tq: 50, closed: true }); }
    S.seed('1m', a); return S; };
  // (a) kısmi 5m mum (t0+10dk açılış; tepe anı t0+12dk → %40) ile son kapanmış mum farklı
  {
    const S = mk(120); const T5 = 5 * MIN, tp = t0 + 120 * MIN + 2 * MIN;   // t: 5dk sınırından 2 dk sonra
    const b = t0 + 120 * MIN;   // devam eden 5m mum açılışı
    S.seed('5m', [{ t: b - T5, o: 100, h: 110, l: 100, c: 102, v: 1, q: 1, tq: 1, tb: 1, closed: true }]);   // kapanmış: fitil 8/10, clv 0.2
    S.part['5m'] = { t: b, o: 102, h: 106, l: 102, c: 106, v: 1, q: 1, tq: 1, tb: 1 };                       // kısmi: clv 1
    const f = extraFeatures(S, { t: tp });
    assert.strictEqual(f.clv_5m, 1, 'kısmi mum clv aynen'); assert.strictEqual(f.clv_5mc, 0.2, 'kapanmış mum clv');
    assert.notStrictEqual(f.clv_5mc, f.clv_5m); assert.strictEqual(f.wick_5mc, 0.8);
    assert.strictEqual(f.bar5Pct, 40, 'bar5Pct: ' + f.bar5Pct); assert.strictEqual(f.bar15Pct, 100 * ((tp % (15 * MIN)) / (15 * MIN)) === 100 ? 100 : +((tp % (15 * MIN)) / (15 * MIN) * 100).toFixed(1));
    assert.strictEqual(extraFeatures(S, { t: b }).bar5Pct, 100, 'sınırda 100');
    assert.strictEqual(f.clv_15mc, null, 'kapanmış 15m yok → null');
  }
  // (b) kısa geçmiş: 20 mum, pumpMin 60 → payda 19 (gerçek), tepe mumu 10x hacim
  {
    const S = mk(20); S.d['1m'].q[19] = 1000;
    const f = extraFeatures(S, { t: t0 + 20 * MIN, pumpMin: 60 });
    assert.strictEqual(f.volPeakXc, 10, 'volPeakXc: ' + f.volPeakXc);
    assert.strictEqual(f.volPeakX, +(1000 / ((19 * 100 + 1000) / 60)).toFixed(2), 'volPeakX eski formül aynen: ' + f.volPeakX);
    assert.strictEqual(extraFeatures(mk(1), { t: t0 + MIN }).volPeakXc, null);
  }
  // (c) 3 dk boşluk → miss60 = 3; eksiksiz → 0; (d) futQ60t aralığı
  {
    const S = mk(200, [150, 151, 152]); const t = t0 + 200 * MIN;
    const f = extraFeatures(S, { t });
    assert.strictEqual(f.miss60, 3, 'miss60: ' + f.miss60); assert.strictEqual(f.futQ60t, 5700);
    assert.strictEqual(extraFeatures(mk(200), { t }).miss60, 0);
    assert.strictEqual(extraFeatures(mk(200, [139]), { t }).miss60, 0, 'pencere dışı boşluk sayılmaz (139 < t−60dk)');
    assert.strictEqual(extraFeatures(mk(200), { t: t0 + 190 * MIN }).futQ60t, 6000, 't sonrası mum pencereye girmez');
  }
  // (d) uçtan uca: enrich spotQ60 verir; futQ60t tepe anında biten pencere, commit anı q60'tan farklı
  {
    const calls = []; const SQ = 3e6;
    const r = run(path1, { overrides: ov, opts: { enrich: (sym, o) => { calls.push(o); return { spotShare60: 0.5, spotQ60: SQ }; } } });
    await new Promise(res => setImmediate(res));
    const x = drops(r.ev)[0];
    const T = x.t; const want = r.m1.filter(c => c.t >= T - 60 * MIN && c.t < T).reduce((a, c) => a + c.q, 0);
    assert(Math.abs(x.feat.futQ60t - want) < 0.02 * 60, 'futQ60t tepe anı penceresi: ' + x.feat.futQ60t + ' vs ' + want);
    const call = calls.find(o => o.t === T);
    assert(Math.abs(call.futQ60 - x.feat.futQ60t) > 1, 'commit anı q60 farklı: ' + call.futQ60 + ' vs ' + x.feat.futQ60t);
    assert.strictEqual(x.feat.spotShare60t, +(SQ / (SQ + x.feat.futQ60t)).toFixed(3));
    assert.strictEqual(x.feat.spotShare60, 0.5, 'eski spotShare60 aynen'); assert.strictEqual(x.feat.spotQ60, SQ);
    assert.strictEqual(x.feat.miss60, 0);
    const noSp = drops(run(path1, { overrides: ov, opts: { enrich: () => ({ spotShare60: 0.5 }) } }).ev)[0];
    assert.strictEqual(noSp.feat.spotShare60t, null, 'spot yoksa null');
  }
  ok('H46 K19–K22: *c kapanmış mum, bar%, volPeakXc gerçek payda, miss60, futQ60t / spotShare60t');
}

// ── 7) H46 veri doğruluğu kolonları ──
{
  const AUD = ['sameBar', 'cardWhen', 'contSkipped', 'rsi15c', 'rsi1hc', 'rsi4hc', 'cfgMinTFs', 'cfgRsiMin', 'cfgDropPct', 'cfgContPct',
    'wick_5mc', 'clv_5mc', 'wick_15mc', 'clv_15mc', 'bar5Pct', 'bar15Pct', 'volPeakXc', 'miss60', 'futQ60t', 'spotQ60', 'spotShare60t',
    'rsi3c', 'rsi5c', 'sep3c', 'sep5c', 'cfgPeakWindowMin', 'cfgSampleGapMin', 'cfgVer', 'dropC15', 'lowC15', 'closeC60', 'incTf', 'inc5', 'inc15', 'lvZoneHiN', 'lvZoneLoN'];
  assert.deepStrictEqual(dropCols().slice(-AUD.length), AUD, 'yeni kolonlar sütun sırasının SONUNDA');
  const old = flatDrop({ id: 'x', out: {}, feat: {} }); assert(AUD.every(k => old[k] == null), 'eski kayıtta boş');
  { const r = flatDrop({ id: 'z', out: {}, feat: { lvZoneHiN: 2, lvZoneLoN: 1 } }); assert.strictEqual(r.lvZoneHiN, 2); assert.strictEqual(r.lvZoneLoN, 1, 'bölge değerleri CSV satırına gelir');
    const n = flatDrop({ id: 'z2', out: {}, feat: { lvZoneHiN: null } }); assert(n.lvZoneHiN == null && n.lvZoneLoN == null, 'bölge yoksa null'); }
  // sameBar: tepeden sonraki mumda hem −%1.5 hem tepe üstü
  const path2 = [...pump, 105.9, 104.2, ...seg(104.2, 104.5, 270)];
  const base = drops(run(path2, { overrides: ov }).ev).find(x => x.price === 106.3);
  const same = drops(run(path2, { overrides: { ...ov, [peakIdx + 1]: 107 } }).ev).find(x => x.price === 106.3);
  assert(base && same, 'sameBar senaryosu kaydı');
  assert.strictEqual(base.feat.sameBar, 0, 'tek eşik → 0');
  assert.strictEqual(same.feat.sameBar, 1, 'aynı mumda iki eşik → 1');
  assert.strictEqual(same.outcome, 'düştü', 'sonuç mantığı değişmedi (kırmızı mum → düştü)');
  assert.strictEqual(flatDrop(same).sameBar, 1);
  assert(run(path1, { overrides: ov }).ev.filter(x => x.outcome === 'yatay').every(x => x.feat.sameBar === 0));
  // cardWhen
  const e0 = drops(run(path1, { overrides: ov }).ev)[0];
  const cw = (cards) => drops(run(path1, { overrides: ov, cards }).ev)[0].feat.cardWhen;
  assert.strictEqual(e0.feat.cardWhen, null, 'kart yok → null');
  assert.strictEqual(cw([{ t: e0.t - 3 * MIN, grade: 3 }]), 'önce');
  assert.strictEqual(cw([{ t: e0.t, grade: 3 }]), 'önce', 'kart t = tepe t → önce');
  assert.strictEqual(cw([{ t: e0.t + MIN, grade: 3 }]), 'arada');
  assert.strictEqual(cw([{ t: e0.t + (e0.dropMin + 3) * MIN, grade: 3 }]), 'sonra');
  assert.strictEqual(cw([{ t: e0.t + (e0.dropMin + 3) * MIN, grade: 3 }, { t: e0.t - 2 * MIN, grade: 1 }]), 'önce', 'en erken kart esas');
  const kc = drops(run(path1, { overrides: ov, cards: [{ t: e0.t + (e0.dropMin + 3) * MIN, grade: 3 }] }).ev)[0];
  assert(kc.card === true && kc.cardGrade === 3, 'card kolonu anlamı aynı');
  // contSkipped: pompa boyunca devam örnekleri seyreltilir
  const rr = run(path1, { overrides: ov }).ev.sort((a, b) => a.t - b.t);
  assert(rr.every(x => Number.isInteger(x.feat.contSkipped) && x.feat.contSkipped >= 0));
  assert(rr.some(x => x.feat.contSkipped > 0), 'seyreltmeyle atlanan devam adayı sayıldı');
  const atl = rr.filter(x => x.feat.contSkipped > 0)[0];
  assert(atl.feat.contSkipped <= 4, 'sampleGapMin=5 → ardışık dakikalarda en çok 4 atlanır: ' + atl.feat.contSkipped);
  const noGap = run(path1, { overrides: ov, opts: { sampleGapMin: 0 } }).ev;
  assert(noGap.every(x => x.feat.contSkipped === 0), 'seyreltme kapalıyken atlanan yok');
  // kapanmış mumlu RSI
  const re = rr.filter(x => x.feat.rsi1hc != null);
  assert(re.length && re.every(x => Number.isFinite(x.feat.rsi15c) && Number.isFinite(x.feat.rsi1hc) && 'rsi4hc' in x.feat), 'rsi*c sayı (4s: test geçmişi 15 mumdan kısa → null)');
  assert(re.some(x => x.feat.rsi1hc !== x.feat.rsi1h), 'rsi1hc kısmi mumlu rsi1h\'den farklı olabilir: ' + re.slice(0, 3).map(x => x.feat.rsi1hc + '/' + x.feat.rsi1h));
  // cfg*
  const cf = run(path1, { overrides: ov, sets: { ...s, minTFs: 3, rsiMin: 77 }, opts: { dropPct: 2, contPct: 0.1 } }).ev;
  assert(cf.length && cf.every(x => x.feat.cfgMinTFs === 3 && x.feat.cfgRsiMin === 77 && x.feat.cfgDropPct === 2 && x.feat.cfgContPct === 0.1), 'cfg değerleri');
  assert(rr.every(x => x.feat.cfgMinTFs === s.minTFs && x.feat.cfgRsiMin === s.rsiMin && x.feat.cfgDropPct === 1.5 && x.feat.cfgContPct === 0));
  ok(`H46 kolonları: sameBar (tek eşik 0 / aynı mum 1), cardWhen önce/arada/sonra/null, contSkipped (en çok ${Math.max(...rr.map(x => x.feat.contSkipped))}), rsi1hc ${re[0].feat.rsi1hc} vs rsi1h ${re[0].feat.rsi1h}, cfg* ayar değişince izleniyor`);
}

// ── 8) Aşama 1 kalanları: rsi3c/rsi5c, sep3c/sep5c, cfg*, dropC15/lowC15/closeC60 ──
{
  const rr = run(path1, { overrides: ov, opts: { peakWindowMin: 15, sampleGapMin: 7 } }).ev.sort((a, b) => a.t - b.t);
  assert(rr.length && rr.every(x => Number.isFinite(x.feat.rsi3c) && Number.isFinite(x.feat.rsi5c) && Number.isFinite(x.feat.sep3c) && Number.isFinite(x.feat.sep5c)), 'rsi3c/5c, sep3c/5c sayı');
  assert(rr.some(x => x.feat.rsi3c !== x.feat.rsi3 || x.feat.rsi5c !== x.feat.rsi5), 'rsi*c kısmi mumlu rsi3/rsi5\'ten farklı olabilir');
  assert(rr.some(x => x.feat.sep3c !== x.feat.sep3), 'sep3c canlı sep3\'ten farklı olabilir');
  assert(rr.every(x => x.feat.cfgPeakWindowMin === 15 && x.feat.cfgSampleGapMin === 7 && x.feat.cfgVer === require(`${REPO}/package.json`).version), 'cfg* ledger ayarları + sürüm');
  // sep3c: kapanmış mumla elle hesap (yeni seri; kısmi mum sep3c'yi değiştirmez)
  {
    const ta = require(`${REPO}/src/ta`); const { sepClosed } = require(`${REPO}/src/eventLog`);
    const S = new Series('SEPUSDT'); const T3 = 3 * MIN, b = t0 + 200 * T3;
    const bars = Array.from({ length: 40 }, (_, i) => { const c = 100 + i * 0.1; return { t: t0 + i * T3, o: c, h: c + 0.1, l: c - 0.1, c, v: 1, q: 1, tq: 1, tb: 1, closed: true }; });
    S.seed('3m', bars);
    const cl = bars.map(x => x.c), em = ta.emaSeries(cl, 21), want = +((cl[39] - em[em.length - 1]) / em[em.length - 1] * 100).toFixed(2);
    S.part['3m'] = { t: b, o: 110, h: 120, l: 110, c: 120, v: 1, q: 1, tq: 1, tb: 1 };
    assert.strictEqual(sepClosed(S, '3m'), want, 'sep3c kapanmış mumla (kısmi mum 120 etkilemez)');
    assert.notStrictEqual(want, +((120 - em.at(-1)) / em.at(-1) * 100).toFixed(2));
    assert.strictEqual(sepClosed(new Series('EMPTYUSDT'), '3m'), null, 'mum yok → null');
  }
  // dropC15/lowC15/closeC60: peak ≠ price. Elle dönüşüm: v = peak*(1+x/100)/price − 1
  const dv = drops(run(path1, { overrides: ov }).ev).find(x => x.price === 106.3);
  assert(dv && dv.feat.price !== dv.price, 'peak ≠ giriş kapanışı: ' + dv?.price + ' / ' + dv?.feat.price);
  const cv = (x, pk, pr) => +((pk * (1 + x / 100) / pr - 1) * 100).toFixed(3);
  assert.strictEqual(dv.feat.lowC15, cv(dv.out[15].low, dv.price, dv.feat.price), 'lowC15 dönüşümü');
  assert.strictEqual(dv.feat.closeC60, cv(dv.out[60].close, dv.price, dv.feat.price), 'closeC60 dönüşümü');
  assert(dv.feat.lowC15 !== dv.out[15].low, 'tepeye göre değil, girişe göre');
  assert.strictEqual(dv.feat.dropC15, dv.feat.lowC15 <= -1.5 ? 1 : 0);
  // sınır: girişe göre eşik tutmuyorsa (peak girişten yüksek) dropC15 = 0 olabilir; elle kur
  assert.strictEqual(flatDrop(dv).lowC15, dv.feat.lowC15);
  // eksik pencere → null (finish'e doğrudan: 5 dk pencereli ledger, out[15]/out[60] yok)
  const sh = run(path1, { overrides: ov, opts: { windows: [5] } }).ev.find(x => x.outcome === 'düştü');
  assert(sh && sh.feat.lowC15 === null && sh.feat.closeC60 === null && sh.feat.dropC15 === null, 'eksik pencere null');
  ok('Aşama 1: rsi3c/rsi5c, sep3c, cfg*, dropC15/lowC15/closeC60 (peak≠price dönüşüm, eksik pencere null)');
}

// ── 9) A11: eksik 1m ile kapanan mum tepe kaydında işaretlenir (göstergeler aynı) ──
{
  const clean = drops(run(path1, { overrides: ov }).ev)[0];
  assert(clean.feat.incTf === '' && clean.feat.inc5 === 0 && clean.feat.inc15 === 0, 'boşluksuz akış: eksik yok');
  const gp = drops(run(path1, { overrides: ov, skip: [76, 77] }).ev)[0];
  assert(gp && gp.feat.inc5 === 1 && gp.feat.inc15 === 1, 'inc5/inc15: ' + gp?.feat.inc5 + '/' + gp?.feat.inc15);
  assert(gp.feat.incTf.split('|').includes('5m') && gp.feat.incTf.split('|').includes('15m') && gp.feat.incTf.split('|').includes('3m'), 'incTf: ' + gp.feat.incTf);
  assert(flatDrop(gp).incTf === gp.feat.incTf && flatDrop(gp).inc5 === 1, 'CSV satırında');
  ok('A11: tepe kaydı incTf/inc5/inc15 (boşluksuz: boş/0/0; 2 eksik dk: 3m|5m|15m işaretli)');
}

// ── A10: tepe anı dakika pencereleri zamana göre (boşlukta N dk'dan uzamaz; yarıdan az mumda null) ──
{
  const { extraFeatures, cvdFeatures } = require(`${REPO}/src/peakFeatures`);
  const cs = i => { const q = 100 + (i * 37) % 91, c = 100 + Math.sin(i / 7); return { t: t0 + i * MIN, o: c, h: c + 0.3 + (i % 5) * 0.01, l: c - 0.3, c, v: 1, tb: 1, q, tq: q * (0.3 + (i * 13 % 50) / 100), closed: true }; };
  const mkS = (n, miss) => { const S = new Series('XUSDT'); S.seed('1m', Array.from({ length: n }, (_, i) => i).filter(i => !miss.includes(i)).map(cs)); return S; };
  const rng = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const ratio = idx => { let x = 0, q = 0; for (const i of idx) { const c = cs(i); x += 2 * c.tq - c.q; q += c.q; } return +(x / q * 100).toFixed(1); };
  // (a) boşluksuz 130 mum: eski indeks tanımıyla aynı küme
  { const f = extraFeatures(mkS(130, [])); assert.strictEqual(f.cvdNet15, ratio(rng(115, 129))); assert.strictEqual(f.cvdNet60, ratio(rng(70, 129))); }
  // (b) 15 mum eksik (100..114): pencere zamana göre = t−14dk..t → 115..129 (15 mum); 60 dk penceresi 45 mumla (≥30) hesaplanır
  { const miss = rng(100, 114), f = extraFeatures(mkS(130, miss));
    assert.strictEqual(f.cvdNet15, ratio(rng(115, 129)), 'cvdNet15 zamana göre: ' + f.cvdNet15);
    assert.strictEqual(f.cvdNet60, ratio(rng(70, 129).filter(i => !miss.includes(i))), 'cvdNet60 zamana göre: ' + f.cvdNet60);
    assert.strictEqual(f.spd15, null, 'spd15: t−15 dk mumu (indeks 114) yok → null');
    assert.strictEqual(f.spdPrev15, null, 'spdPrev15: t−30 dk mumu da yok → null'); }
  // (c) 95..124 eksik: 15 dk pencerede 5 mum < ceil(15/2) → null; 60 dk'da 30 mum ≥ 30 → değer
  { const f = extraFeatures(mkS(130, rng(95, 124)));
    assert.strictEqual(f.cvdNet15, null, 'yarıdan az mum → null'); assert.notStrictEqual(f.cvdNet60, null, 'cvdNet60 yeterli mum');
    assert.strictEqual(f.buyChg, null, 'buyChg: önceki 10 dk penceresi boş → null'); assert.strictEqual(f.volTrend15, null); assert.strictEqual(f.spd15, null); }
  // (d) 100 eksik mum: indeks tanımı 15 mumu 115 dk geriden toplardı; zamana göre yalnız son 15 dk (215..229)
  { const c = cvdFeatures(mkS(230, rng(100, 199)).d['1m']);
    assert.strictEqual(c.cvdNet15, ratio(rng(215, 229)), 'cvdNet15 yalnız son 15 dk'); assert.strictEqual(c.cvdNet60, ratio(rng(200, 229)), '60 dk: 30 mum = ceil(60/2) → hesaplanır'); }
  { const c = cvdFeatures(mkS(230, rng(100, 200)).d['1m']); assert.strictEqual(c.cvdNet60, null, '60 dk penceresinde 29 mum < 30 → null'); }
  ok('A10: tepe anı dakika pencereleri zamana göre (boşluksuz aynı küme; yarıdan az mumda null)');
}

console.log('\n' + R.join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
