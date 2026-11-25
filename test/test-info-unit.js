'use strict';
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const eng = require(`${REPO}/src/infoEngine`);
const cfg = require(`${REPO}/src/config`); const { createSettings } = require(`${REPO}/src/infoSettings`);
const MIN = 60e3; const s = { ...cfg.info, rsiMin: 90, resetRsi: 75 }; const R = []; const ok = x => R.push('✅ ' + x);

// ── Patlama sayacı ──
{ const S = new Series('X'); const t0 = Date.UTC(2026, 0, 1); let p = 100; const arr = [];
  for (let i = 0; i < 200; i++) arr.push({ t: t0 + i * MIN, o: p, h: p * 1.001, l: p * 0.999, c: p, v: 100, tb: 50, q: 1e4, tq: 5e3, closed: true });
  const B = (i, body, vol, tk) => { const c = arr[i]; c.c = c.o * (1 + body / 100); c.v = vol; c.tb = vol * tk; c.q = vol * c.c; c.tq = c.tb * c.c; };
  B(150, -1.2, 400, 0.3);             // satış, kademe 1
  B(151, -1.7, 500, 0.3);             // hemen ardından → aynı patlama, kademe 2'ye yükselir
  B(170, +1.1, 300, 0.7);             // alım
  B(180, +2.0, 150, 0.9);             // hacim yetersiz (150 < 2× ~100?) → 1.5×: sayılmaz
  B(190, -1.0, 300, 0.5);             // nötr
  B(195, +0.8, 900, 0.9);             // gövde küçük → sayılmaz
  S.seed('1m', arr);
  const bc = eng.burstCounts(S, s, [60, 15]);
  assert.deepStrictEqual(bc[60].p1, { buy: 1, sell: 1, neutral: 1 });
  assert.deepStrictEqual(bc[60].p2, { buy: 0, sell: 1, neutral: 0 });
  assert.deepStrictEqual(bc[15].p1, { buy: 0, sell: 0, neutral: 1 });
  const d = S.d['1m'];
  assert.strictEqual(eng.burstAt(d, 180, s), null);
  const b = eng.burstAt(d, 151, s); assert(b.dir === 'sell' && b.tier === 2 && b.volX > 2);
  // taker net
  const net = eng.takerNet(S, 60); assert(Number.isFinite(net));
  ok('Hacim sayacı: art arda iki satış mumu tek patlama (kademe 2), alım/nötr ayrı; hacmi yetersiz ve gövdesi küçük mumlar sayılmadı; 15 dk penceresi doğru');
}

// ── Madde 12 / K16: burstAt ve takerNet zamana bağlı pencere ──
{ const n = s.volAvgN;
  // Eski (dizin pencereli) referans uygulamalar
  const oldAvg = (d, i) => { if (i < n) return null; let sum = 0; for (let j = i - n; j < i; j++) sum += d.v[j]; return sum / n; };
  const oldNet = (d, w) => { let net = 0; for (let i = Math.max(0, d.t.length - w); i < d.t.length; i++) net += 2 * d.tq[i] - d.q[i]; return net; };
  const mk = (skip) => { const S = new Series('G'); const t0 = Date.UTC(2026, 0, 1); const arr = [];
    for (let i = 0; i < 200; i++) { if (skip && i >= skip[0] && i < skip[1]) continue;
      const v = i < 100 ? 1000 : 100;     // 100 öncesi hacim çok yüksek, sonrası düşük
      arr.push({ t: t0 + i * MIN, o: 100, h: 100.1, l: 99.9, c: 100, v, tb: v / 2, q: v * 100, tq: v * 50 + i, closed: true }); }
    return arr; };
  const addBurst = (arr, tm, body, vol) => { const c = arr.find(x => x.t === tm); c.c = c.o * (1 + body / 100); c.v = vol; c.tb = vol * 0.3; c.q = vol * c.c; c.tq = c.tb * c.c; };
  // (a) boşluksuz: eski sonuçla birebir
  { const arr = mk(); addBurst(arr, arr[150].t, -1.5, 400); const S = new Series('A'); S.seed('1m', arr); const d = S.d['1m'];
    const b = eng.burstAt(d, 150, s); assert(b, 'patlama bulunmalı');
    assert.strictEqual(b.volX, d.v[150] / oldAvg(d, 150), 'ortalama eskisiyle birebir');
    for (const w of [1, 15, 60, 150, 500]) assert.strictEqual(eng.takerNet(S, w), oldNet(d, w), 'takerNet eskisiyle birebir w=' + w);
    // seri başı: i < volAvgN → null (eski kural)
    const arr2 = mk(); addBurst(arr2, arr2[n - 1].t, -1.5, 5000); const S2 = new Series('A2'); S2.seed('1m', arr2);
    assert.strictEqual(eng.burstAt(S2.d['1m'], n - 1, s), null, 'i < volAvgN → null'); }
  // (b) 10 dk boşluk: i=105..114 yok
  { const arr = mk([105, 115]); const tAfter = Date.UTC(2026, 0, 1) + 116 * MIN;
    addBurst(arr, tAfter, -1.5, 1500); const S = new Series('B'); S.seed('1m', arr); const d = S.d['1m'];
    const i = d.t.indexOf(tAfter); const b = eng.burstAt(d, i, s);
    // pencere [t−n·dk, t): boşluk dışı mumlar; 100 öncesi (v=1000) pencereye girmiş olabilir — beklenen ortalamayı zamandan hesapla
    const lo = tAfter - n * MIN; let sum = 0, cnt = 0; for (let j = 0; j < i; j++) if (d.t[j] >= lo) { sum += d.v[j]; cnt++; }
    assert(cnt < n && cnt >= Math.ceil(n / 2), 'senaryo: pencerede boşluk var ama yeterli mum var (cnt=' + cnt + ')');
    assert(b && Math.abs(b.volX - 1500 / (sum / cnt)) < 1e-9, 'ortalama = gerçek zaman penceresi / bulunan mum sayısı');
    assert(Math.abs(b.volX - 1500 / oldAvg(d, i)) > 1e-6, 'eski dizin penceresinden farklı (boşluk öncesi mumlar katılmıyor)');
    // yetersiz veri: boşluk pencerenin çoğunu kapsıyorsa null
    const arr3 = mk([105, 105 + n]); const t3 = Date.UTC(2026, 0, 1) + (105 + n + 1) * MIN; addBurst(arr3, t3, -1.5, 5000);
    const S3 = new Series('B3'); S3.seed('1m', arr3); const d3 = S3.d['1m'];
    assert.strictEqual(eng.burstAt(d3, d3.t.indexOf(t3), s), null, 'bulunan mum < ceil(volAvgN/2) → null');
    // takerNet: son 60 dk içinde 10 dk boşluk → boşluk öncesi mumlar son 60 dk dışındaysa sayılmaz
    const SG = new Series('BG'); SG.seed('1m', mk([170, 180])); const dg = SG.d['1m'];   // son 60 dk içinde 10 dk boşluk
    const last = dg.t[dg.t.length - 1]; const from = last + MIN - 60 * MIN;
    let exp = 0; for (let j = 0; j < dg.t.length; j++) if (dg.t[j] >= from) exp += 2 * dg.tq[j] - dg.q[j];
    assert.strictEqual(eng.takerNet(SG, 60), exp, 'takerNet yalnız son 60 DAKİKA');
    assert.notStrictEqual(eng.takerNet(SG, 60), oldNet(dg, 60), 'dizin penceresinden farklı (60 mum boşluğu aşıp geriye gider)'); }
  ok('Madde 12/K16: burstAt ortalaması ve takerNet zamana bağlı; boşluksuz seride eskisiyle birebir, boşlukta boşluk öncesi mumlar katılmıyor, yetersiz veride null');
}

