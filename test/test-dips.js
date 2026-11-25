'use strict';
// Dip defteri (src/dipLog.js): düşüş → dip adayı → döndü / devam / yatay, devam seyreltmesi, sonrası pencereleri ve girişe göre
// alanlar, look-ahead yok, cards.db `dips` tablosu, haftalık zip'te dipler.csv (tepeler.csv kolonları değişmeden)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createDipLedger, DIP_DEFAULTS, DIP_COLS, flatDip, dipCols } = require(`${REPO}/src/dipLog`);
const { dropCols, FEATURE_COLS } = require(`${REPO}/src/eventLog`);
const { createCardStore } = require(`${REPO}/src/cardStore`);
const W = require(`${REPO}/src/weeklyReport`); const { buildExports } = require(`${REPO}/src/exportData`);
const { createSettings } = require(`${REPO}/src/infoSettings`);
const unzip = require('./unzip');
const MIN = 60e3; const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);
const t0 = Date.UTC(2026, 0, 1);

const hist = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i / 9) * 0.15);
const candle = (i, c, o, ov = {}) => ({ t: t0 + i * MIN, o, h: ov.h ?? Math.max(o, c) * 1.0004, l: ov.l ?? Math.min(o, c) * 0.9996, c, v: 100, tb: 45, q: 100 * c, tq: 45 * c, closed: true });
function run(livePath, { overrides = {}, opts = {}, ctx = {}, cards = [] } = {}) {
  const all = [...hist, ...livePath];
  const m1 = all.map((c, i) => candle(i, c, i ? all[i - 1] : c, overrides[i - hist.length]));
  const S = new Series('DIPUSDT');
  const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
    if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; };
  const T0 = m1[hist.length].t;
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const L = createDipLedger({ ...cfg.dips, ...opts }); const ev = [];
  for (const c of m1.filter(c => c.t >= T0)) {
    S.apply1m(c);
    for (const k of cards) if (k.t === c.t + MIN) L.noteCard('DIPUSDT', k.t, k.grade);
    ev.push(...L.observe(S, s, ctx));
  }
  return { ev, L, m1, base: hist.length, S };
}
const seg = (from, to, n) => Array.from({ length: n }, (_, k) => from + (to - from) * (k + 1) / n);

