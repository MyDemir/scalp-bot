'use strict';
// Yeni direnç türleri + sahte kırılım (SFP) + fiyat keşfi
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const { Series } = require(`${REPO}/src/series`); const eng = require(`${REPO}/src/infoEngine`);
const L = require(`${REPO}/src/levels`); const cfg = require(`${REPO}/src/config`);
const { formatCard, toPlain } = require(`${REPO}/src/infoCard`);
const { gen, agg, MIN } = require('./gen');
const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);

// ── 1) Seviye hesapları ──
{
  // 100 günlük seri: dip 89.9 (gün 20) → yükseliş; gün 75'te 120 tepesi, gün 95'te 112 → günlük bacak dip → tepe (yükseliş)
  const t0 = Date.UTC(2026, 0, 1), D = 86_400_000;
  const d1 = { t: [], h: [], l: [], c: [] };
  for (let i = 0; i < 100; i++) {
    const p = i < 20 ? 100 - i * 0.5 : 90 + (i - 20) * 0.25;
    d1.t.push(t0 + i * D); d1.c.push(p); d1.l.push(p - 0.1);
    d1.h.push(i === 75 ? 120 : i === 95 ? 112 : p + 0.1);
  }
  const h4 = Array.from({ length: 60 }, (_, i) => 100 + (i === 30 ? 8 : 0));                       // 4h tepe 108
  const { levels, leg } = L.calcExtraLevels({ h1: { t: d1.t, h: d1.h, l: d1.l }, h4: { h: h4 }, d1 }, { swing: true, fib: true, bars: 3 }, []);
  const by = nm => levels.filter(x => x.name === nm).map(x => x.value);
  assert.deepStrictEqual(by('30 günlük en yüksek'), [120]);
  assert.deepStrictEqual(by('7 günlük en yüksek'), [112]);
  assert.deepStrictEqual(by('4h tepe'), [108]);
  assert(leg.up && Math.abs(leg.lo - 89.9) < 1e-9 && leg.hi === 120, JSON.stringify(leg));
  const f236 = 120 - 0.236 * (120 - 89.9);
  assert(Math.abs(by('Fib 0.236')[0] - f236) < 1e-6 && by('Fib 0.382').length === 1 && by('Fib 0.5').length === 1 && by('Fib 0.618').length === 1 && by('Fib 0.786').length === 1);
  // yakın kopya: majör seviyeye %0.3'ten yakın ek seviye eklenmez, majör seviyeye not düşülür
  const base = [{ name: '1d EMA200', value: 120.2, kind: 'major' }];
  const r2 = L.calcExtraLevels({ h1: { t: d1.t, h: d1.h, l: d1.l }, h4: { h: h4 }, d1 }, { swing: true, fib: true, bars: 3 }, base);
  assert(!r2.levels.some(x => x.name === '30 günlük en yüksek') && base[0].also.includes('30 günlük en yüksek'), '120 ≈ 120.2 → eklenmemeli, çakışma notu');
  // kapalıyken yok
  const r3 = L.calcExtraLevels({ h1: { t: d1.t, h: d1.h, l: d1.l }, h4: { h: h4 }, d1 }, { swing: false, fib: false, bars: 3 }, []);
  assert(!r3.levels.some(x => x.kind === 'swing' || x.kind === 'fib'));
  // uzantılar (yükseliş bacağı): fiyatın üstündeki ilk ikisi
  const ext = L.fibExtensions(leg, 121);
  assert.deepStrictEqual(ext.map(x => x.r), [1.272, 1.618]);
  assert(Math.abs(ext[0].value - (89.9 + 1.272 * 30.1)) < 1e-6);
  assert.deepStrictEqual(L.fibExtensions(leg, 130).map(x => x.r), [1.618, 2]);
  ok(`Seviyeler: 30g/7g gerçek en yüksek (120/112), 4h tepe 108, 1s geniş bacağın Fib 0.236–0.786 (0.236 = ${f236.toFixed(3)}); majöre %0.3 yakın kopya eklenmedi (çakışma notu); kapalıyken salınım/Fib yok; uzantı 1.272/1.618`);
}

