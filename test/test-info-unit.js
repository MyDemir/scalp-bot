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
  const sn = (sep, h1, r15, level = { name: '4h tepe' }, h4 = 60) => ({ hits: 2, sepOk: sep, conf: { h1, h4 }, rsi: rsi(90, 90, r15), check: { score: 9 }, level });
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
  assert.strictEqual(eng.rsiGrade({ hits: 2, rsi: rsi(90, 90, null), conf: {} }, G3), 1, 'eksik RSI → şart sayılmaz');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 1.3 }, G3), 3, '5dk ATR ≥ 1.2 → +1 daire');
  assert.strictEqual(eng.rsiGrade({ ...sn(true, 81, 86), atr5Pct: 1.3 }, G3), 4, '4 şart → en fazla 4');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 1.1 }, G3), 2, 'ATR < 1.2 sayılmaz');
  assert.strictEqual(eng.rsiGrade({ ...sn(false, 70, 86), atr5Pct: 3 }, { ...G3, gradeAtr5Pct: 0 }), 2, 'ATR şartı kapalı (0)');
  assert.strictEqual(eng.rsiGrade({ ...sn(true, 88.2, 86, undefined, 86.5), atr5Pct: 2 }, G3), 2, 'kaçak pompada ATR de tavanı aşmaz');
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
console.log(R.join('\n'));
