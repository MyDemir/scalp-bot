'use strict';
// 1 dk hareketin RSI kartına gömülmesi + günlük sayaç + 3dk EMA21 takip/kopuş (Detay)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const { Series } = require(`${REPO}/src/series`); const eng = require(`${REPO}/src/infoEngine`);
const cfg = require(`${REPO}/src/config`); const { formatCard, toPlain } = require(`${REPO}/src/infoCard`);
const { gen, agg, MIN } = require('./gen');
const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);

// ── 1) EMA21 takip / kopuş ──
{
  const t0 = Date.UTC(2026, 0, 1), F = 3 * MIN;
  const mk = n => Array.from({ length: n }, (_, i) => { const c = 100 + i * 0.1; return { t: t0 + i * F, o: c - 0.05, h: c + 0.1, l: c - 1.3, c, v: 100, tb: 50, q: 1e4, tq: 5e3, closed: true }; });
  const S = new Series('R'); S.seed('3m', mk(80));
  let r = eng.emaRide(S, '3m');
  assert(r.state === 'ride' && r.recent >= 6, 'ride: ' + JSON.stringify(r));
  const arr = mk(80); const last = arr[79].c;
  for (let k = 0; k < 3; k++) arr.push({ t: t0 + (80 + k) * F, o: last + 2 + k * 2, h: last + 3 + k * 2, l: last + 2 + k * 2, c: last + 3 + k * 2, v: 300, tb: 250, q: 3e4, tq: 2.5e4, closed: true });
  S.seed('3m', arr);
  r = eng.emaRide(S, '3m');
  assert(r.state === 'break' && r.last3 === 0 && r.dist >= 1.5, 'break: ' + JSON.stringify(r));
  ok(`EMA21: fiyat 3dk EMA21'e son 10 mumun çoğunda değerken "izliyor"; ardından 3 mum değmeden ${r.dist.toFixed(1)} ATR yukarı → "koptu"`);
}

// ── 2) Hareket → RSI kartı (yalnız RSI şartı varken) + günlük sayaç ──
{
  const D = 1440, start = Date.UTC(2026, 0, 1), pumpAt = 41 * D;
  const m1 = gen({ seed: 21, days: 42, start, p0: 100, pumps: [{ at: pumpAt, len: 400, rate: 0.0011, vol: 3, dumpLen: 0 }] });
  const jump = (i, mult, tk) => { const c = m1[i], o = m1[i - 1].c, nc = o * mult, f = nc / c.c;
    Object.assign(c, { o, c: nc, h: Math.max(o, nc) * 1.0005, l: Math.min(o, nc) * 0.9995, v: c.v * 8, tb: c.v * 8 * tk }); c.q = c.v * nc; c.tq = c.tb * nc;
    for (let j = i + 1; j < m1.length; j++) for (const k of ['o', 'h', 'l', 'c']) m1[j][k] *= f; };
  jump(pumpAt - 20, 0.978, 0.2);            // pompadan önce −%2.2 (RSI düşük → kart yok, sayaç ▼1)
  jump(pumpAt + 240, 1.025, 0.8);           // pompa içinde +%2.5 (RSI yüksek → kart, sayaç ▲1)
  const T0 = start + (pumpAt - 60) * MIN;
  const S = new Series('MOVEUSDT');
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m1, m * MIN, T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  const tr = eng.createTracker(); const cards = [];
  for (const c of m1.filter(c => c.t >= T0)) { const card = eng.step(S, S.apply1m({ ...c, closed: true }), s, tr, {}); if (card) cards.push(card); }
  const tDown = m1[pumpAt - 20].t + MIN, tUp = m1[pumpAt + 240].t + MIN;
  assert(!cards.some(c => c.t === tDown), 'RSI düşükken hareket kartı olmamalı');
  const mc = cards.find(c => c.t === tUp);
  assert(mc && mc.trig.move && mc.snap.rsiOk, 'RSI şartı varken hareket kartı bekleniyordu');
  assert(mc.tags.includes('#HAREKET') && mc.news[0].startsWith('⚡🟢') && /1 dk \+%2\.5/.test(mc.news[0]), mc.news.join(' | '));
  assert(!mc.news.some(n => /Hacimli yükselen mum/.test(n)), 'aynı mumda hacimli mum satırı tekrar olmamalı');
  const fc = formatCard(mc, s); const txt = toPlain(fc.text), det = toPlain(fc.details);
  const ln = txt.split('\n');
  assert(ln[1].startsWith('🔔: RSI') && ln[2].startsWith('RSI 3dk:') && ln[ln.length - 2].startsWith('⚡🟢') && ln[ln.length - 1].startsWith('⏱:'), 'kart (⚡ altta, saatten önce): ' + txt);
  assert(det.includes('⚡ 1 dk +%2.5') && det.includes('Bugün 1 dk ≥ %2: ▲ 1 · ▼ 1 · fark 0') && det.includes('3dk EMA21:') && det.includes('1 saat:'), det);
  const st = tr.moveStats('MOVEUSDT', tUp);
  assert(st.up === 1 && st.down === 1);
  assert.deepStrictEqual(tr.moveStats('MOVEUSDT', tUp + 2 * 86_400_000), { up: 0, down: 0 }, 'yeni günde sıfır');
  console.log('\n--- hareketli RSI kartı ---\n' + txt + '\n--- 📋 Detay (ilk satırlar) ---\n' + det.split('\n').slice(0, 20).join('\n'));
  ok('Hareket: RSI düşükken −%2.2 kart üretmedi (yalnız sayaç ▼1); pompa içinde +%2.5 RSI kartına ⚡ satırıyla (kartın altında, saatten önce) girdi (#HAREKET, hacimli mum satırı tekrarlanmadı); Detay: hareket ayrıntısı, "Bugün ▲ 1 · ▼ 1 · fark 0", 3dk EMA21 durumu; gün değişince sayaç sıfır');
}

console.log('\n' + R.join('\n'));