(async () => {
// ── (a) Düşüş (−%5, 40 dk) → dip 94.7 → +%2 → döndü ──
const dump = [...seg(100, 100, 60), ...seg(100, 95, 40)];
const dipIdx = dump.length;
const path1 = [...dump, 95.1, ...seg(95.1, 97.5, 8), ...seg(97.5, 97.3, 260)];
const ov = { [dipIdx]: { l: 94.7 } };
const r1 = run(path1, { overrides: ov });
const bounced = r1.ev.filter(e => e.outcome === 'döndü');
assert.strictEqual(bounced.length, 1, 'tek döndü: ' + r1.ev.map(x => x.outcome).join(','));
const e = bounced[0];
assert.strictEqual(e.price, 94.7, 'kayıttaki dip gerçek dip (low)');
assert.strictEqual(e.t, t0 + (hist.length + dipIdx) * MIN + MIN, 'dip = dip mumunun kapanışı');
assert(e.bounceMin >= 1 && e.bounceMin <= 8, 'dönüşe kadar dk: ' + e.bounceMin);
assert(e.feat.dumpPct >= 5 && e.feat.dumpPct < 6 && e.feat.dumpMin >= 40, 'düşüş: ' + e.feat.dumpPct + ' / ' + e.feat.dumpMin);
assert.deepStrictEqual(Object.keys(e.feat).filter(k => DIP_COLS.includes(k)).sort(), [...DIP_COLS].sort(), 'tüm DIP_COLS alanları: eksik ' + DIP_COLS.filter(k => !(k in e.feat)).join(','));
assert(Number.isFinite(e.feat.rsi_1m) && e.feat.rsi_1m < 40 && Number.isFinite(e.feat.vwD_sig) && typeof e.feat.cvdDiv === 'boolean' && typeof e.feat.cvdDivBull === 'boolean', 'fotoğraf: RSI/VWAP/CVD');
assert(e.feat.avwLow_pct === null && Number.isFinite(e.feat.avwHigh_pct) && e.feat.avwHigh_pct < 0, 'avwLow dipte boş, avwHigh dolu (fiyat düşüş VWAP\'ının altında)');
assert(e.feat.drops24h === null && e.feat.minsSinceDrop === null && e.feat.samples24h >= 1 && e.feat.lastOutcome === 'devam', 'coin geçmişi: dip defterinden');
assert(Number.isFinite(e.feat.q24h) && e.feat.q24h > 0, 'q24h: ' + e.feat.q24h);
assert(e.feat.u1 != null && e.feat.u1 <= e.bounceMin && e.feat.u2 != null && e.feat.downBeforeBounce <= 0, 'u1/u2/downBeforeBounce');
assert(e.feat.rbPct > 2 && e.feat.rbMin > 0 && e.feat.rbMin <= 60 && typeof e.feat.rbNear === 'string', 'tepki tepesi: ' + e.feat.rbPct);
assert(typeof e.feat.c5Green === 'boolean' && Number.isFinite(e.feat.c5ClosePct) && Number.isFinite(e.feat.c5Next60High), '5dk teyit mumu');
assert(e.feat.cfgBouncePct === 1.5 && e.feat.cfgDumpPct === 3 && e.feat.dipVer === '2026.11.25-1' && e.feat.sameBar === 0, 'denetim alanları');
assert(e.feat.enrich === undefined && e.feat.oiChg15 === null && e.feat.obBid1 === null, 'enrich verilmezse ENRICH alanları boş');
ok(`Düşüş −%${e.feat.dumpPct} (${e.feat.dumpMin} dk) → dip ${e.price}, ${e.bounceMin}. dk'da döndü; +%1 ${e.feat.u1}. dk, tepki tepesi +%${e.feat.rbPct}; ${DIP_COLS.length} gösterge kolonu`);

// devam seyreltmesi: düşüş boyunca her dakika daha düşük low → devam; kayıtlılar en az 5 dk arayla, atlananlar contSkipped'de
const dv = r1.ev.filter(x => x.outcome === 'devam').sort((a, b) => a.t - b.t);
assert(dv.length >= 3 && dv.every((x, i) => i === 0 || x.t - dv[i - 1].t >= 5 * MIN), 'devam en fazla 5 dk\'da bir: ' + dv.length);
assert(dv.every(x => x.out[15].low < 0) && dv.slice(1).every(x => x.feat.contSkipped >= 3), 'devam = sonra daha düşük low; atlananlar sayıldı');
// daha düşük low → önceki aday devam, o mumda yeni aday
const path2 = [...dump, 95.1, ...seg(95.1, 95.5, 3), 94.4, ...seg(94.4, 96.5, 6), ...seg(96.5, 96.4, 260)];
const r2 = run(path2, { overrides: { [dipIdx]: { l: 94.7 }, [dipIdx + 4]: { l: 94.2 } } });
assert(!r2.ev.some(x => x.price === 94.7 && x.outcome !== 'devam'), '94.7 adayı devam ile kapandı');
const b2 = r2.ev.filter(x => x.outcome === 'döndü');
assert(b2.length === 1 && b2[0].price === 94.2 && b2[0].t === t0 + (hist.length + dipIdx + 4) * MIN + MIN, 'yeni aday daha düşük dipte: ' + JSON.stringify(b2.map(x => [x.price, x.outcome])));
ok(`Devam: ${dv.length} kayıtlı devam (≥ 5 dk arayla, atlanan sayaçlı); daha düşük low (94.2) önceki adayı devam ile kapattı, yeni aday döndü`);

// yatay: dipten sonra 15 dk içinde ne +%1.5 ne yeni dip
{
  const r = run([...dump, 95.1, ...seg(95.1, 95.6, 30), ...seg(95.6, 95.6, 250)], { overrides: ov });
  assert(r.ev.some(x => x.price === 94.7 && x.outcome === 'yatay'), 'yatay: ' + r.ev.map(x => x.price + ':' + x.outcome).join(','));
  ok('Yatay: dipten sonra 15 dk içinde +%1.5 yok, yeni dip yok');
}
// aynı mumda ikisi: kapanış > açılış → döndü, sameBar=1
{
  const r = run([...dump, 95.1, 95.9, ...seg(95.9, 96, 280)], { overrides: { [dipIdx]: { l: 94.7 }, [dipIdx + 1]: { l: 94.6, h: 96.3 } } });
  const x = r.ev.find(q => q.price === 94.7);
  assert(x && x.outcome === 'döndü' && x.feat.sameBar === 1, 'aynı mum: ' + JSON.stringify(x && [x.outcome, x.feat.sameBar]));
  ok('Aynı mumda hem +%1.5 hem yeni dip: kapanış > açılış → döndü, sameBar=1');
}
// kart: dipten 3 dk önce → kartlı
{
  const r = run(path1, { overrides: ov, cards: [{ t: e.t - 3 * MIN, grade: 2 }] });
  const x = r.ev.find(q => q.outcome === 'döndü');
  assert(x.card === true && x.cardGrade === 2 && x.feat.cardWhen === 'önce', 'kartlı');
  ok('Kart ilişkisi: dipten 3 dk önceki kart (derece 2) eşleşti, cardWhen=önce');
}

// ── (b) Sonrası pencereleri ve girişe göre alanlar (elle hesap) ──
{
  const base = r1.base, i0 = base + dipIdx + 1;   // dipten sonraki ilk mum
  const win = (w) => r1.m1.slice(i0, i0 + w);
  const p = e.price, entry = e.feat.price;
  assert(Math.abs(entry - r1.m1[base + dipIdx].c) < 1e-9 && entry !== p, 'giriş = dip mumunun kapanışı');
  for (const w of [5, 15, 30, 60, 240]) {
    const cs = win(w), hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l)), cl = cs[cs.length - 1].c;
    assert(Math.abs(e.out[w].high - (hi - p) / p * 100) < 1e-3 && Math.abs(e.out[w].low - (lo - p) / p * 100) < 1e-3 && Math.abs(e.out[w].close - (cl - p) / p * 100) < 1e-3, 'pencere ' + w);
  }
  const hi15 = Math.max(...win(15).map(c => c.h)), lo60 = Math.min(...win(60).map(c => c.l));
  assert(Math.abs(e.feat.highC15 - (hi15 / entry - 1) * 100) < 2e-3, 'highC15');
  assert(Math.abs(e.feat.lowC60 - (lo60 / entry - 1) * 100) < 2e-3, 'lowC60');
  assert(Math.abs(e.feat.closeC60 - (win(60)[59].c / entry - 1) * 100) < 2e-3 && Math.abs(e.feat.closeC240 - (win(240)[239].c / entry - 1) * 100) < 2e-3, 'closeC60/240');
  assert.strictEqual(e.feat.bounceC15, e.feat.highC15 >= 1.5 ? 1 : 0);
  const row = flatDip(e);
  assert.deepStrictEqual(Object.keys(row), dipCols());
  assert.deepStrictEqual(dipCols().slice(0, 8), ['id', 'symbol', 'time', 'dip', 'outcome', 'bounceMin', 'card', 'cardGrade']);
  assert.deepStrictEqual(dipCols().slice(8, 23), [5, 15, 30, 60, 240].flatMap(w => [`low${w}`, `high${w}`, `close${w}`]));
  assert(row.dip === 94.7 && row.outcome === 'döndü' && row.high15 === e.out[15].high);
  ok(`Pencereler 5/15/30/60/240 elle hesapla eşit (dibe göre); highC15 +%${e.feat.highC15}, lowC60, closeC60/240 girişe (1m kapanış ${entry.toFixed(3)}) göre; CSV başı ARAYÜZ ile aynı`);
}