// ── 2) Sahte kırılım (SFP) ──
{
  const t0 = Date.UTC(2026, 0, 1), F = 5 * MIN;
  const mk = closes => closes.map((c, i) => ({ t: t0 + i * F, o: i ? closes[i - 1] : c, h: Math.max(c, i ? closes[i - 1] : c) * 1.0005, l: Math.min(c, i ? closes[i - 1] : c) * 0.9995, c, v: 100, tb: 60, q: 1e4, tq: 6e3, closed: true }));
  const LV = [{ name: '30 günlük tepe', value: 100, kind: 'major' }, { name: 'Fib 0.236', value: 100.2, kind: 'fib' }];
  // hot3/hot15: 3m ve 15m'nin de aşırı alımda olup olmadığı (RSI kart şartı: 3'ten en az 2 dilim ≥ 85)
  const run = (closes, patch = {}, { hot3 = true, hot15 = true, lv = LV } = {}) => {
    const cold = mk(Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1)));   // yatay → RSI ~50
    const S = new Series('SFP'); const w = new Map(); const evs = [];
    for (let k = 30; k <= closes.length; k++) {
      const arr = mk(closes.slice(0, k)); if (patch[k - 1]) Object.assign(arr[k - 1], patch[k - 1]);
      S.seed('5m', arr);
      S.seed('3m', hot3 ? arr : cold); S.seed('15m', hot15 ? arr : cold);
      S._lv = { key: `${S.lastT('1h')}:${S.lastT('4h')}:${S.lastT('1d')}:true:true:3:3:true`, levels: lv, leg: null };
      const e = eng.detectSfp(S, s, w); if (e) evs.push({ k: k - 1, ...e });
    }
    return evs;
  };
  const rise = Array.from({ length: 40 }, (_, i) => 90 + i * 0.25);          // 90 → 99.75, RSI ~100 (aşırı alım)
  // kapanış SFP: 100.8'de kapanır (iki seviye de kırıldı) → 2 mum sonra 99.7'de altında kapanır
  let ev = run([...rise, 100.8, 100.9, 99.7]);
  assert.strictEqual(ev.length, 1, JSON.stringify(ev));
  assert(ev[0].type === 'close' && ev[0].name === '30 günlük tepe' && ev[0].ago === 10, 'majör seviye, 10 dk önce kırıldı: ' + JSON.stringify(ev[0]));
  // yalnız 5m aşırı alımda (3m ve 15m değil) → RSI kart şartı yok → SFP yok (HUSDT durumu)
  ev = run([...rise, 100.8, 100.9, 99.7], {}, { hot3: false, hot15: false });
  assert.strictEqual(ev.length, 0, 'RSI kart şartı yokken SFP olmamalı: ' + JSON.stringify(ev));
  // 1h tepe ve Fib seviyeleri SFP için izlenmez
  ev = run([...rise, 100.8, 100.9, 99.7], {}, { lv: [{ name: '1h tepe', value: 100, kind: 'swing' }, { name: 'Fib 0.382', value: 100.1, kind: 'fib' }] });
  assert.strictEqual(ev.length, 0, '1h tepe / Fib için SFP olmamalı');
  ev = run([...rise, 100.8, 100.9, 99.7], {}, { lv: [{ name: '4h tepe', value: 100, kind: 'swing' }] });
  assert(ev.length === 1 && ev[0].name === '4h tepe', '4h tepe izlenmeli');
  // süre dolunca (6 mum) SFP yok
  ev = run([...rise, 100.8, 100.9, 101, 101.1, 101.2, 101.3, 101.4, 99.5]);
  assert.strictEqual(ev.length, 0, 'sfpBars dolduktan sonra altına inmek SFP değil');
  // fitil SFP: aynı mumda üstüne çıkıp altında kapanır
  // (sıkı: fitil ≥ %0.5 üstte, gövde ≥ %0.2 altta, hacim önceki 20 mumun ortalamasının üstünde)
  const wick = [...rise, 99.7];
  ev = run(wick, { [wick.length - 1]: { o: 99.75, h: 100.9, c: 99.7, v: 300 } });
  assert(ev.length === 1 && ev[0].type === 'wick' && ev[0].name === '30 günlük tepe', JSON.stringify(ev));
  ev = run(wick, { [wick.length - 1]: { o: 99.75, h: 100.4, c: 99.7, v: 300 } });
  assert.strictEqual(ev.length, 0, 'fitil %0.5 aşmadıysa SFP değil');
  ev = run(wick, { [wick.length - 1]: { o: 99.75, h: 100.9, c: 99.85, v: 300 } });
  assert.strictEqual(ev.length, 0, 'gövde %0.2 altında kapanmadıysa SFP değil (XRP: %0.08 altında)');
  ev = run(wick, { [wick.length - 1]: { o: 99.75, h: 100.9, c: 99.7, v: 90 } });
  assert.strictEqual(ev.length, 0, 'hacim ortalamanın altındaysa SFP değil');
  // aşırı alım yokken (düşüş sonrası) kırılım izlenmez
  const fall = Array.from({ length: 40 }, (_, i) => 110 - i * 0.25);          // 110 → 100.25, RSI düşük
  ev = run([...fall, 99.0, 100.8, 99.6]);
  assert.strictEqual(ev.length, 0, 'RSI düşükken kırılım takip edilmemeli');
  ok('Sahte kırılım: RSI kart şartı (3m/5m/15m\'den ≥2 dilim ≥ 85) varken 5m kapanışla kırılan güçlü seviyenin 10 dk sonra altında kapanması → SFP; yalnız 5m aşırı alımdaysa yok (HUSDT); 1h tepe / Fib izlenmez, 4h tepe izlenir; 6 mumdan sonra değil; fitil SFP yalnız sıkı şartla (fitil ≥ %0.5, gövde ≥ %0.2 altında, hacim ortalama üstü); RSI düşükken takip yok');
}