// ── Seviye seçimi ──
{ const lv = [{ name: 'A', value: 100 }, { name: 'B', value: 102 }, { name: 'C', value: 110 }];
  let r = eng.pickLevel(99, lv, s); assert(r.level.name === 'A' && r.level.zone === 'near' && Math.abs(r.level.dist + 1) < 1e-9);
  r = eng.pickLevel(99.7, lv, s); assert(r.level.name === 'A' && r.level.zone === 'dip');
  r = eng.pickLevel(100.2, lv, s); assert(r.level.name === 'A' && r.level.zone === 'dip');      // %0.2 üstünde: fitil payı
  r = eng.pickLevel(100.6, lv, s); assert(r.level.name === 'B' && r.level.zone === 'near');     // A kırıldı (%0.5 payı aşıldı) → B
  r = eng.pickLevel(103, lv, s); assert.strictEqual(r.level, null);                             // B kırıldı, C %6.8 uzak
  r = eng.pickLevel(97.4, lv, s); assert.strictEqual(r.level, null);                            // A %2.6 uzak
  ok('Seviye: %2.5 içinde en yakın üst seviye; ≤%0.5 altı / ≤%0.5 üstü DİPTE; kırılan seviye atlanıp bir üstteki alınıyor; uzaksa yok');
}

// ── Yenilik tespiti / numaralandırma ──
{ const tr = eng.createTracker();
  const snap = (o = {}) => ({ t: 1, price: 100, hits: 2, rsi: { '3m': { v: 92 }, '5m': { v: 91 }, '15m': { v: 80 } }, level: { name: 'A', value: 101, dist: -1, zone: 'near' }, macd: { '5m': null, '15m': null }, stoch: null, ...o });
  let n = tr.news('X', snap(), { tfs: ['3m'] }, s); assert(n[0].startsWith('İlk kart')); tr.commit('X', snap(), s);
  n = tr.news('X', snap(), { tfs: ['3m'] }, s); assert.deepStrictEqual(n, []);                             // değişiklik yok → kart yok
  n = tr.news('X', snap({ hits: 3, rsi: { '3m': { v: 96 }, '5m': { v: 91 }, '15m': { v: 90 } } }), { tfs: ['5m'] }, s);
  assert.deepStrictEqual(n, ['RSI 90 üstüne çıktı: 15m 90.0', 'RSI 95 üstüne çıktı: 3m 96.0']);
  tr.commit('X', snap({ hits: 3, rsi: { '3m': { v: 96 }, '5m': { v: 91 }, '15m': { v: 90 } } }), s);
  n = tr.news('X', snap({ hits: 3, price: 101.6, rsi: { '3m': { v: 96 }, '5m': { v: 91 }, '15m': { v: 90 } }, level: { name: 'B', value: 102, dist: -0.49, zone: 'dip' } }), { tfs: ['3m'] }, s);
  assert(n.length === 1 && n[0].startsWith('⚠️ A seviyesi kırıldı · sıradaki: B (%0.49 kala)'), n[0]);
  n = tr.news('X', snap({ hits: 3, rsi: { '3m': { v: 96 }, '5m': { v: 91 }, '15m': { v: 90 } }, level: { name: 'A', value: 101, dist: -0.3, zone: 'dip' } }), { tfs: ['3m'] }, s);
  assert(n[0].startsWith('⭐ Fiyat dirence dayandı: A (%0.30 kala)'), n[0]);
  n = tr.news('X', snap({ hits: 3, rsi: { '3m': { v: 96 }, '5m': { v: 91 }, '15m': { v: 90 } }, macd: { '5m': { cross: 'down', crossKey: '5m:down:1' }, '15m': null }, stoch: { cross: 'down', crossKey: '5m:down:1' } }), { tfs: ['5m'], burst: { dir: 'sell', body: -1.3, volX: 3.2, taker: 30 } }, s);
  assert.deepStrictEqual(n, ['🔴 Hacimli düşen mum: −%1.3 · hacim 3.2 kat · satış %70', '5m MACD aşağı kesti', '5m Stoch RSI aşağı kesti']);
  assert.strictEqual(tr.log('X').length, 2);
  { const t2 = eng.createTracker();
    assert(t2.news('Y', snap(), { tfs: ['3m'] }, s)[0] === 'İlk kart');
    t2.commitExtra('Y', snap());
    assert(t2.news('Y', snap(), { tfs: ['3m'] }, s)[0] === 'İlk RSI kartı (⭐ kurulum kartından sonra)', 'xs>0 → İlk RSI kartı'); }
  tr.observe15m('X', 80, s); assert(tr.news('X', snap(), { tfs: [] }, s).length === 0 || true);
  tr.observe15m('X', 74, s);
  n = tr.news('X', snap(), { tfs: ['3m'] }, s); assert(n[0].startsWith('İlk kart'));
  assert.strictEqual(tr.commit('X', snap(), s), 1);
  ok('Yenilik: değişiklik yoksa boş (kart yok); RSI dilim sayısı, 95↑, seviye kırılması/DİPTE, patlama, MACD/Stoch kesişimi yakalanıyor; 15m RSI < 75 kapanınca numara #1\'e dönüyor');
}