// ── (c) Look-ahead yok: aday fotoğrafı sonraki mumlardan etkilenmez ──
{
  const ra = run(path1, { overrides: ov });
  const rb = run([...dump, 95.1, ...seg(95.1, 95.6, 30), ...seg(95.6, 90, 250)], { overrides: ov });
  const a = ra.ev.find(x => x.price === 94.7), b = rb.ev.find(x => x.price === 94.7);
  assert(a && b && a.outcome !== b.outcome, 'iki farklı gelecek');
  const TAIL = new Set(['highC15', 'lowC60', 'closeC60', 'closeC240', 'bounceC15', 'sameBar', 'cardWhen', 'rbPct', 'rbMin', 'rbLv', 'rbLvKind', 'rbLvDist', 'rbLvTouches', 'rbNear',
    'downBeforeBounce', 'u1', 'u2', 'u3', 'c5Green', 'c5Engulf', 'c5AbovePrev', 'c5ClosePct', 'c5Next60High']);
  const snap = f => Object.fromEntries(Object.entries(f).filter(([k]) => !TAIL.has(k)));
  assert.deepStrictEqual(snap(b.feat), snap(a.feat), 'dip anı fotoğrafı gelecekten bağımsız');
  ok(`Look-ahead yok: aynı dipte farklı gelecek (${a.outcome} / ${b.outcome}) → dip anı fotoğrafı (${Object.keys(snap(a.feat)).length} alan) birebir aynı`);
}