// ── 3) Fiyat keşfi (uçtan uca: tohum + 1m akış + step + kart metni) ──
{
  const D = 1440, start = Date.UTC(2026, 0, 1);
  const pumpAt = 41 * D;
  const m1 = gen({ seed: 21, days: 42, start, p0: 100, pumps: [{ at: pumpAt, len: 400, rate: 0.0011, vol: 3, dumpLen: 0 }] });
  const T0 = start + (pumpAt - 30) * MIN;                                   // tohum: pompadan 30 dk öncesine kadar
  const S = new Series('DISCUSDT');
  const tfs = { '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 };
  for (const [tf, m] of Object.entries(tfs)) S.seed(tf, agg(m1, m * MIN, T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const tr = eng.createTracker(); const cards = [];
  for (const c of m1.filter(c => c.t >= T0)) {
    const closed = S.apply1m({ ...c, closed: true });
    const card = eng.step(S, closed, s, tr, {});
    if (card) cards.push(card);
  }
  const disc = cards.filter(c => c.snap.discovery);
  assert(disc.length >= 1, `fiyat keşfi kartı bekleniyordu (kart: ${cards.length})`);
  const c0 = disc[0];
  assert(c0.tags.includes('#FIYATKESFI') && !c0.snap.level && c0.news.some(n => n.startsWith('🚀 Fiyat keşfi:')), c0.news.join(' | '));
  const fc = formatCard(c0, s); const txt = toPlain(fc.text), det = toPlain(fc.details);
  assert(txt.includes('🚀 Fiyat keşfi:') && det.includes('🚀 Kırılan:') && det.includes('Fib uzantı:') && c0.tags.includes('#FIYATKESFI'), txt + '\n' + det);
  // aynı kırılım için tekrar tekrar "fiyat keşfi" yeniliği gelmez
  const lines = cards.flatMap(c => c.news.filter(n => n.startsWith('🚀')));
  assert(new Set(lines.map(l => l.split(' kırıldı')[0])).size === lines.length, 'aynı seviye için tek fiyat keşfi satırı: ' + lines.join(' | '));
  // kapalıyken kart şartı (seviye) engeller
  const s2 = { ...s, discoveryCards: false };
  const S2 = new Series('DISCUSDT'); for (const [tf, m] of Object.entries(tfs)) S2.seed(tf, agg(m1, m * MIN, T0)); S2.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const tr2 = eng.createTracker(); let n2 = 0;
  for (const c of m1.filter(c => c.t >= T0)) { const card = eng.step(S2, S2.apply1m({ ...c, closed: true }), s2, tr2, {}); if (card?.snap.discovery) n2++; }
  assert.strictEqual(n2, 0);
  console.log('\n--- fiyat keşfi kartı ---\n' + txt + '\n--- 📋 Detay ---\n' + det);
  ok(`Fiyat keşfi: pompa tüm seviyeleri geçince ${disc.length} kart (#FIYATKESFI, kırılan seviye + Fib uzantı satırı); aynı kırılım için tek yenilik; kapalıyken yok`);
}

console.log('\n' + R.join('\n'));