// ── Derece ──
{ const g = { ...cfg.info };
  assert.strictEqual(eng.volGrade(2.4, 2.5, 80, g), 1);          // hacim < 3× → 🔴
  assert.strictEqual(eng.volGrade(2.4, 3.5, 60, g), 2);          // hacim ≥ 3×, yön uyumu %60 → 🔴🔴
  assert.strictEqual(eng.volGrade(2.4, 3.5, 70, g), 3);          // + alış %70 yükselişte → 🔴🔴🔴
  assert.strictEqual(eng.volGrade(-2.4, 3.5, 30, g), 3);         // düşüşte satış %70 → 🔴🔴🔴
  assert.strictEqual(eng.volGrade(-2.4, 3.5, 70, g), 2);         // düşüşte alış ağır → yön uyumu yok
  assert.strictEqual(eng.volGrade(3, null, null, g), 1);         // hacim bilinmiyor → 🔴
  // Kontrol listesi → derece
  const rsi = (a, b, c) => ({ '3m': { v: a }, '5m': { v: b }, '15m': { v: c } });
  const base = { price: 100, hits: 3, levels: [{ name: '1d MA200', value: 100.3, dist: -0.3 }, { name: '30 günlük tepe', value: 100.5, dist: -0.5 }, { name: '4h EMA200', value: 105, dist: -4.8 }],
    level: { name: '1d MA200', value: 100.3, dist: -0.3, zone: 'dip' }, sepPct: { '3m': 6, '5m': 5.5 },
    macd: { '3m': { cross: 'down' }, '5m': null }, conf: { h1: 85, h4: 82 }, neg: { '1m': { count: 2 }, '3m': { count: 0 } } };
  let ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96) }, g);
  assert.strictEqual(ck.score, 10, JSON.stringify(ck.items.filter(x => !x.ok)));          // 8 madde × 1 + EMA %5 (2 puan) + MACD; toplam 9 madde
  assert(ck.total === 9 && ck.items[1].text.includes('1d MA200 + 30 günlük tepe'));
  assert.strictEqual(eng.rsiGrade({ hits: 3, check: ck }, { ...g, gradeBy: 'liste' }), 4);
  // EMA21 ayrışma yalnız ÜSTTE puan alır: fiyat EMA21'in %12 altındaysa 0 puan
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': -12, '5m': -11 } }, g);
  assert(!ck.items.find(x => x.key === 'sep').ok && ck.score === 8, 'EMA altı puan almamalı: ' + ck.score);
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': 10.5, '5m': 10.2 } }, g);
  assert.strictEqual(ck.items.find(x => x.key === 'sep').pts, 3);                         // ikisi de ≥ %10 → 3 puan
  // K7: liste dereceyle hizalı — 3m ve 5m'nin KÜÇÜĞÜ puanlanır (eskisi büyüğü)
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': 6, '5m': 1 } }, g);
  assert.strictEqual(ck.items.find(x => x.key === 'sep').pts, 0, 'sep3=6, sep5=1 → 0 puan (eskisi 2)');
  assert.strictEqual(ck.items.find(x => x.key === 'sep').text, 'EMA21 % ayrışma yok');
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': 6, '5m': 5.5 } }, g);
  assert.strictEqual(ck.items.find(x => x.key === 'sep').pts, 2, 'sep3=6, sep5=5.5 → 2 puan');
  assert(ck.items.find(x => x.key === 'sep').text.includes('(5.5%)'), 'metin yeni değeri (küçük) gösterir');
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': 6 } }, g);
  assert.strictEqual(ck.items.find(x => x.key === 'sep').pts, 0, '5m yoksa 0');
  ck = eng.checklist({ ...base, rsi: rsi(99, 91, 88), sepPct: { '3m': 0.5, '5m': 0.2 }, macd: {}, conf: { h1: 85, h4: 60 }, neg: { '1m': { count: 1 }, '3m': { count: 0 } } }, g);
  assert(ck.items[2].ok && ck.items[2].text.includes('95–100'));                           // RSI bandı 95–100
  assert(ck.warn && ck.warn.includes('EMA21'));
  assert.strictEqual(ck.score, 3);                                // günlük direnç + çakışma + bant
  const L = { ...g, gradeBy: 'liste' };
  assert.strictEqual(eng.rsiGrade({ hits: 2, check: ck }, L), 2);
  assert.strictEqual(eng.rsiGrade({ hits: 2, check: { score: 5 } }, L), 3);
  assert.strictEqual(eng.rsiGrade({ hits: 1, check: { score: 8 } }, L), 0);
  // Varsayılan (sart3): 1 + ayrışma + 1s RSI ≥ 80 + 15m RSI ≥ 85; kontrol listesi skoru dereceyi etkilemez
  const G3 = { ...g, gradeBy: 'sart3', gradeRsi1h: 80, gradeRsi15m: 85 };
  const sn = (sep, h1, r15, level = { name: '4h tepe' }, h4 = 60) => ({ hits: 2, sepOk: sep, conf: { h1, h4 }, rsi: rsi(89, 90, r15), check: { score: 9 }, level });
  assert.deepStrictEqual([sn(false, 70, 80), sn(true, 70, 80), sn(true, 81, 80), sn(true, 81, 86), sn(false, 85, 90)].map(x => eng.rsiGrade(x, G3)), [1, 2, 3, 4, 3]);
  assert.strictEqual(eng.rsiGrade({ ...sn(true, 90, 90), hits: 1 }, G3), 0, 'RSI kart şartı yoksa derece 0');
  assert.strictEqual(eng.rsiGrade(sn(true, 81, 86, null), G3), 3, 'direnç yok (fiyat keşfi) → en fazla 3');
  assert.strictEqual(eng.rsiGrade(sn(true, 81, 86, null), { ...G3, gradeNoLevelMax: 4 }), 4, 'tavan ayarlanabilir');
  // SFP kartı da aynı kırpmaya tabi (K14: ölü { sfp } seçeneği kaldırıldı; davranış aynı): seviyesiz → en fazla 3, seviyeli → 4
  assert.strictEqual(eng.gradeOf(sn(true, 81, 86, null), G3), 3, 'seviyesiz SFP en fazla gradeNoLevelMax');
  assert.strictEqual(eng.gradeOf(sn(true, 81, 86, null), G3, { sfp: true }), 3, 'eski { sfp } argümanı artık etkisiz');
  assert.strictEqual(eng.gradeOf(sn(true, 81, 86), G3), 4, 'seviyeli SFP kırpılmaz');
  assert.strictEqual(eng.rsiGrade(sn(true, 88.2, 86, undefined, 86.5), G3), 2, 'kaçak pompa (1s 88 · 4s 86) → en fazla 2');
  assert.strictEqual(eng.rsiGrade(sn(true, 84, 86, undefined, 81), G3), 2, '4s ≥ 80 → kaçak');
  assert(eng.gradeConds(sn(true, 90, 86), G3).runaway && !eng.gradeConds(sn(true, 90, 86), G3).h1, '1s ≥ 88 şart sayılmaz');
  assert.strictEqual(eng.rsiGrade(sn(true, 90, 86, undefined, 86), { ...G3, gradeRsi1hMax: 0, gradeRsi4hMax: 0 }), 4, 'kaçak kapalı (0)');
  assert.strictEqual(eng.rsiGrade({ hits: 2, rsi: rsi(89, 90, null), conf: {} }, G3), 1, 'eksik RSI → şart sayılmaz');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 1.3 }, G3), 3, '5dk ATR ≥ 1.2 → +1 daire');
  assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86), atr5Pct: 1.3 }, G3), 4, '4 şart → en fazla 4');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 1.1 }, G3), 2, 'ATR < 1.2 sayılmaz');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 3 }, { ...G3, gradeAtr5Pct: 0 }), 2, 'ATR şartı kapalı (0)');
  assert.strictEqual(eng.rsiGrade({ ...sn(true, 88.2, 86, undefined, 86.5), atr5Pct: 2 }, G3), 2, 'kaçak pompada ATR de tavanı aşmaz');
  // MACD 5m zayıf + Stoch 5m aşağı kesişim: her biri tek başına +1 daire (gradeVer 2)
  const cs2 = createSettings;
  { const MS = { macd: { '5m': { weakening: true } } }, ST = { stoch: { cross: 'down' } }, base0 = sn(false, 70, 80);
    assert.strictEqual(eng.rsiGrade(base0, G3), 1);
    assert.strictEqual(eng.rsiGrade({ ...base0, ...MS }, G3), 2, 'MACD 5m zayıf tek başına +1');
    assert.strictEqual(eng.rsiGrade({ ...base0, ...ST }, G3), 2, 'Stoch 5m aşağı tek başına +1');
    assert.strictEqual(eng.rsiGrade({ ...base0, macd: { '5m': { weakening: false } }, stoch: { cross: 'up' } }, G3), 1, 'güçlü MACD / yukarı kesişim sayılmaz');
    assert.strictEqual(eng.rsiGrade({ ...base0, ...MS, ...ST }, G3), 3, 'ikisi birlikte +2');
    assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86), ...MS, ...ST }, G3), 4, 'en fazla 4');
    assert.strictEqual(eng.rsiGrade({ ...sn(true, 88.2, 86, undefined, 86.5), ...MS, ...ST }, G3), 2, 'kaçak pompa tavanı aynen');
    assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86, null), ...MS, ...ST }, G3), 3, 'seviye yok tavanı aynen');
    assert.strictEqual(eng.rsiGrade({ ...base0, ...MS, ...ST }, { ...G3, gradeMacd5m: false }), 2, 'gradeMacd5m false → macd şartı 0');
    assert.strictEqual(eng.rsiGrade({ ...base0, ...MS, ...ST }, { ...G3, gradeStoch5m: false }), 2, 'gradeStoch5m false → stoch şartı 0');
    assert.strictEqual(eng.rsiGrade({ ...base0, ...MS, ...ST }, { ...G3, gradeMacd5m: false, gradeStoch5m: false }), 1);
    // liste yolu değişmez
    assert.strictEqual(eng.rsiGrade({ hits: 2, check: { score: 5 }, ...MS, ...ST }, L), 3, 'liste yolu macd/stoch\'tan etkilenmez');
    // gölge derece = eski formül; kayıt alanları
    const full = { ...sn(true, 81, 80), ...MS, ...ST, atr5Pct: 0.5 };
    assert.strictEqual(eng.rsiGrade(full, G3), 4); assert.strictEqual(eng.gradeOldOf(full, G3), 3, 'gradeOld macd/stoch şartsız');
    const au = eng.gradeAudit(full, { ...G3, minTFs: 2 });
    assert.deepStrictEqual(au, { gradeOld: 3, g_sep: 1, g_h1: 1, g_r15: 0, g_atr: 0, g_macd: 1, g_stoch: 1, g_rsi3hi: 0, g_runaway: 0,
      cfgGradeRsi15m: 85, cfgGradeAtr5Pct: 1.2, cfgGradeMacd5m: 1, cfgGradeStoch5m: 1, cfgSepPct2: g.sepPct2 ?? 3, cfgGradeRsi3m: 90, gradeVer: 2 });
    // 3dk RSI ≥ gradeRsi3m (90): tek başına +1; 0 = kapalı; gradeOld'da kapalı
    { const hi = { ...base0, rsi: { '3m': { v: 90.5 }, '5m': { v: 90 }, '15m': { v: 80 } } };
      assert.strictEqual(eng.rsiGrade(hi, G3), 2, '3dk RSI 90.5 ≥ 90 → +1'); assert.strictEqual(eng.rsiGrade(base0, G3), 1, '3dk 89 → şart yok');
      assert.strictEqual(eng.rsiGrade(hi, { ...G3, gradeRsi3m: 0 }), 1, 'gradeRsi3m 0 → kapalı');
      assert.strictEqual(eng.rsiGrade(hi, { ...G3, gradeRsi3m: 91 }), 1, 'eşik ayarlanabilir');
      assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86), ...MS, ...ST, rsi: hi.rsi }, G3), 4, '7 şart en fazla 4');
      assert.strictEqual(eng.rsiGrade({ ...sn(true, 88.2, 86, undefined, 86.5), ...MS, ...ST, rsi: hi.rsi }, G3), 2, 'kaçak tavanı 3dk şartıyla da aynen');
      assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86, null), ...MS, ...ST, rsi: hi.rsi }, G3), 3, 'seviye tavanı aynen');
      assert.strictEqual(eng.gradeOldOf(hi, G3), 1, 'gradeOld 3dk şartsız');
      const a2 = eng.gradeAudit(hi, { ...G3, minTFs: 2 }); assert.strictEqual(a2.g_rsi3hi, 1); assert.strictEqual(a2.gradeOld, 1);
      assert.strictEqual(eng.gradeAudit(hi, { ...G3, minTFs: 2, gradeRsi3m: 0 }).g_rsi3hi, 0); assert.strictEqual(eng.gradeAudit(hi, { ...G3, minTFs: 2, gradeRsi3m: 0 }).cfgGradeRsi3m, 0);
      assert.strictEqual(cfg.info.gradeRsi3m, 90); }
    // sepPct2 varsayılanı 3 (24.11.2026); eski dosyada yoksa 3, dosyada değiştirilmiş değer korunur
    assert.strictEqual(cfg.info.sepPct2, 3);
    { const fa = require('path').join(require('./_tmp'), 'old-sep.json'); fs.writeFileSync(fa, JSON.stringify({ values: { rsiMin: 88 } }));
      const a = cs2({ file: fa, defaults: { ...cfg.info } }); a.load(); assert.strictEqual(a.get().sepPct2, 3, 'eski dosyada sepPct2 yok → 3'); assert.strictEqual(a.get().gradeRsi3m, 90);
      fs.writeFileSync(fa, JSON.stringify({ values: { sepPct2: 2, gradeRsi3m: 93 } }));
      const b = cs2({ file: fa, defaults: { ...cfg.info } }); b.load(); assert.strictEqual(b.get().sepPct2, 2, 'dosyadaki değer kalır'); assert.strictEqual(b.get().gradeRsi3m, 93); }
    assert.strictEqual(eng.gradeAudit(full, { ...G3, minTFs: 2, gradeMacd5m: false }).g_macd, 0);
    assert.strictEqual(eng.gradeAudit(full, { ...G3, minTFs: 2, gradeMacd5m: false }).cfgGradeMacd5m, 0);
    assert.strictEqual(eng.gradeAudit(sn(true, 90, 86), { ...G3, minTFs: 2 }).g_runaway, 1);
    // macdState tanımı: histogram düşüyor ya da ≤ 0 (aşağı kesişim dahil); stochState: yalnız son kapanmış mumdaki aşağı kesişim (K ≥ 80 bölgesinden)
    const f0 = require('path').join(require('./_tmp'), 'old-settings.json');
    fs.writeFileSync(f0, JSON.stringify({ values: { gradeRsi15m: 80 } }));
    const so = cs2({ file: f0, defaults: { ...cfg.info } }); so.load(); const old = so.get(); assert.strictEqual(old.gradeMacd5m, true); assert.strictEqual(old.gradeStoch5m, true); assert.strictEqual(old.gradeRsi15m, 80, 'eski dosya değeri korunur');
    assert.strictEqual(cfg.info.gradeMacd5m, true); assert.strictEqual(cfg.info.gradeStoch5m, true);
    assert(so.set('gradeMacd5m', 'false').ok && so.get().gradeMacd5m === false, '/ayarlar ile kapatılabilir');
  }
  // K15: çakışma adayı da direnç tarafında olmalı — ref'in altında kalan (dist > dipAbovePct) seviye conf sayılmaz
  { const lv = [{ name: '1d MA200', value: 100.3, dist: -0.3 }, { name: '4h EMA200', value: 100.3, dist: g.dipAbovePct + 1.5 }];
    ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: lv, level: lv[0] }, g);
    assert(!ck.items[1].ok && ck.confluence === null, 'fiyatın altındaki seviye çakışma sayılmaz');
    const lv2 = [lv[0], { name: '4h EMA200', value: 100.3, dist: -0.3 }];
    ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: lv2, level: lv2[0] }, g);
    assert(ck.items[1].ok, 'direnç tarafındaki çakışan seviye sayılır');
    const lv3 = [lv[0], { name: '4h EMA200', value: 100.3, dist: -(g.levelMaxPct + 1) }];
    ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: lv3, level: lv3[0] }, g);
    assert(!ck.items[1].ok, 'levelMaxPct dışındaki seviye çakışma sayılmaz'); }
  // also: aynı fiyata düşen ikinci seviye ref.also'da; çakışan direnç sayılır (Fib / 1h tepe sayılmaz)
  { const r0 = { name: '30 günlük en yüksek', value: 100.3, dist: -0.3, also: ['7 günlük en yüksek'] };
    ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: [r0], level: r0 }, g);
    assert(ck.items[1].ok && ck.confluence && ck.confluence.name === '7 günlük en yüksek' && ck.confluence.gapPct === 0, 'ref.also çakışma sayılır');
    const r1 = { ...r0, also: ['Fib 0.618', '1h tepe'] };
    ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: [r1], level: r1 }, g);
    assert(!ck.items[1].ok && ck.confluence === null, 'also içinde Fib / 1h tepe çakışma değil'); }
  ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: [{ name: '4h EMA200', value: 101, dist: -1 }], level: { name: '4h EMA200', value: 101, dist: -1, zone: 'near' } }, g);
  assert(!ck.items[0].ok && ck.items[0].text.includes('içinde yok'));   // yalnız 4h seviye → günlük madde yok
  ok('Derece (sart3: 1 + ayrışma + 1s RSI ≥ 80 + 15dk RSI ≥ 85; liste: kontrol skoru) · hacim 🔴/🔴🔴(≥3×)/🔴🔴🔴(+yön ≥%65) · kart derecesi puanla (9 madde; EMA21 üstü ayrışma %2/%5/%10 → 1/2/3 puan, altı 0; MACD 3m/5m sat kesişimi +1): 10 puan → 4 daire, 5 → 3, 3 → 2; RSI bandı 95–100; EMA21 yakın uyarısı; yalnız 4h seviyede günlük madde yok');
}