// ── enrich / orderBook: tepe defteriyle aynı imza, yalnız kaydedilen adaylara ──
{
  const calls = [];
  const r = run(path1, { overrides: ov, opts: { enrich: (sym, o) => { calls.push(o); return { oiChg15: 1.5, spotQ60: 1000 }; }, orderBook: () => ({ obBid1: 0.6, obBid2: 0.55, obAsk1Usd: 1, obBid1Usd: 2 }) },
    ctx: { market: () => ({ breadth80: 1, pumping: 2, breadth20: 30.5, dumping: 41, btc5: -0.5, btc15: -1, btcRsi15: 30 }) } });
  const x = r.ev.find(q => q.outcome === 'döndü');
  assert(x.feat.oiChg15 === 1.5 && x.feat.obBid1 === 0.6 && Number.isFinite(x.feat.spotShare60t), 'ek veri birleşti');
  assert(calls.length === r.ev.length + r.L.openCount() && calls.every(o => o.price > 0 && Number.isFinite(o.t)), 'yalnız kaydedilen adaylar: ' + calls.length);
  assert(x.feat.breadth20 === 30.5 && x.feat.dumping === 41 && x.feat.breadth80 === 1, 'piyasa: breadth20 / dumping');
  ok(`Ek veri: enrich ${calls.length} kayıtlı adaya (dip anına hizalı), emir defteri birleşti; piyasa breadth20 %${x.feat.breadth20}, dumping ${x.feat.dumping}`);
}

// ── Tepe fotoğrafında breadth20 / dumping / q24h (tepeler.csv son 3 kolon) ──
{
  const { peakFeatures } = require(`${REPO}/src/eventLog`);
  const tc = r1.S.lastT('1m') + MIN;
  const f = peakFeatures(r1.S, s, { market: () => ({ breadth20: 12.5, dumping: 9 }) }, 98, 4, tc - 60 * MIN, tc);
  assert(f.breadth20 === 12.5 && f.dumping === 9 && Number.isFinite(f.q24h) && f.q24h > 0, 'tepe: ' + JSON.stringify([f.breadth20, f.dumping, f.q24h]));
  const g = peakFeatures(r1.S, s, {}, 98, 4, tc - 60 * MIN, tc);
  assert(g.breadth20 === null && g.dumping === null, 'piyasa yoksa boş');
  ok(`Tepe fotoğrafı: breadth20 %${f.breadth20}, dumping ${f.dumping}, q24h ${f.q24h} (piyasa verisi yoksa boş)`);
}

// ── Yeni ayar bloğu: cfg.dips, eski info-settings.json ile açılışta etkilenmez (Telegram ayarı değil) ──
{
  assert.deepStrictEqual(cfg.dips, DIP_DEFAULTS, 'config.dips = DIP_DEFAULTS');
  const f = require('./_tmp') + '/dips-old-settings.json';
  fs.writeFileSync(f, JSON.stringify({ values: { rsiMin: 88 }, mutes: {}, follows: [], topics: {} }));   // dips anahtarı olmayan eski dosya
  const st = createSettings({ file: f }); st.load();
  assert(st.get().rsiMin === 88 && st.get().dips === undefined, 'eski ayar dosyası açıldı');
  const L = createDipLedger({ ...cfg.dips });
  assert.strictEqual(L.E.bouncePct, 1.5);
  ok('Eski info-settings.json (dips anahtarı yok) ile açılış: ayarlar yüklendi, dip defteri varsayılanları config.dips\'ten');
}

