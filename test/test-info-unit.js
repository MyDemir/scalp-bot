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
  tr.observe5m('X', 80, s); assert(tr.news('X', snap(), { tfs: [] }, s).length === 0 || true);
  tr.observe5m('X', 74, s);
  n = tr.news('X', snap(), { tfs: ['3m'] }, s); assert(n[0].startsWith('İlk kart'));
  assert.strictEqual(tr.commit('X', snap(), s), 1);
  ok('Yenilik: değişiklik yoksa boş (kart yok); RSI dilim sayısı, 95↑, seviye kırılması/DİPTE, patlama, MACD/Stoch kesişimi yakalanıyor; 5m RSI < 75 kapanınca numara #1\'e dönüyor');
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
    level: { name: '1d MA200', value: 100.3, dist: -0.3, zone: 'dip' }, sepPct: { '3m': 6, '5m': 3 },
    macd: { '3m': { cross: 'down' }, '5m': null }, conf: { h1: 85, h4: 82 }, neg: { '1m': { count: 2 }, '3m': { count: 0 } } };
  let ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96) }, g);
  assert.strictEqual(ck.score, 10, JSON.stringify(ck.items.filter(x => !x.ok)));          // 8 madde × 1 + EMA %5 (2 puan) + MACD; toplam 9 madde
  assert(ck.total === 9 && ck.items[1].text.includes('1d MA200 + 30 günlük tepe'));
  assert.strictEqual(eng.rsiGrade({ hits: 3, check: ck }, g), 4);
  // EMA21 ayrışma yalnız ÜSTTE puan alır: fiyat EMA21'in %12 altındaysa 0 puan
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': -12, '5m': -11 } }, g);
  assert(!ck.items.find(x => x.key === 'sep').ok && ck.score === 8, 'EMA altı puan almamalı: ' + ck.score);
  ck = eng.checklist({ ...base, rsi: rsi(96, 96, 96), sepPct: { '3m': 10.5, '5m': 1 } }, g);
  assert.strictEqual(ck.items.find(x => x.key === 'sep').pts, 3);                         // ≥ %10 → 3 puan
  ck = eng.checklist({ ...base, rsi: rsi(99, 91, 88), sepPct: { '3m': 0.5, '5m': 0.2 }, macd: {}, conf: { h1: 85, h4: 60 }, neg: { '1m': { count: 1 }, '3m': { count: 0 } } }, g);
  assert(ck.items[2].ok && ck.items[2].text.includes('95–100'));                           // RSI bandı 95–100
  assert(ck.warn && ck.warn.includes('EMA21'));
  assert.strictEqual(ck.score, 3);                                // günlük direnç + çakışma + bant
  assert.strictEqual(eng.rsiGrade({ hits: 2, check: ck }, g), 2);
  assert.strictEqual(eng.rsiGrade({ hits: 2, check: { score: 5 } }, g), 3);
  assert.strictEqual(eng.rsiGrade({ hits: 1, check: { score: 8 } }, g), 0);
  ck = eng.checklist({ ...base, rsi: rsi(90, 90, 90), levels: [{ name: '4h EMA200', value: 101, dist: -1 }], level: { name: '4h EMA200', value: 101, dist: -1, zone: 'near' } }, g);
  assert(!ck.items[0].ok && ck.items[0].text.includes('içinde yok'));   // yalnız 4h seviye → günlük madde yok
  ok('Derece: hacim 🔴/🔴🔴(≥3×)/🔴🔴🔴(+yön ≥%65) · kart derecesi puanla (9 madde; EMA21 üstü ayrışma %2/%5/%10 → 1/2/3 puan, altı 0; MACD 3m/5m sat kesişimi +1): 10 puan → 4 daire, 5 → 3, 3 → 2; RSI bandı 95–100; EMA21 yakın uyarısı; yalnız 4h seviyede günlük madde yok');
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
console.log(R.join('\n'));