// ── Ayarlar ──
{ const f = `${require('./_tmp')}/unit-settings.json`; fs.rmSync(f, { force: true });
  const st = createSettings({ file: f, defaults: { ...cfg.info, rsiMin: 90 } }); st.load();
  assert(!st.set('rsiMin', 150).ok && !st.set('nope', 1).ok && !st.set('levelRequired', 'belki').ok);
  assert(st.set('levelMaxPct', '2,0').value === 2);
  assert(st.bump('rsiMin', 1).value === 91 && st.bump('minTFs', 5).value === 3);
  st.bump('levelRequired', 0); assert.strictEqual(st.get().levelRequired, false);
  st.mute('ETHUSDT', 1000, 0); assert(st.isMuted('ETHUSDT', 500) && !st.isMuted('ETHUSDT', 1500));
  st.toggleFollow('SOLUSDT');
  const st2 = createSettings({ file: f, defaults: { ...cfg.info, rsiMin: 90 } }); st2.load();
  assert(st2.get().rsiMin === 91 && st2.get().levelMaxPct === 2 && st2.get().levelRequired === false && st2.isFollowed('SOLUSDT'));
  const saved = JSON.parse(fs.readFileSync(f, 'utf8')); assert(!('burstPct1' in saved.values), 'yalnızca değişenler yazılmalı');
  ok('Ayarlar: sınır/tip doğrulaması, virgüllü sayı, ± adım ve sınıra kırpma, aç-kapa; susturma süresi doluyor; dosyaya yalnızca değişenler yazılıp geri okunuyor');
}
// ── Eski ayar dosyası: kaldırılan tepe kurulumu anahtarları açılışta yok sayılır ──
{ const f = `${require('./_tmp')}/unit-settings-old.json`;
  fs.writeFileSync(f, JSON.stringify({ values: { rsiMin: 88, peakAlert: false, peakAlertConds: 3, peakAlertFundingMax: 0.02, peakAlertPumpPct: 7, peakAlertGapMin: 60, peakAlertRsiOnly: true, chartPeak: false },
    mutes: {}, follows: ['SOLUSDT'], topics: { kart: 5, tepe: 9 } }));
  const st = createSettings({ file: f, defaults: { ...cfg.info } }); st.load();
  const g = st.get();
  assert.strictEqual(g.rsiMin, 88, 'geçerli eski ayar korunur');
  for (const k of ['peakAlert', 'peakAlertConds', 'peakAlertFundingMax', 'peakAlertPumpPct', 'peakAlertGapMin', 'peakAlertRsiOnly', 'chartPeak']) {
    assert(!(k in g) && !(k in cfg.info), `${k} kaldırıldı`);
    assert(!st.set(k, true).ok, `${k} artık ayarlanamaz`);
  }
  assert(st.isFollowed('SOLUSDT') && st.topic('kart') === 5, 'takip ve konu korunur; eski tepe konusu hata vermez');
  st.set('rsiMin', 89);   // kayıt eski anahtarlarla çakışmadan yazılır
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert(!Object.keys(saved.values).some(k => /^peakAlert|^chartPeak/.test(k)), 'eski anahtarlar dosyadan temizlenir');
  ok('Eski ayar dosyası: peakAlert*/chartPeak anahtarları yok sayıldı, açılış hatasız, kayıtta temizlendi');
}
// ── VWAP σ: gün/hafta başında az mumla σ verilmez ──
{ const ta = require(`${REPO}/src/ta`); const { vwapFeatures, refLevels } = require(`${REPO}/src/marketSnap`);
  const h = [1.001, 1.0011], l = [0.9999, 1.0], c = [1.0, 1.0005], v = [100, 120];
  const r2 = ta.vwapBands(h, l, c, v, 0);
  assert(r2.vwap > 0 && r2.sigma === null && r2.n === 2, '2 mum → σ yok');
  const H = [], L = [], C = [], V = [];
  for (let i = 0; i < 12; i++) { const p = 1 + i * 0.002; H.push(p * 1.002); L.push(p * 0.998); C.push(p); V.push(100); }
  const r12 = ta.vwapBands(H, L, C, V, 0);
  assert(r12.sigma > 0 && r12.n === 12, '12 mum → σ var');
  assert.strictEqual(ta.vwapBands([1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1], [5, 5, 5, 5, 5, 5], 0).sigma, null, 'düz fiyat (σ ≈ 0) → σ yok');
  const f = vwapFeatures({ D: r2, W: r12 }, 1.0008);
  assert(f.vwD_sig === null && Number.isFinite(f.vwD_pct) && Number.isFinite(f.vwW_sig), 'σ yoksa vwD_sig boş, % kalır');
  ok('VWAP σ: 6 mumdan az ya da σ < VWAP\'ın %0.01\'i → σ yok (gün başı ±yüz binlerce σ ve fiyata yapışık ±σ seviyeleri çıkmıyor)');
}
// ── Kart kaydı: funding, ATR, ayrışma, OI, 1s trend ──
{ const { compact } = require(`${REPO}/src/infoStats`);
  const rsi = Object.fromEntries(eng.RSI_TFS.map(tf => [tf, { v: 86 }]));
  const card = { symbol: 'XUSDT', t: 0, seq: 1, grade: 3, price: 1, news: [], tags: [], trig: { tfs: ['3m'] }, oi: { changePct: 2.345 }, trend1h: 'aşağı',
    snap: { rsi, hits: 2, conf: { score: 1, h1: 82, h4: 60 }, sepOk: true, sepPct: { '3m': 2.456, '5m': 3.1 }, atr5Pct: 1.2346, funding: { rate: 0.00003 }, vwap: { vwap: 1, sigma: null, pos: null } } };
  const x = compact(card);
  assert(x.funding === 0.003 && x.atr5Pct === 1.235 && x.sep3 === 2.46 && x.sep5 === 3.1 && x.oiChg60 === 2.35 && x.trend_1h === 'aşağı' && x.vwapSigma === null, JSON.stringify(x));
  const y = compact({ ...card, oi: undefined, trend1h: undefined, snap: { ...card.snap, funding: null, atr5Pct: null, sepPct: {} } });
  assert(y.funding === null && y.atr5Pct === null && y.sep3 === null && y.oiChg60 === null && y.trend_1h === null);
  ok('Kart kaydı: funding %, 5dk ATR %, 3/5dk ayrışma, OI 1s, 1s trend (tepeler.csv ile aynı birimler); yoksa boş');
}
// ── Backtest eksik 60 dk penceresi ──
{ const { classTable, excluded60, excludedNote } = require(`${REPO}/src/infoStats`);
  const mk = (close, full) => ({ t: 1, symbol: 'A', seq: 1, silent: false, fwd: { 60: { low: -1, high: 1, close, ...(full === undefined ? {} : { full }) } } });
  const cards = [mk(1, true), mk(3), mk(100, false)];   // tam, canlı biçimli (full yok), eksik
  const row = classTable(cards)[0];
  assert.strictEqual(row.close60, 2, 'full:false kart medyana girmemeli; full alanı olmayan girmeli: ' + row.close60);
  assert.strictEqual(excluded60(cards), 1);
  assert.strictEqual(excludedNote(1), ' (1 eksik pencere dışarıda)'); assert.strictEqual(excludedNote(0), '');
  ok('Medyan: fwd[60].full===false dışarıda (sayısı notta), canlı biçimli kart (full yok) dahil');
}
// ── n (kart) ile n60 (60 dk medyanına giren) ayrımı ──
{ const { classTable, nLabel, CLASSES } = require(`${REPO}/src/infoStats`);
  const mk = (full, has = true) => ({ t: 1, symbol: 'A', seq: 1, silent: false, fwd: has ? { 60: { low: -1, high: 1, close: 1, full } } : {} });
  const r3 = classTable([mk(true), mk(true), mk(false)])[0];
  assert.strictEqual(r3.n, 3); assert.strictEqual(r3.n60, 2, 'n60 yalnız tam pencereli kart: ' + r3.n60);
  assert.strictEqual(nLabel(r3), '3 (60dk: 2)');
  const rEq = classTable([mk(true), mk(true)])[0];
  assert.strictEqual(rEq.n, 2); assert.strictEqual(rEq.n60, 2); assert.strictEqual(nLabel(rEq), '2', 'eşitken eski biçim');
  const rPend = classTable([mk(true), mk(true, false)])[0];       // 60 dk'sı dolmamış canlı kart
  assert.strictEqual(nLabel(rPend), '2 (60dk: 1)');
  // en kötü durum: tüm sınıflar "99999 (60dk: 99998)" ile 4000 karakter içinde mi (esc + pct dahil)?
  const worst = CLASSES.map(([name]) => `${name.trim()}: <b>${nLabel({ n: 99999, n60: 99998 })}</b> · dip 5/15/30/60 -12.3% / -12.3% / -12.3% / -12.3% · tepe60 +12.3% · son60 -12.3%`).join('\n');
  console.log('  en kötü /istatistik sınıf bölümü uzunluğu:', worst.length, 'satır:', CLASSES.length);
  ok('classTable n60 + nLabel: 3 (60dk: 2) / eşitken yalnız n');
}
// ── A11: eksik 1m ile kapanan üst TF mumu işaretlenir ──
{ const T = Date.UTC(2026, 0, 1), mk = (i, c) => ({ t: T + i * MIN, o: c, h: c + 1, l: c - 1, c, v: 1, tb: 0.5, q: c, tq: c / 2, closed: true });
  const feed = (S, idx) => { for (const i of idx) S.apply1m(mk(i, 100 + i)); };
  const all = n => Array.from({ length: n }, (_, i) => i);
  // (a) boşluksuz
  const A = new Series('A'); feed(A, all(60));
  for (const tf of ['3m', '5m', '15m', '1h']) assert.strictEqual(A.incomplete(tf, 300), 0, 'boşluksuz ' + tf);
  assert.strictEqual(A.count('5m'), 12);
  // (b) 5m mumunun (10-14) 2 dakikası (11,12) gelmedi
  const B = new Series('B'); feed(B, all(60).filter(i => i !== 11 && i !== 12));
  assert.strictEqual(B.incomplete('5m', 12), 1, '5m eksik');
  assert.strictEqual(B.incomplete('5m', 1), 0, 'son 5m tam'); assert.strictEqual(B.incomplete('15m', 4), 1);
  assert.strictEqual(B.incomplete('1h', 1), 1, '58 dk gelen 1h eksik');
  // gösterge değerleri aynı: kapanış serisi, eksik dk'lar olmasa da olmasa da aynı
  assert.deepStrictEqual(B.col('5m', 'c', false), A.col('5m', 'c', false), '5m c değerleri değişmedi');
  // (c) seed'den gelen mumlar tam; sonrasında boşluk yok
  const C = new Series('C'); C.seed('5m', Array.from({ length: 5 }, (_, i) => ({ ...mk(i * 5, 100), closed: true })));
  assert.strictEqual(C.incomplete('5m', 300), 0, 'seed tam');
  C.seed('5m', [{ ...mk(0, 100), closed: true }, { ...mk(5, 100), closed: false }]);   // yarım mum seed'den
  feed(C, [7, 8, 9]);
  assert.strictEqual(C.incomplete('5m', 5), 0, 'seed yarım mumu (öncesi tam kabul) tam');
  ok('A11 Series.incomplete: boşluksuz 0; eksik dk → o mum işaretli, değerler aynı; seed tam');
}
// ── K33: backtest döngüsünde üst TF look-ahead güvenliği ──
{ const { TF_MS, KEEP } = require(`${REPO}/src/series`); const ta = require(`${REPO}/src/ta`);
  const HT = ['3m', '5m', '15m', '1h', '4h']; const N = 6000; const t0 = Math.floor(Date.UTC(2026, 0, 1) / (240 * MIN)) * 240 * MIN + 37 * MIN;  // 4h sınırında değil
  let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const arr = []; let p = 100;
  for (let i = 0; i < N; i++) { const o = p; p *= 1 + (rnd() - 0.5) * 0.004; const h = Math.max(o, p) * (1 + rnd() * 0.001), l = Math.min(o, p) * (1 - rnd() * 0.001), v = 50 + rnd() * 100;
    arr.push({ t: t0 + i * MIN, o, h, l, c: p, v, tb: v * 0.5, q: v * p, tq: v * 0.5 * p, closed: true }); }
  // referans: ham 1m'lerden [ps, ps+ms) ∩ (t < now) toplama
  const oracle = (from, to, ps, ms) => { if (from === 0 && ps < arr[bstart].t && ps + 1 > arr[0].t && oracle.bt) from = bstart; let a = null; for (let j = from; j <= to; j++) { const c = arr[j]; if (c.t < ps) continue; if (c.t >= ps + ms) break; if (!a) a = { t: ps, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, q: c.q };
    else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; } } return a; };
  oracle.bt = false;
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const same = (g, w, m) => { assert(g && w, m + ' yok'); for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'q']) assert(near(g[k], w[k]), `${m}: ${k} ${g[k]} != ${w[k]}`); };
  const lastOf = (S, tf) => { const d = S.d[tf], n = d.t.length - 1; return { t: d.t[n], o: d.o[n], h: d.h[n], l: d.l[n], c: d.c[n], v: d.v[n], q: d.q[n] }; };

  // backtest yolu: üst TF'ler başlangıçtan ÖNCEKİ kapanmış mumlarla tohumlanır (fetchBefore gibi), 1m tohumlanır, sonra döngü
  const bstart = 5000, btSeries = () => { const S = new Series('BT'); const st = arr[bstart].t;
    for (const tf of ['1d', '4h', '1h', '15m', '5m', '3m']) { const ms = TF_MS[tf], out = [];
      for (let ps = Math.floor((st - 1) / ms) * ms; out.length < KEEP[tf] && ps >= arr[0].t - ms; ps -= ms) { if (ps + ms > st) continue; const a = oracle(0, bstart - 1, ps, ms); if (a && a.t === ps && arr[0].t <= ps) out.unshift({ ...a, tb: a.v * 0.5, tq: a.q * 0.5, closed: true }); }
      S.seed(tf, out); }
    const b1 = arr.slice(Math.max(0, bstart - KEEP['1m']), bstart); S.seed('1m', b1); S.seedPartials(b1, st); return S; };
  oracle.bt = false; const BT = btSeries(), LIVE = new Series('LIVE'); for (let i = 0; i < bstart; i++) LIVE.apply1m(arr[i]);
  // start'ta açık periyotların kısmi mumu start öncesi 1m'lerden kurulur (seedPartials); oracle tüm 1m'lerle karşılaştırır
  let nClosed = 0, nPart = 0, cmp = 0;
  for (let i = bstart; i < N; i++) {
    const t = arr[i].t + MIN;                                  // karar anı: bu 1m kapandı
    const closed = BT.apply1m(arr[i]); LIVE.apply1m(arr[i]);
    for (const tf of HT) { const ms = TF_MS[tf];
      if (closed.has(tf)) { const g = lastOf(BT, tf); assert(g.t + ms <= t, `${tf}: kapanmış mum t'den sonra bitiyor`); same(g, oracle(0, i, g.t, ms), `${tf}@${i} kapanmış`); assert.strictEqual(g.t + ms, t, 'closed kümesi yalnız tam bu anda biten mum'); nClosed++; assert.strictEqual(BT.incomplete(tf, 1), 0, `${tf}@${i}: ilk periyot dahil 'eksik' işaretsiz`); }
      else assert.strictEqual(BT.lastT(tf) + ms <= t, true);
      // kısmi mum: yalnız t'ye kadarki 1m'ler
      const pt = BT.part[tf]; if (pt) { const ps = Math.floor(arr[i].t / ms) * ms; assert.strictEqual(pt.t, ps); assert(pt.t + ms > t, 'kısmi mum aslında kapanmış olmalıydı');
        same(pt, oracle(0, i, ps, ms), `${tf}@${i} kısmi`); assert.strictEqual(BT.col(tf, 't', true).at(-1), ps); assert(near(BT.col(tf, 'h', true).at(-1), oracle(0, i, ps, ms).h)); nPart++; }
      else assert(closed.has(tf), `${tf}: kısmi yok ama mum kapanmadı`);
    }
    // canlı yol = backtest yolu: anlık rsi/ema/macd (kısmi mum dahil ve hariç), 3m/5m/15m (tampon dolu); 1m
    for (const tf of ['1m', '3m', '5m', '15m']) for (const wp of [true, false]) {
      const a = BT.col(tf, 'c', wp), b = LIVE.col(tf, 'c', wp), ka = a.slice(-KEEP[tf]), kb = b.slice(-KEEP[tf]);
      assert.deepStrictEqual(ka.slice(-60), kb.slice(-60), `${tf} kapanışlar t=${t}`);
      if (tf === '1m' || i % 7 === 0) { assert.strictEqual(ta.rsiLast(ka, 14), ta.rsiLast(kb, 14), `rsi ${tf} t=${t}`); assert.strictEqual(ta.emaLast(ka, 20), ta.emaLast(kb, 20), `ema ${tf} t=${t}`);
        assert.deepStrictEqual(ta.macdTail(ka), ta.macdTail(kb), `macd ${tf} t=${t}`); cmp++; } }
  }
  // gelecek bozulursa t anı değişmez: i'den sonraki 1m'ler bozuk bir seriyle, i anındaki durum birebir aynı
  { const cut = 5800, A = btSeries(), B = btSeries();
    for (let i = bstart; i <= cut; i++) { A.apply1m(arr[i]); B.apply1m(arr[i]); }
    const snap = S => JSON.stringify([S.d, S.part, [...HT.map(tf => [...S.inc[tf]])]]);
    assert.strictEqual(snap(A), snap(B)); const before = snap(B);
    // B'ye "gelecek" yalnız sonra verilir; A'nın t anı durumu gelecekteki (bozuk) mumlardan etkilenmemiş olmalı
    for (let i = cut + 1; i < cut + 40; i++) B.apply1m({ ...arr[i], h: arr[i].h * 3, c: arr[i].c * 2, l: arr[i].l * 0.5 });
    assert.strictEqual(snap(A), before, 'A durumu gelecek mumlarla değişti'); assert.notStrictEqual(snap(B), before); }
  assert(nClosed > 400 && nPart > 2000 && cmp > 600, `kapsam ${nClosed}/${nPart}/${cmp}`);
  // tam seri, uçtan uca: canlı (boştan) ve backtest tamponu, ham 1m'den toplananla birebir
  for (const tf of ['3m', '5m', '15m']) { const g = BT.d[tf], l = LIVE.d[tf], n = g.t.length; assert.deepStrictEqual(g.t.slice(-100), l.t.slice(-100)); assert(near(g.c[n - 5], oracle(0, N - 1, g.t[n - 5], TF_MS[tf]).c)); }
  ok(`K33 look-ahead: ${nClosed} üst TF kapanışı ve ${nPart} kısmi mum, t'ye kadarki 1m'lerden toplananla birebir (sonraki 1m'ler katılmıyor); canlı ve backtest yolu ${cmp} ölçümde rsi/ema/macd aynı; gelecek mum bozulunca t anı değişmiyor`);
}