// ── (d) cards.db dips: CREATE, insert (tekrar yok), forEachDip parça parça, purgeBefore, 60 gün budama ──
const dir = require('./_tmp') + '/dips-tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const now = Date.UTC(2026, 9, 5, 0, 2);
{
  const file = dir + '/cards.db';
  const st = createCardStore({ file, logger: { log() {}, error: x => { throw new Error(x); } } });
  const D = 86_400_000;
  const mk = (id, t, outcome = 'döndü') => ({ ...e, id, t, outcome });
  st.addDip(mk('OLD', now - 61 * D)); for (let k = 0; k < 250; k++) st.addDip(mk('D' + k, now - 3 * D + k * MIN, ['döndü', 'devam', 'yatay'][k % 3]));
  st.addDip(mk('D0', now - 3 * D));   // tekrar id
  const got = []; let ticks = 0; const iv = setInterval(() => ticks++, 0);
  const n = await st.forEachDip({}, r => { got.push(r); });
  clearInterval(iv);
  assert.strictEqual(n, 251); assert.strictEqual(new Set(got.map(r => r.id)).size, 251, 'tekrar id yok');
  const back = got.find(r => r.id === 'D0');
  assert.deepStrictEqual(back.out, e.out); assert.strictEqual(back.price, 94.7); assert.strictEqual(back.bounceMin, e.bounceMin);
  assert.strictEqual(JSON.stringify(flatDip(back)), JSON.stringify(flatDip({ ...e, id: 'D0', t: now - 3 * D })), 'DB\'den okunan satır CSV\'de aynı');
  st.sweep(now);
  assert.strictEqual(await st.forEachDip({}, () => {}), 250, '61 günlük dip budandı');
  const pr = st.purgeBefore(now - 3 * D + 100 * MIN);
  assert.strictEqual(pr.dips, 100); assert.strictEqual(await st.forEachDip({}, () => {}), 150);
  const cols = new (require('better-sqlite3'))(file, { readonly: true }).prepare('PRAGMA table_info(dips)').all().map(c => c.name);
  assert.deepStrictEqual(cols.slice(0, 10), ['id', 'symbol', 't', 'price', 'bouncet', 'bouncemin', 'card', 'cardgrade', 'outcome', 'data']);
  st.close();
  // yeniden açılış: CREATE TABLE IF NOT EXISTS mevcut tabloyu korur
  const st2 = createCardStore({ file, logger: { log() {}, error: x => { throw new Error(x); } } });
  assert.strictEqual(await st2.forEachDip({}, () => {}), 150); st2.close();
  // kayıt hatası botu durdurmaz: logla, devam
  const errs = []; const st3 = createCardStore({ file: dir + '/err.db', logger: { log() {}, error: x => errs.push(x) } });
  st3.addDip({ id: 'X', symbol: 'A', t: 1, price: {} });   // bağlanamayan değer → hata
  assert(errs.some(x => x.includes('[DİP]')), 'hata loglandı: ' + errs.join('|')); st3.close();
  ok(`cards.db dips: ${n} satır parça parça okundu (100'lük), tekrar id yok, alanlar birebir; 60 gün budama; purgeBefore dips'i siler; yeniden açılışta korunur; kayıt hatası [DİP] ile loglanır`);
}

