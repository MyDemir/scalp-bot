'use strict';
// Short'a karşı sinyaller (4s gizli PU, günlük golden cross) + yeni derece eşikleri + "Dirençte"
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const eng = require(`${REPO}/src/infoEngine`); const cfg = require(`${REPO}/src/config`);
const { formatCard, toPlain } = require(`${REPO}/src/infoCard`);
const R = []; const ok = x => R.push('✅ ' + x);

// ── 1) Gizli PU ──
{
  // 30 mum: dip1 i=10 (low 90, RSI 30), tepe, dip2 i=24 (low 94 > 90, RSI 26 < 30), sonra 3 mum yukarı
  const lows = [], rsi = [];
  for (let i = 0; i < 30; i++) {
    let lo = 100, r = 50;
    if (i === 10) { lo = 90; r = 30; } else if (Math.abs(i - 10) <= 3) { lo = 92 + Math.abs(i - 10); r = 35; }
    if (i === 24) { lo = 94; r = 26; } else if (Math.abs(i - 24) <= 3) { lo = 95.5 + Math.abs(i - 24); r = 33; }
    lows.push(lo); rsi.push(r);
  }
  const h = eng.findHiddenPU(lows, rsi);
  assert(h && h.low1 === 90 && h.low2 === 94 && h.rsi1 === 30 && h.rsi2 === 26 && h.ago === 5, JSON.stringify(h));
  // RSI de yükselen dip → normal (gizli PU değil)
  const r2 = rsi.slice(); r2[24] = 34;
  assert.strictEqual(eng.findHiddenPU(lows, r2), null);
  // fiyat daha düşük dip → gizli PU değil
  const l3 = lows.slice(); l3[24] = 89;
  assert.strictEqual(eng.findHiddenPU(l3, rsi), null);
  // bayat (ikinci dip 10 mumdan eski) → yok
  const lows4 = lows.concat(Array(12).fill(100)), rsi4 = rsi.concat(Array(12).fill(50));
  assert.strictEqual(eng.findHiddenPU(lows4, rsi4), null);
  ok('4s gizli PU: fiyat daha yüksek dip (90 → 94) + RSI daha düşük dip (30 → 26) bulundu; RSI de yükselirse, fiyat daha düşük dip yaparsa ya da ikinci dip bayatsa yok');
}

// ── 2) Golden cross ──
{
  // 300 gün: 250 gün düşüş, sonra yükseliş → SMA50 SMA200'e aşağıdan yaklaşır, sonra keser
  const mk = up => Array.from({ length: 250 + up }, (_, i) => (i < 250 ? 200 - i * 0.4 : 100 + (i - 250) * 3));
  let found = null, near = null;
  for (let up = 1; up <= 120 && !found; up++) {
    const g = eng.findGoldenCross(mk(up));
    if (g?.state === 'near' && !near) near = { up, ...g };
    if (g?.state === 'crossed') found = { up, ...g };
  }
  assert(near && near.gap <= 2 && near.gap < near.prevGap, 'yakın: ' + JSON.stringify(near));
  assert(found && found.up > near.up && found.ago === 0, 'kesişim: ' + JSON.stringify(found));
  assert.strictEqual(eng.findGoldenCross(Array.from({ length: 150 }, () => 1)), null, '200 günden az veri → yok');
  assert.strictEqual(eng.findGoldenCross(Array.from({ length: 260 }, (_, i) => 200 - i * 0.3)), null, 'düşüş trendi → yok');
  ok(`Günlük golden cross: yükseliş başlayınca önce "yakın" (fark %${near.gap.toFixed(2)}, daralıyor), ${found.up}. günde "oldu"; kısa geçmiş ve düşüş trendinde yok`);
}