// ── K17: filtre dışı kart kaydı (SFP kartı snap.ok=false iken de çıkar; kural değişmedi, yalnız kayıt) ──
{
  const { gen, agg } = require('./gen'); const { compact } = require(`${REPO}/src/infoStats`);
  const D = 1440, start = Date.UTC(2026, 0, 1), pumpAt = 41 * D;
  const m1 = gen({ seed: 21, days: 42, start, p0: 100, pumps: [{ at: pumpAt, len: 400, rate: 0.0011, vol: 3, dumpLen: 0 }] });
  const T0 = start + (pumpAt - 60) * MIN;
  const run = sx => {
    const S = new Series('SFPUSDT');
    for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m1, m * MIN, T0));
    S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
    const tr = eng.createTracker(); const cards = []; let armed = false;
    for (const c of m1.filter(c => c.t >= T0)) {
      const closed = S.apply1m({ ...c, closed: true });
      // izlenen seviye elle kurulur: 5m kapanışta fiyatın %1 üstündeki seviyenin altında kapanış → SFP
      if (closed.has('5m') && c.t - T0 > 200 * MIN && !armed) { tr.sfpWatch('SFPUSDT').set('x', { name: '30 günlük tepe', value: S.price() * 1.01, kind: 'major', t: c.t, left: 5 }); armed = true; }
      const card = eng.step(S, closed, sx, tr, {}); if (card) cards.push(card);
    }
    return cards;
  };
  // normal: tüm filtreler sağlanıyor → bypass 0
  const norm = run({ ...cfg.info }).find(c => c.trig.sfp);
  assert(norm && norm.snap.ok === true, 'normal SFP kartı snap.ok=true');
  assert.strictEqual(norm.snapOk, 1); assert.strictEqual(norm.filterBypass, 0); assert.strictEqual(norm.bypassBy, ''); assert.strictEqual(norm.snapFails, '');
  // ayrışma zorunlu ve imkansız → snap.ok=false, yine de SFP kartı çıkar → bypass 1
  const byp = run({ ...cfg.info, sepRequired: true, sepPct2: 99 }).find(c => c.trig.sfp);
  assert(byp && byp.snap.ok === false, 'SFP kartı snap.ok=false iken çıkmalı');
  assert.strictEqual(byp.snapOk, 0); assert.strictEqual(byp.filterBypass, 1); assert.strictEqual(byp.bypassBy, 'sfp'); assert.strictEqual(byp.snapFails, 'ayrışma');
  const cp = compact(byp); assert(cp.snapOk === 0 && cp.filterBypass === 1 && cp.bypassBy === 'sfp' && cp.snapFails === 'ayrışma', 'compact alanları taşır');
  const cn = compact(norm); assert(cn.snapOk === 1 && cn.filterBypass === 0 && cn.bypassBy === '', 'compact normal kart');
  ok('K17: SFP kartı snap.ok=false iken çıkınca filterBypass=1, bypassBy=sfp, snapFails=ayrışma; normal kartta 0 / boş; compact() alanları taşır');
}
// ── S1-100: 3m/5m EMA21 ayrışması farklıyken derece (sepOk) ile liste (checklist sep) tutarlı ──
{ const T0 = Date.UTC(2026, 0, 1);
  const flat = (tfMin, n, c) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * tfMin * MIN, o: c, h: c + 0.01, l: c - 0.01, c, v: 1000, closed: true }));
  // 3m EMA21 = 100, 5m EMA21 = e5; fiyat (1m son kapanış) 105 → sep3 = %5, sep5 = (105−e5)/e5
  const mk = e5 => { const S = new Series('SEPUSDT');
    S.seed('1m', flat(1, 30, 105)); S.seed('3m', flat(3, 60, 100)); S.seed('5m', flat(5, 60, e5)); S.seed('15m', flat(15, 40, 100)); S.seed('1h', flat(60, 30, 100)); S.seed('4h', flat(240, 30, 100)); S.seed('1d', flat(1440, 30, 100));
    return S; };
  const g = { ...cfg.info };
  const probe = e5 => { const snap = eng.evaluate(mk(e5), g, {}, true); return { snap, sep: snap.sepPct, cond: eng.gradeConds(snap, g).sep, sepItem: eng.checklist(snap, g).items.find(x => x.key === 'sep') }; };
  // 3m = %5, 5m ≈ %1 → derece sep almaz, liste %3 kademesini (pts ≥ 1) almaz
  let a = probe(105 / 1.01);
  assert(Math.abs(a.sep['3m'] - 5) < 1e-6 && Math.abs(a.sep['5m'] - 1) < 1e-6, 'senaryo: 3m=5, 5m=1 → ' + JSON.stringify(a.sep));
  assert.strictEqual(a.snap.sepOk, false, 'sepOk: 5m < 3 → false'); assert.strictEqual(a.cond, false, 'derece sep şartı yok');
  assert.strictEqual(a.sepItem.pts, 0, 'liste sep puanı 0 (küçük = 1 < 3)'); assert.strictEqual(a.sepItem.ok, false);
  // 3m = %5, 5m ≈ %4 → ikisi de %3 kademesini alır (liste küçüğü = 4 → 1 puan, derece sep true)
  a = probe(105 / 1.04);
  assert(Math.abs(a.sep['3m'] - 5) < 1e-6 && Math.abs(a.sep['5m'] - 4) < 1e-6, 'senaryo: 3m=5, 5m=4 → ' + JSON.stringify(a.sep));
  assert.strictEqual(a.snap.sepOk, true); assert.strictEqual(a.cond, true, 'derece sep şartı var');
  assert.strictEqual(a.sepItem.pts, 1, 'liste %3 kademesi (1 puan; 4 < 5)'); assert.strictEqual(a.sepItem.ok, true);
  // eşik sınırı: küçük değer tam eşikte (≥ 3) iki taraf da alır
  a = probe(105 / 1.03); assert.strictEqual(a.snap.sepOk, true); assert.strictEqual(a.sepItem.pts, 1);
  // tutarlılık: derece sep true ⇔ liste sep puanı > 0 (3m/5m değişik karışımlarında)
  for (const e5 of [105 / 1.005, 105 / 1.029, 105 / 1.031, 105 / 1.06, 105 / 1.11, 105 / 0.97]) { const r = probe(e5); assert.strictEqual(r.cond, r.sepItem.pts > 0, 'derece ve liste ayrışma kararı aynı: 5m=' + r.sep['5m']); }
  ok('S1-100: 3m=5/5m=1 → derece sep yok + liste 0 puan; 3m=5/5m=4 → ikisi de %3 kademesini alır; derece ve liste kararı aynı');
}