// ── (e) Haftalık zip: dipler.csv (başlık = dipCols), tepeler.csv kolonları değişmedi; /disaaktar dipler.csv ──
{
  const st = createCardStore({ file: dir + '/weekly.db', logger: { log() {}, error: x => { throw new Error(x); } } });
  const old = now - 2 * 86_400_000;
  st.addDip({ ...e, id: 'W1', t: old }); st.addDip({ ...e, id: 'W2', t: old + MIN, outcome: 'yatay' }); st.addDip({ ...e, id: 'W3', t: now - 3_600_000 });   // W3 son 5 saatte
  st.addEvent({ id: 'E1', symbol: 'BUSDT', t: old, price: 2, dropT: null, dropMin: null, card: false, cardGrade: null, outcome: 'yatay', feat: {}, out: {} });
  const w = await W.buildWeekly(st, { now, s: cfg.info, E: cfg.events });
  const Z = unzip(w.files[0].buf);
  assert(Object.keys(Z).includes('dipler.csv'), 'zip: ' + Object.keys(Z).join(','));
  const lines = Z['dipler.csv'].replace('﻿', '').trim().split('\n');
  assert.deepStrictEqual(lines[0].split(','), dipCols(), 'dipler.csv başlığı = dipCols');
  assert.strictEqual(lines.length, 3, 'kapsam: son 5 saat hariç 2 dip');
  assert.deepStrictEqual(w.dips, { n: 2, döndü: 1, devam: 0, yatay: 1 });
  const th = Z['tepeler.csv'].replace('﻿', '').split('\n')[0].split(',');
  assert.deepStrictEqual(th, dropCols(), 'tepeler.csv başlığı = dropCols');
  // main (a1e32ba) tepeler.csv başlığı: 299 kolon, sha1 aşağıda — önceki kolonlar birebir aynı sırada, yalnız sonda 3 yeni kolon
  const prev = th.slice(0, -3);
  assert.strictEqual(prev.length, 299);
  assert.strictEqual(require('crypto').createHash('sha1').update(prev.join(',')).digest('hex'), 'db53bbb18db8351095f547088c9091bc02a1be7e', 'main\'deki tepeler.csv kolon sırası aynı');
  assert.deepStrictEqual(th.slice(-3), ['breadth20', 'dumping', 'q24h']);
  assert.deepStrictEqual(prev.slice(-8), ['atr2C15', 'v3S', 'v3_rsi1m', 'v3_bb15', 'v3_stoch5', 'v3_vol3', 'v3_liq', 'v3B']);
  assert(w.md.includes('## Dip defteri (özet)') && w.md.includes('Dip adayı: 2 · döndü 1 (%50)') && w.md.includes('- dipler.csv:'), 'MD dip bölümü');
  assert(!/\b(al|sat)\b/i.test(w.md.split('## Dip defteri (özet)')[1].split('## Seviye')[0]), 'al/sat dili yok');
  // dip kaydı yoksa dosya açılmaz (eski zip içeriği aynı)
  const stE = createCardStore({ file: dir + '/empty.db', logger: { log() {}, error: x => { throw new Error(x); } } });
  const we = await W.buildWeekly(stE, { now, s: cfg.info, E: cfg.events });
  assert(!Object.keys(unzip(we.files[0].buf)).includes('dipler.csv')); stE.close();
  // /disaaktar
  const ex = await buildExports(st, 7, now);
  const ZX = unzip(ex.files[0].buf);
  assert(ZX['dipler.csv'] && ZX['dipler.csv'].replace('﻿', '').split('\n')[0] === dipCols().join(',') && ex.counts.dipler === 3, '/disaaktar dipler.csv: ' + Object.keys(ZX));
  // gönderim başarılı → dips de silinir; başarısız → silinmez
  let fail = true;
  const job = W.createWeeklyJob({ store: st, file: dir + '/ws.json', E: cfg.events, logger: { log() {}, warn() {}, error: x => { throw new Error(x); } },
    send: async () => !fail, purge: c => st.purgeBefore(c) });
  await job.tick(Date.UTC(2026, 9, 6, 10));
  const t1 = Date.UTC(2026, 9, 12, 0, 1, 30);
  assert.strictEqual(await job.tick(t1), 'fail'); assert.strictEqual(await st.forEachDip({}, () => {}), 3, 'gönderilemedi → dips silinmedi');
  fail = false;
  assert.strictEqual(await job.tick(t1 + 11 * MIN), 'sent'); assert.strictEqual(await st.forEachDip({}, () => {}), 0, 'gönderildi → dips silindi');
  st.close();
  console.log(w.md.split('\n').filter(l => /Dip adayı|Destek teması:/.test(l)).join('\n'));
  ok(`Haftalık: zip'te dipler.csv (${dipCols().length} kolon, başlık = dipCols), tepeler.csv main'deki 299 kolon birebir + sonda breadth20/dumping/q24h (${dropCols().length}); MD dip özeti; dip yoksa dosya yok; /disaaktar dipler.csv; gönderim başarısızsa silme yok, başarılıysa dips silindi`);
}

console.log('\n' + R.join('\n'));
})().catch(err => { console.error(err); process.exit(1); });