// ── 3) Derece eşikleri + kart 🔔 satırı + Detay ──
{
  const s = { ...cfg.info };
  assert(s.grade2Min === 3 && s.grade3Min === 5 && s.grade4Min === 7);
  const g = sc => eng.rsiGrade({ hits: 2, check: { score: sc } }, s);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 11].map(g), [1, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  const snap = {
    rsi: { '3m': { v: 78.6 }, '5m': { v: 87.7 }, '15m': { v: 92.2 } }, conf: { h1: 80.1, h4: 65.8 }, rsiOk: true, ok: true, hits: 2, grade: 2, chg: 0.2,
    level: { name: '4h tepe', value: 0.06481, dist: 0.08, zone: 'dip', kind: 'swing' }, levels: [],
    check: { score: 4, total: 8, items: [{ key: 'daily', ok: true, text: 'Günlük direnç %0.5 kala' }, { key: 'band', ok: false, text: '3m/5m RSI 95–98 değil' }] },
    counter: { hpu: { low1: 0.0601, low2: 0.0612, rsi1: 38.2, rsi2: 33.1, ago: 3 }, gc: { state: 'near', gap: 1.4, prevGap: 2.3 } },
    windows: [60, 15], sep: {}, macd: {},
  };
  const out = formatCard({ id: 'EDENUSDT-1', symbol: 'EDENUSDT', seq: 2, t: Date.UTC(2026, 8, 29, 12, 12), price: 0.06486, snap, news: [], tags: [], trig: {} }, s);
  const txt = toPlain(out.text), det = toPlain(out.details);
  assert(txt.split('\n')[1] === '🔔: RSI 85+ · Kart 2 · ⭐ Dirençte', txt);
  assert(txt.startsWith('🔴🔴') === false && txt.startsWith('🟢🟢 #EDENUSDT'), 'kontrol 4/8 → iki daire: ' + txt.split('\n')[0]);
  assert(!txt.includes("Short'a karşı"), 'karşı sinyal kartta görünmemeli');
  assert(det.includes("⚠️ Short'a karşı:") && det.includes('• 4s gizli PU — dip 0.0601 → 0.0612 (yükseldi), RSI 38.2 → 33.1 (düştü)') && det.includes("• Günlük golden cross yakın — SMA50, SMA200'ün %1.4 altında (5 gün önce %2.3)"), det);
  console.log('\n--- kart ---\n' + txt + '\n--- Detay (kontrol bölümü) ---\n' + det.split('\n').filter(l => /Kontrol|✅|▫️|Short|•/.test(l)).join('\n'));
  ok('Derece (puan): 🔴 0–2 · 🔴🔴 3–4 · 🔴🔴🔴 5–6 · 🔴🔴🔴🔴 7+; 🔔 satırında "⭐ Dirençte"; karşı sinyaller yalnız Detay\'da');
}

// ── 4) Sahte kırılım kartı (XRP): tekrar yok, ⭐ tek yerde, daireler 🔴 ──
{
  const s = { ...cfg.info };
  const snap = {
    rsi: { '3m': { v: 75.1 }, '5m': { v: 86.5 }, '15m': { v: 86.2 } }, conf: { h1: 74.4, h4: 63.0 }, rsiOk: true, ok: true, hits: 2, grade: 1, chg: 0.3,
    level: { name: '4h tepe', value: 1.5457, dist: -0.08, zone: 'dip', kind: 'swing' }, levels: [], check: { score: 1, total: 8, items: [] }, windows: [60, 15], sep: {}, macd: {},
  };
  const sfp = { name: '4h tepe', value: 1.5457, kind: 'swing', type: 'wick', ago: 0 };
  const news = ['⚠️ Sahte kırılım (fitil): 4h tepe 1.5457 · 5dk mum üstüne çıktı, altında kapandı'];
  const out = formatCard({ id: 'XRPUSDT-1', symbol: 'XRPUSDT', seq: 1, t: Date.UTC(2026, 8, 29, 12, 40), price: 1.5444, snap, news, tags: [], trig: { sfp } }, s);
  const ln = toPlain(out.text).split('\n');
  assert.strictEqual(ln[0], '🔴 #XRPUSDT — RSI', 'daireler 🔴 (15 dk yön yukarı olsa da): ' + ln[0]);
  assert.strictEqual(ln[1], '🔔: ⚠️ Sahte kırılım (fitil) · Kart 1 · ⭐ Dirençte');
  assert.strictEqual(ln[2], '4h tepe 1.5457 · 5dk mum üstüne çıktı, altında kapandı');
  const dir = ln.find(l => l.startsWith('Direnç:'));
  assert.strictEqual(dir, 'Direnç: 4h tepe 1.5457 (%0.08 kala)', 'Direnç satırında ⭐ yok');
  assert.strictEqual((toPlain(out.text).match(/⭐/g) || []).length, 1);
  console.log('\n--- sahte kırılım kartı ---\n' + toPlain(out.text));
  ok('Sahte kırılım kartı: 🔔 "⚠️ Sahte kırılım (fitil)", alt satırda başlık tekrarı yok, ⭐ yalnız 🔔 satırında, daireler 🔴');
}

console.log('\n' + R.join('\n'));