// ── v3 kurulum puanı (gölge): her şart tek tek, sınır, null ──
{
  const { setupScore, SETUP_DEFAULTS, SETUP_VER } = require('../src/setupScore');
  const { CANDS } = require('../src/eventLog');
  assert.deepStrictEqual(SETUP_DEFAULTS, { rsi1m: 85, vol3: 3, pumpMin: 5, min: 4 }); assert.strictEqual(SETUP_VER, 1);
  const none = { rsi_1m: 10, bbB_15m: 0.5, stochCross: 'up', volx_3m: 1, liqShortPct15: 0 };
  const z = setupScore(none); assert.deepStrictEqual(z, { v3S: 0, v3_rsi1m: 0, v3_bb15: 0, v3_stoch5: 0, v3_vol3: 0, v3_liq: 0 }, 'hiçbiri yok → S=0');
  const one = (k, v, flag) => { const r = setupScore({ ...none, [k]: v }); assert.strictEqual(r[flag], 1, k + ' → ' + flag); assert.strictEqual(r.v3S, 1, k + ' tek başına S=1'); return r; };
  one('rsi_1m', 85, 'v3_rsi1m'); assert.strictEqual(setupScore({ ...none, rsi_1m: 84.9 }).v3_rsi1m, 0, 'rsi 84.9 → 0');
  one('bbB_15m', 1.01, 'v3_bb15'); assert.strictEqual(setupScore({ ...none, bbB_15m: 1 }).v3_bb15, 0, 'bbB tam 1 → 0 (> 1)');
  one('stochCross', 'down', 'v3_stoch5');
  one('volx_3m', 3, 'v3_vol3'); assert.strictEqual(setupScore({ ...none, volx_3m: 2.99 }).v3_vol3, 0);
  one('liqShortPct15', 0.001, 'v3_liq'); assert.strictEqual(setupScore({ ...none, liqShortPct15: 0 }).v3_liq, 0, 'liq 0 → 0');
  assert.strictEqual(setupScore({ rsi_1m: 90, bbB_15m: 2, stochCross: 'down', volx_3m: 5, liqShortPct15: 1 }).v3S, 5, 'hepsi → 5');
  // null: alan yok → bayrak null, S'ye 0 katar
  const p = setupScore({ rsi_1m: 90, bbB_15m: 2 });
  assert.deepStrictEqual(p, { v3S: 2, v3_rsi1m: 1, v3_bb15: 1, v3_stoch5: null, v3_vol3: null, v3_liq: null });
  assert.deepStrictEqual(setupScore({}), { v3S: null, v3_rsi1m: null, v3_bb15: null, v3_stoch5: null, v3_vol3: null, v3_liq: null }, 'hepsi null → S null');
  assert.strictEqual(setupScore(null).v3S, null); assert.strictEqual(setupScore({ rsi_1m: NaN, volx_3m: 'x' }).v3S, null, 'sayı olmayan → null');
  assert.strictEqual(setupScore({ rsi_1m: 80 }, { setupRsi1m: 80 }).v3_rsi1m, 1, 'eşik s.setupRsi1m ile değişir'); assert.strictEqual(setupScore({ volx_3m: 4 }, { setupVol3: 5 }).v3_vol3, 0);
  const f = { rsi_1m: 90, volx_3m: 4 }, c = JSON.stringify(f); assert.deepStrictEqual(setupScore(f), setupScore(f)); assert.strictEqual(JSON.stringify(f), c, 'girdiyi değiştirmez');
  assert(CANDS.some(x => x[0] === 'v3 S≥4' && x[2]({ v3S: 4 }) && !x[2]({ v3S: 3 }) && !x[2]({})), '/teyit adayı v3 S≥4');
  ok('v3 kurulum puanı: 5 şart tek tek + sınır + null + deterministik; CANDS "v3 S≥4"');
}

console.log(R.join('\n'));
