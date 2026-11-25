'use strict';
// ⭐ v3 B kurulum kartı: aday anında karar (eventLog.takeSetup) → eng.setupCard (canlı processCandle0 ve backtest aynı sıra)
// (a) kurulum kartı çıkar  (b) aynı pompada ikinci yok  (c) aynı mumda kart varsa tek kart + ⭐
// (d) setupCards=false → kartlar ve kayıtlar birebir aynı  (e) canlı karar = kayıttaki v3B (aynı akış)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createDropLedger, v3Next } = require(`${REPO}/src/eventLog`);
const eng = require(`${REPO}/src/infoEngine`);
const { formatCard } = require(`${REPO}/src/infoCard`);
const { compact } = require(`${REPO}/src/infoStats`);
const MIN = 60e3; const R = []; const ok = x => R.push('✅ ' + x);
const t0 = Date.UTC(2026, 0, 1);

// test-drops ile aynı sentetik akış: 3000 dk yatay geçmiş + iki pompa (arada > 60 dk aday yok)
const hist = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i / 9) * 0.15);
const candle = (i, c, o) => ({ t: t0 + i * MIN, o, h: Math.max(o, c) * 1.0004, l: Math.min(o, c) * 0.9996, c, v: 100, tb: 55, q: 100 * c, tq: 55 * c, closed: true });
const seg = (from, to, n) => Array.from({ length: n }, (_, k) => from + (to - from) * (k + 1) / n);
const pump = [...seg(100, 100, 60), ...seg(100, 106, 40)];
const pathV = [...pump, ...seg(106.3, 109, 20), ...seg(109, 107, 80), ...seg(107, 113, 25), ...seg(113, 112, 300)];
const SC4 = { rsi_1m: 90, bbB_15m: 1.4, stochCross: 'down', volx_3m: 4, liqShortPct15: null };   // S = 4 (liq yok, backtest gibi)

/**
 * Canlı processCandle0 / infoBacktest.runSymbol sırası: step → noteCard → observe → takeSetup → setupCard (mode 'setup')
 * mode 'base': kurulum hattı hiç yok (bu değişiklikten önceki davranış)
 */
function run({ s = cfg.info, mode = 'setup', inject = () => SC4, skip = [], tailMut = null } = {}) {
  const all = [...hist, ...pathV];
  if (tailMut != null) for (let i = hist.length + tailMut + 1; i < all.length; i++) all[i] = all[i] * 1.5 + 7;   // kart mumundan SONRAKİ mumlar değişir
  const m1 = all.map((c, i) => candle(i, c, i ? all[i - 1] : c));
  const S = new Series('SETUPUSDT');
  const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
    if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; };
  const T0 = m1[hist.length].t;
  for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
  S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
  let nth = 0;
  const L = createDropLedger({ ...cfg.events, onCandidate: (sr, e) => { Object.assign(e.feat, inject(nth++, e)); } });
  const trk = eng.createTracker(); const ctx = {};
  const ev = [], cards = [], decisions = [], stepAt = new Map(), perCandle = [];
  for (const c of m1.filter(c => c.t >= T0)) {
    if (skip.includes((c.t - T0) / MIN)) continue;
    const closed = S.apply1m(c);
    let card = eng.step(S, closed, s, trk, ctx);
    if (card) { stepAt.set(card.t, card); L.noteCard('SETUPUSDT', card.t, card.grade); }
    ev.push(...L.observe(S, s, ctx));
    if (mode === 'setup') {
      const su = L.takeSetup('SETUPUSDT');
      if (su) { decisions.push(su); const had = card; card = eng.setupCard(S, s, trk, ctx, su, card); if (card && !had) L.noteCard('SETUPUSDT', card.t, card.grade); }
    }
    let n = 0;
    if (card) { cards.push(card); n++; }
    perCandle.push(n);
  }
  return { ev: ev.sort((a, b) => a.t - b.t), cards, decisions, stepAt, perCandle, T0, S };
}

const view = c => ({ ...compact(c), text: formatCard(c, cfg.info, { now: c.t }).text, details: formatCard(c, cfg.info, { now: c.t }).details, silent: c.silent, id: c.id });

// ── (a) + (b) + (e): kurulum kartı, pompa tekilliği, canlı karar = kayıttaki v3B ──
const A = run();
{
  const rec = A.ev.filter(e => e.feat.v3B === 1).map(e => e.id);
  assert.strictEqual(rec.length, 2, 'kayıtta iki pompa → iki v3B: ' + rec.length);
  // (e) pompa başına eşleşme: her kayıttaki v3B için aynı pompada (≤ 60 dk önce, araya kayıt boşluğu yok) tam bir canlı karar.
  // Karar ya aynı adaydadır (kesin) ya da seyreltmeyle ATLANAN (kayıtta satırı olmayan) daha erken bir adaydadır (bilinen fark, e2).
  assert.strictEqual(A.decisions.length, rec.length, '(e) karar sayısı = kayıttaki v3B sayısı');
  const recRows = new Set(A.ev.map(e => e.id));
  let exact = 0, shifted = 0;
  A.decisions.forEach((d, i) => {
    const rb = A.ev.find(x => x.id === rec[i]);
    if (d.id === rec[i]) { exact++; const e = rb; assert.strictEqual(d.S, e.feat.v3S, '(e) S aynı'); assert.strictEqual(d.pumpPct, e.feat.pumpPct, '(e) pompa aynı'); }
    else {
      shifted++;
      assert(!recRows.has(d.id), '(e) farklı aday ise kayıtta satırı olmayan (atlanan) aday olmalı: ' + d.id);
      assert(d.t < rb.t && rb.t - d.t < 60 * MIN, '(e) aynı pompada, kayıttan önce');
      assert(!A.ev.some(x => x.t > d.t && x.t < rb.t && x.feat.v3S >= 4 && x.feat.pumpPct >= 5), '(e) arada uygun kayıt yok');
    }
    assert.deepStrictEqual(d.flags, ['v3_rsi1m', 'v3_bb15', 'v3_stoch5', 'v3_vol3']);
  });
  assert(exact >= 1, '(e) en az bir pompada karar ile kayıt aynı aday');
  R.push(`ℹ️ (e) bu akışta ${exact} pompada aynı aday, ${shifted} pompada karar atlanan erken adayda (kayıttan ${A.decisions.map((d, i) => (A.ev.find(x => x.id === rec[i]).t - d.t) / MIN).join('/')} dk önce)`);
  const sc = A.cards.filter(c => c.trig.setup);
  assert.strictEqual(sc.length, 2, '(a)(b) pompa başına tek kurulum kartı: ' + sc.length);
  assert.deepStrictEqual(sc.map(c => c.t), A.decisions.map(d => d.t), 'kart t = aday t (tc kapanışı)');
  assert(A.perCandle.every(n => n <= 1), '(c) mum başına en fazla bir kart');
  for (const c of sc) {
    assert.strictEqual(c.silent, false, 'kurulum kartı hep sesli');
    assert(c.tags.includes('#KURULUM'), 'etiket');
    assert.strictEqual(c.setup.S, 4); assert(c.setup.pumpPct >= 5);
    const f = formatCard(c, cfg.info, { now: c.t });
    assert(/🔔: Kart \d+ · ⭐ Kurulum/.test(f.text), '🔔 satırı: ' + f.text.split('\n')[1]);
    assert(f.details.includes('• ⭐ v3 kurulumu: S 4/5 (1dk RSI ≥85 · 15dk BB %B&gt;1 · 5dk Stoch aşağı · 3dk hacim ≥3 kat) · pompa %'), 'Detay satırı (esc): ' + f.details);
    assert(f.text.length < 4000 && f.details.length < 4000);
    if (!A.stepAt.has(c.t)) assert.strictEqual(c.bypassBy, c.snapOk ? '' : 'setup', 'tek başına kurulum kartı: bypassBy setup');
  }
  ok(`(a)(b)(e) ${sc.length} kurulum kartı (pompa başına 1, sesli, #KURULUM, ⭐ satırı), canlı karar ile kayıttaki v3B pompa başına eşleşti (${rec.length}/${rec.length})`);
}

// ── (d) setupCards=false: kurulum hattı hiç yokmuş gibi (kartlar + kayıtlar birebir) ──
{
  const off = { ...cfg.info, setupCards: false };
  const B = run({ s: off, mode: 'base' }), C = run({ s: off, mode: 'setup' });
  assert(B.cards.length > 0, 'test geçerli: normal kartlar var');
  assert.deepStrictEqual(C.cards.map(view), B.cards.map(view), '(d) kart çıktıları birebir aynı');
  assert.deepStrictEqual(C.ev, B.ev, '(d) tepe kayıtları birebir aynı');
  assert(C.decisions.length === 2, 'karar yine hesaplanır, kart çıkmaz');
  // çok kartlı akış (düşük eşik + ⚡): yine birebir
  const offLo = { ...off, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false, moveAlertPct: 0.1 };
  const B2 = run({ s: offLo, mode: 'base' }), C2 = run({ s: offLo, mode: 'setup' });
  assert(B2.cards.length >= 20, 'çok kart: ' + B2.cards.length);
  assert.deepStrictEqual(C2.cards.map(view), B2.cards.map(view), '(d) çok kartlı akışta da birebir'); assert.deepStrictEqual(C2.ev, B2.ev);
  // açıkken de mevcut kartların hiçbiri eksilmez: base'deki her kart (t) açık koşuda da var, derece aynı
  const on = run({ s: cfg.info, mode: 'setup' }), base = run({ s: cfg.info, mode: 'base' });
  for (const b of base.cards) { const x = on.cards.find(c => c.t === b.t); assert(x, 'mevcut kart eksilmedi: ' + b.t); assert.strictEqual(x.grade, b.grade); assert.strictEqual(x.snap.grade, b.snap.grade); }
  // çok kartlı akışta tek başına kurulum kartları: mevcut kartların hiçbiri eksilmez, içerikleri (yenilikler) aynı kalır
  const lo2 = { ...cfg.info, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false };
  const on2 = run({ s: lo2, mode: 'setup' }), base2 = run({ s: lo2, mode: 'base' });
  const alone = on2.cards.filter(c => c.trig.setup && !on2.stepAt.has(c.t));
  assert(alone.length >= 1, 'test geçerli: tek başına kurulum kartı var');
  for (const b of base2.cards) {
    const x = on2.cards.find(c => c.t === b.t); assert(x, 'çok kartlı: mevcut kart eksilmedi');
    assert.strictEqual(x.grade, b.grade); assert.deepStrictEqual(x.trig.setup ? x.news.slice(1) : x.news, b.news, 'yenilikler aynı (seri durumu değişmedi)');
  }
  assert.strictEqual(on2.cards.length, base2.cards.length + alone.length);
  // doğrudan: hazır seride tek başına kurulum kartı tracker'ı seri içine almaz
  const trk = eng.createTracker(), su = { id: 'z', t: 0, S: 4, flags: ['v3_rsi1m'], pumpPct: 6 };
  const k1 = eng.setupCard(on2.S, lo2, trk, {}, su, null), k2 = eng.setupCard(on2.S, lo2, trk, {}, su, null);
  assert(k1 && k2 && k1.seq === 1 && k2.seq === 2, 'kart numarası ilerler');
  assert.strictEqual(trk.active('SETUPUSDT'), false, 'seri başlamadı (seri içi patlama açılmaz)'); assert.strictEqual(trk.maxGrade('SETUPUSDT'), 0, 'seri en yüksek derecesi değişmedi');
  assert(!k1.news.concat(k2.news).some(n => n.startsWith('İlk')), 'kurulum kartı RSI kartı değil: "İlk ..." satırı yok');
  assert.strictEqual(on.cards.length, base.cards.length + on.cards.filter(c => c.trig.setup && !base.cards.some(b => b.t === c.t)).length, 'fark yalnız tek başına kurulum kartları');
  ok(`(d) setupCards=false: ${B.cards.length} + ${B2.cards.length} kart ve ${B.ev.length} tepe kaydı birebir aynı; açıkken ${base.cards.length} mevcut kartın hepsi aynı derecede duruyor`);
}

// ── (c) aynı mumda normal kart: düşük RSI eşiğiyle step pompa boyunca kart üretir → kurulum ayrı mesaj değil, o karta ⭐ ──
{
  const lo = { ...cfg.info, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false, moveAlertPct: 0.1, cardSound: false };   // ⚡ her pompa mumunda kart; ses yalnız derece ≥ 3 / kurulum
  const base0 = run({ s: lo, mode: 'base' });
  // S ≥ 4 yalnız normal kartın çıktığı mumlardaki adaylara (pompa ≥ %5): kurulum kararı tam o mumda düşer
  const cardT = new Set(base0.cards.map(c => c.t));
  const inj = (i, e) => (cardT.has(e.t) && e.feat.pumpPct >= 5 ? SC4 : { ...SC4, volx_3m: 1 });
  const base = run({ s: lo, mode: 'base', inject: inj }), on = run({ s: lo, mode: 'setup', inject: inj });
  assert.deepStrictEqual(base.cards.map(view), base0.cards.map(view), 'enjeksiyon kartları değiştirmez (kayıt alanı)');
  const merged = on.cards.filter(c => c.trig.setup && on.stepAt.get(c.t) === c);
  assert(merged.length >= 1, 'test geçerli: en az bir kurulum aynı mumdaki karta eklendi');
  for (const c of merged) {
    const b = base.cards.find(x => x.t === c.t);
    assert(b, 'aynı mumda normal kart vardı');
    assert.strictEqual(c.seq, b.seq, 'kart numarası değişmedi (ikinci kart yok)');
    assert.strictEqual(c.bypassBy, b.bypassBy, 'bypassBy normal kartınki');
    assert.strictEqual(c.silent, false); assert.strictEqual(b.silent, !(b.grade >= 3), 'normal hali'); assert(c.tags.includes('#KURULUM'));
    assert.deepStrictEqual(c.news.slice(1), b.news, 'yalnız ⭐ satırı eklendi'); assert(c.news[0].startsWith('⭐ v3 kurulumu: S 4/5'));
    assert(/⭐ Kurulum/.test(formatCard(c, lo, { now: c.t }).text));
  }
  assert(on.perCandle.every(n => n <= 1), 'mum başına en fazla bir mesaj');
  assert.strictEqual(on.cards.length, base.cards.length + on.cards.filter(c => c.trig.setup && !on.stepAt.has(c.t)).length);
  // doğrudan: setupCard aynı nesneyi döner, iki kez çağrılsa da tek satır
  const card = base.cards[base.cards.length - 1], n0 = card.news.length;
  const su = { id: 'x', t: card.t, S: 5, flags: ['v3_rsi1m', 'v3_bb15', 'v3_stoch5', 'v3_vol3', 'v3_liq'], pumpPct: 7.25 };
  const r1 = eng.setupCard(null, lo, eng.createTracker(), {}, su, card), r2 = eng.setupCard(null, lo, eng.createTracker(), {}, su, card);
  assert(r1 === card && r2 === card && card.news.length === n0 + 1 && card.tags.filter(t => t === '#KURULUM').length === 1);
  assert.strictEqual(card.news[0], '⭐ v3 kurulumu: S 5/5 (1dk RSI ≥85 · 15dk BB %B>1 · 5dk Stoch aşağı · 3dk hacim ≥3 kat · short likidasyon) · pompa %7.3');
  assert.deepStrictEqual(card.setup, { S: 5, flags: su.flags, pumpPct: 7.25 });
  ok(`(c) ${merged.length} kurulum aynı mumdaki karta eklendi: tek mesaj, aynı kart no., ⭐ satırı başta, sesli`);
}

// ── seri durumu: tek başına kurulum kartı tracker'ın seri durumunu (last, maxGrade, active) değiştirmez ──
{
  const trk = eng.createTracker(), snap = { t: t0, price: 1 };
  assert.strictEqual(trk.commitExtra('X', snap), 1); assert.strictEqual(trk.active('X'), false); assert.strictEqual(trk.maxGrade('X'), 0);
  trk.observe15m('X', 10, { resetRsi: 50 }); assert.strictEqual(trk.commitExtra('X', snap), 1, '15m RSI sıfırlaması kurulum sayacını da sıfırlar');
  ok('tracker.commitExtra: yalnız kart numarası; seri durumu (active/maxGrade) aynı');
}

{ // entegrasyon (step → setupCard akışı): tek başına kurulum kartından ≤ 60 dk sonra gelen normal kart işareti alır
  const lone = A.cards.filter(c => c.trig.setup && !A.stepAt.has(c.t)), marked = A.cards.filter(c => c.trig.afterSetup);
  assert(lone.length >= 1 && marked.length >= 1, 'akışta kurulum sonrası kart var');
  for (const c of marked) {
    const prev = lone.filter(x => x.t < c.t && c.t - x.t <= 3600_000).pop(); assert(prev && !c.trig.setup, 'önceki tek başına kurulum var, kart normal');
    const mn = Math.floor((c.t - prev.t) / 60000), pc = (c.price - prev.price) / prev.price * 100;
    assert(c.tags.includes('#KURULUMSONRASI') && c.news.includes(`⭐ Kurulum kartından ${mn} dk sonra · fiyat kurulumdan ${pc > 0 ? '+' : pc < 0 ? '−' : ''}%${Math.abs(pc).toFixed(2)}`), c.news.join('|'));
    assert(/⭐ Kurulum sonrası/.test(formatCard(c, cfg.info, { now: c.t }).text));
  }
  assert(A.cards.filter(c => !c.trig.afterSetup).every(c => !c.tags.includes('#KURULUMSONRASI')));
}
// ── ⭐ Kurulum sonrası işareti: tek başına kurulum kartından ≤ 60 dk sonra gelen normal kart ──
{
  const MINm = 60_000, lo = { ...cfg.info, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false, moveAlertPct: 0.1, cardSound: false }, base = run({ s: lo, mode: 'base', inject: () => SC4 }), c0 = base.cards[base.cards.length - 1];
  const mk = () => { const trk = eng.createTracker(); trk.commitExtra('X', { t: t0, price: 100 }); return trk; };
  // (a) 5 dk sonra: işaret + doğru dk / yüzde
  const ra = mk().afterSetup('X', t0 + 5 * MINm, 103.5); assert(ra.min === 5 && Math.abs(ra.pct - 3.5) < 1e-9, '(a) 5 dk sonra');
  const rb = mk().afterSetup('X', t0 + 60 * MINm, 95); assert(rb.min === 60 && Math.abs(rb.pct + 5) < 1e-9, '60 dk dahil');
  // (b) 61 dk sonra: yok
  assert.strictEqual(mk().afterSetup('X', t0 + 61 * MINm, 103), null, '(b) 61 dk sonra yok');
  // (c) kurulum kartı yok: yok
  assert.strictEqual(eng.createTracker().afterSetup('X', t0, 100), null, '(c) kurulum yok');
  // (d) birleşik ⭐ (setupCard card ile; commitExtra çağrılmaz): işaret yok
  { const trk = eng.createTracker(), card = JSON.parse(JSON.stringify(base.cards[0])); card.trig = { ...card.trig, setup: false }; card.tags = card.tags.filter(x => x !== '#KURULUM');
    const su = { id: 'x', t: card.t, S: 4, flags: ['v3_rsi1m'], pumpPct: 7 };
    eng.setupCard(null, lo, trk, {}, su, card); assert.strictEqual(trk.afterSetup('X', card.t + 5 * MINm, 100), null, '(d) birleşik ⭐ sonrası yok'); }
  // sıfırlama (15m RSI düşük) işareti de siler
  { const trk = mk(); trk.observe15m('X', 10, { resetRsi: 50 }); assert.strictEqual(trk.afterSetup('X', t0 + MINm, 100), null, 'reset siler'); }
  // kart etiketi: 🔔 satırı + ⭐ satırı; yokken metin birebir aynı
  const plainTxt = formatCard(c0, lo, { now: c0.t }), mark = { min: 5, pct: -1.234 };
  const c1 = { ...c0, trig: { ...c0.trig, afterSetup: mark }, news: [...c0.news, '⭐ Kurulum kartından 5 dk sonra · fiyat kurulumdan −%1.23'] };
  const f1 = formatCard(c1, lo, { now: c0.t });
  assert(/🔔:.*⭐ Kurulum sonrası/.test(f1.text) && !/⭐ Kurulum sonrası/.test(plainTxt.text), 'işaret yalnız afterSetup varken');
  assert(f1.details.includes('⭐ Kurulum kartından 5 dk sonra · fiyat kurulumdan −%1.23'));
  assert.deepStrictEqual(formatCard({ ...c0 }, lo, { now: c0.t }), plainTxt, '(c) işaretsiz metin birebir aynı');
  ok('⭐ Kurulum sonrası: 5 dk → +dk/%; 60 dk dahil, 61 dk yok; kurulum yok → yok; birleşik ⭐ → yok; reset siler; 🔔 + yenilik satırı');
}

// ── başlık: RSI şartı yok + kurulum → '⭐ #SYM — Kurulum'; RSI'lı kurulum ve normal kart değişmez ──
{
  const lo = { ...cfg.info, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false, moveAlertPct: 0.1, cardSound: false };
  const base = run({ s: lo, mode: 'base', inject: () => SC4 }), c0 = base.cards[base.cards.length - 1];
  const head = c => formatCard(c, lo, { now: c.t }).text.split(/\r?\n/)[0];
  const mk = (rsiOk, setup, extra = {}) => ({ ...c0, ...extra, snap: { ...c0.snap, rsiOk }, trig: { ...c0.trig, setup: setup ? { s: 4 } : undefined } });
  assert.strictEqual(head(mk(false, true)), `⭐ <b>#SETUPUSDT — Kurulum</b>`, 'RSI yok + kurulum: ' + head(mk(false, true)));
  assert.strictEqual(head(mk(undefined, true)), `⭐ <b>#SETUPUSDT — Kurulum</b>`, 'rsiOk yok + kurulum');
  const withRsi = head(mk(true, true)), normal = head(mk(true, false)), normalNoRsi = head(mk(false, false));
  assert(/^(🔴|🟢|⚪)+ <b>#SETUPUSDT — RSI<\/b>$/.test(withRsi), 'RSI\'lı kurulum değişmedi: ' + withRsi);
  assert(/^(🔴|🟢|⚪)+ <b>#SETUPUSDT — RSI<\/b>$/.test(normal), 'normal kart değişmedi: ' + normal);
  assert(/^(🔴|🟢|⚪)+ <b>#SETUPUSDT — RSI<\/b>$/.test(normalNoRsi), 'kurulumsuz kart değişmedi');
  assert.strictEqual(head(mk(false, true, { symbol: 'A<B' })), '⭐ <b>#A&lt;B — Kurulum</b>', 'esc korunur');
  ok('başlık: RSI şartı yok + kurulum → "⭐ #SYM — Kurulum"; RSI\'lı kurulum ve normal kart "— RSI" aynı; esc korunur');
}

// ── kart anı v3 bilgi satırı + v3S: (a) satır var, ck.score aynı (b) tepe kaydıyla aynı mumda eşit (c) look-ahead yok ──
{
  const lo = { ...cfg.info, rsiMin: 55, rsiMin2: 60, minTFs: 1, levelRequired: false, moveAlertPct: 0.1, cardSound: false };
  const { v3Features } = require(`${REPO}/src/peakFeatures`); const { setupScore } = require(`${REPO}/src/setupScore`);
  const A = run({ s: lo, inject: () => SC4 });
  const withV3 = A.cards.filter(c => c.v3 && c.v3.v3S != null);
  assert(withV3.length > 0 && withV3.length === A.cards.length, 'her kartta v3: ' + withV3.length + '/' + A.cards.length);
  // (a) satır var; kontrol listesi puanı, derece ve metnin geri kalanı v3 satırı olmadan aynı
  const c = A.cards.find(x => x.snap.check) || assert.fail('kontrol listeli kart yok');
  const txt = formatCard(c, lo, { now: c.t }).details, none = formatCard({ ...c, v3: null }, lo, { now: c.t }).details;   // Kontrol listesi Detay'da
  const m = txt.match(/^v3 S (\d)\/5: .*$/m); assert(m, 'v3 satırı yok: ' + txt.slice(-300));
  assert(/1dk RSI ≥85 (✅|▫️|—) · 15dk BB %B&gt;1 (✅|▫️|—) · 5dk Stoch aşağı (✅|▫️|—) · 3dk hacim ≥3 kat (✅|▫️|—) · short likidasyon (✅|▫️|—)$/.test(m[0]), m[0]);
  assert.strictEqual(Number(m[1]), c.v3.v3S); assert(!/^v3 S/m.test(none), 'v3 yokken satır yok');
  assert.strictEqual(txt.replace('\n' + m[0], ''), none, 'v3 satırı dışında metin birebir aynı');
  assert(new RegExp(`Kontrol listesi ${c.snap.check.score}/${c.snap.check.total}`).test(txt), 'ck.score metinde aynı');
  assert.strictEqual(c.snap.check.total, 9);
  // (b) aynı mumda tepe kaydı (inject yok: gerçek alanlar) ile kart v3'ü eşit: kart anı hesabı = tepe kaydı hesabı
  const B = run({ s: lo, inject: () => ({}) });
  const evBy = new Map(B.ev.map(e => [e.t, e]));
  const same = B.cards.filter(x => evBy.has(x.t));
  assert(same.length > 0, 'tepe kaydı ile aynı mumda kart var');
  for (const x of same) {
    const e = evBy.get(x.t); const ref = setupScore({ rsi_1m: e.feat.rsi_1m, bbB_15m: e.feat.bbB_15m, stochCross: e.feat.stochCross, volx_3m: e.feat.volx_3m, liqShortPct15: e.feat.liqShortPct15 });
    assert.deepStrictEqual(x.v3, ref, 'kart v3 = tepe kaydı v3 (' + x.t + ')');
    assert.strictEqual(x.v3.v3S, e.feat.v3S, 'tepeler.csv v3S ile eşit');
  }
  // liq yok → v3_liq null, S mevcut bayraklarla
  assert(B.cards.every(x => x.v3.v3_liq === null), 'ctx.liq yok → likidasyon bayrağı null');
  assert(/short likidasyon —$/m.test(formatCard(B.cards[0], lo, { now: B.cards[0].t }).details), '— gösterilir');
  ok(`v3 bilgi satırı: ${A.cards.length} kartta var, ck.score/metin aynı; ${same.length} kartta tepe kaydıyla v3 aynı; liq yoksa —`);
  // (c) look-ahead yok: kartın v3'ü, kart mumundan SONRAKİ mumlar değişince aynı kalır
  const cut = A.cards[2], idx = Math.round((cut.t - t0) / MIN);
  const alt = run({ s: lo, inject: () => SC4 });
  const base = A.cards.map(x => x.v3);
  const C = run({ s: lo, inject: () => SC4, tailMut: idx });
  const cc = C.cards.find(x => x.t === cut.t);
  assert(cc && JSON.stringify(cc.v3) === JSON.stringify(cut.v3), 'sonraki mumlar değişince v3 aynı');
  assert.deepStrictEqual(alt.cards.map(x => x.v3), base, 'deterministik');
  ok('v3 look-ahead yok: kart mumundan sonrası değişince kartın v3\'ü aynı');
}

// ── (e2) karar ile kayıt farklılaşabilir mi: seyreltmeyle atlanan aday ──
// Pompa sürerken "devam" adayı önceki kayıttan < sampleGapMin (5 dk) sonra kapanırsa kaydedilmez (kayıtta satırı yok).
// İlk S≥4 adayı böyle atlanan aday olursa: canlı kart o adayda çıkar; kayıtta v3B aynı pompadaki sonraki KAYDEDİLEN adaya yazılır.
// Pompada ikinci kurulum kartı YOK (x.v3card). Bu farkı ölç: S≥4'ü ilk kez atlanan bir adaya ver.
{
  // önce hangi adayların atlandığını bul (aynı akış, S=3: karar yok)
  const probe = run({ inject: () => ({ ...SC4, volx_3m: 1 }) });
  const recIds = new Set(probe.ev.map(e => e.id));
  // newSample sırasını yeniden üret: her aday onCandidate'te bir kez görülür
  const seen = []; run({ inject: (i, e) => { seen.push(e.id); return { ...SC4, volx_3m: 1 }; } });
  const skipped = seen.filter(id => !recIds.has(id));
  assert(skipped.length > 0, 'akışta seyreltmeyle atlanan aday var');
  // ilk pompada pompa≥5 olan ilk adaydan sonraki ilk atlanan aday: S=4 yalnız ondan itibaren
  const firstPump = probe.ev.filter(e => e.t < probe.ev[0].t + 120 * MIN && e.feat.pumpPct >= 5);
  const target = skipped.find(id => Number(id.split('-')[1]) > firstPump[0].t);
  assert(target, 'hedef atlanan aday');
  const tT = Number(target.split('-')[1]);
  const D = run({ inject: (i, e) => (e.t >= tT && e.t < tT + 40 * MIN ? SC4 : { ...SC4, volx_3m: 1 }) });   // yalnız ilk pompa
  const recB = D.ev.filter(e => e.feat.v3B === 1);
  assert.strictEqual(D.decisions[0].id, target, 'canlı karar atlanan adayda (kayıtta satırı yok)');
  assert(!D.ev.some(e => e.id === target), 'atlanan aday kayıtta yok');
  assert.strictEqual(recB.length, 1, 'kayıtta v3B aynı pompada sonraki kaydedilen adayda');
  assert(recB[0].t > tT && recB[0].t - tT < 60 * MIN, 'aynı pompa');
  assert.strictEqual(D.decisions.length, 1, 'pompada ikinci kurulum kartı yok');
  assert.strictEqual(D.cards.filter(c => c.trig.setup).length, 1);
  ok(`(e2) bilinen fark: ilk S≥4 aday seyreltmeyle atlanırsa kart o adayda (${(recB[0].t - tT) / MIN} dk önce), kayıtta v3B sonraki kaydedilen adayda; pompada yine tek kart`);
}

// ── v3Next saf: girdi değişmez; kayıttaki eski davranış (yeni pompa ≥ 60 dk, ilk S≥4 + pompa≥5) ──
{
  const e = (t, S, pump) => ({ t, feat: { pumpPct: pump } }), sc = S => ({ v3S: S });
  let p = null, r;
  r = v3Next(p, e(0, 4, 4), sc(4)); assert.strictEqual(r.b, 0, 'pompa<5'); p = r.p;
  const frozen = JSON.stringify(p);
  r = v3Next(p, e(10 * MIN, 4, 6), sc(4)); assert.strictEqual(r.b, 1); assert.strictEqual(JSON.stringify(p), frozen, 'girdi değişmedi'); p = r.p;
  r = v3Next(p, e(69 * MIN, 5, 9), sc(5)); assert.strictEqual(r.b, 0, 'aynı pompa (< 60 dk)'); p = r.p;
  r = v3Next(p, e(129 * MIN, 5, 9), sc(5)); assert.strictEqual(r.b, 1, 'yeni pompa (= 60 dk)'); assert.strictEqual(r.p.start, 129 * MIN);
  r = v3Next(null, e(0, null, 9), sc(null)); assert.strictEqual(r.b, 0, 'S yok');
  ok('v3Next: saf, pompa sınırı 60 dk, pompa ≥ %5, S ≥ 4');
}

// ── kayıt: eski cards tablosuna 3 ADD COLUMN (sonda), yazma/okuma, kartlar.csv son 3 kolon; ayar: eski dosyada varsayılan true ──
{
  const fs = require('fs'); const SP = require('./_tmp');
  const f = `${SP}/setup-cards.db`; for (const x of [f, f + '-wal', f + '-shm']) { try { fs.unlinkSync(x); } catch { /* yok */ } }
  const Database = require('better-sqlite3'); const old = new Database(f);
  old.exec(`CREATE TABLE cards (id TEXT PRIMARY KEY, kind TEXT NOT NULL, symbol TEXT NOT NULL, t INTEGER NOT NULL, seq INTEGER, price REAL NOT NULL, data TEXT,
    low5 REAL, high5 REAL, close5 REAL, low15 REAL, high15 REAL, close15 REAL, low30 REAL, high30 REAL, close30 REAL, low60 REAL, high60 REAL, close60 REAL, low240 REAL, high240 REAL, close240 REAL,
    done INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0)`);
  old.prepare("INSERT INTO cards (id, kind, symbol, t, seq, price, data) VALUES ('OLD', 'card', 'OUSDT', 1, 1, 1, '{}')").run(); old.close();
  const { createCardStore } = require(`${REPO}/src/cardStore`);
  const st = createCardStore({ file: f, logger: { log() {}, error: x => { throw new Error(x); } } });
  const db = new Database(f, { readonly: true }); const names = db.prepare('PRAGMA table_info(cards)').all().map(c => c.name); db.close();
  assert.deepStrictEqual(names.slice(-4), ['setup', 'setupS', 'setupPump', 'v3S'], 'ADD COLUMN sonda: ' + names.join(','));
  assert.deepStrictEqual(names.slice(0, 7), ['id', 'kind', 'symbol', 't', 'seq', 'price', 'data'], 'mevcut kolon sırası aynı');
  st.add({ id: 'NEW', kind: 'card', symbol: 'NUSDT', t: 2, seq: 1, price: 1, data: { grade: 2 }, setup: 1, setupS: 4, setupPump: 6.31 });
  st.add({ id: 'N0', kind: 'card', symbol: 'NUSDT', t: 3, seq: 2, price: 1, data: { grade: 1 }, setup: 0, setupS: null, setupPump: null, v3S: 3 });
  const rows = st.since(0).map(require(`${REPO}/src/cardStore`).rowToStat);
  const by = id => rows.find(r => r.symbol === id.sym && r.t === id.t);
  assert.deepStrictEqual([by({ sym: 'NUSDT', t: 2 }).setup, by({ sym: 'NUSDT', t: 2 }).setupS, by({ sym: 'NUSDT', t: 2 }).setupPump], [1, 4, 6.31]);
  assert.strictEqual(by({ sym: 'NUSDT', t: 3 }).setup, 0); assert.strictEqual(by({ sym: 'NUSDT', t: 3 }).v3S, 3); assert.strictEqual(by({ sym: 'OUSDT', t: 1 }).v3S, null, 'eski satır v3S boş'); assert.strictEqual(by({ sym: 'OUSDT', t: 1 }).setup, null, 'eski satır boş');
  const { cardRow, cardColsOf, SETUP_COLS, V3_COLS, colsOf } = require(`${REPO}/src/exportData`);
  const cr = rows.map(r => cardRow(r)); const cols = cardColsOf(cr);
  assert.deepStrictEqual(cols.slice(-4, -1), SETUP_COLS); assert.deepStrictEqual(cols.slice(-1), V3_COLS); assert.strictEqual(cols.indexOf('gradeVer'), cols.length - 5, 'derece kolonları hemen önce');
  assert(!colsOf([{ a: 1 }]).includes('setup'), 'akis.csv (colsOf) kurulum kolonu almaz');
  st.close();
  const { createSettings } = require(`${REPO}/src/infoSettings`);
  const sf = `${SP}/setup-settings.json`; fs.writeFileSync(sf, JSON.stringify({ values: { rsiMin: 90 } }));
  const se = createSettings({ file: sf }); se.load(); assert.strictEqual(se.get().setupCards, true, 'eski ayar dosyası → varsayılan true'); assert.strictEqual(se.get().rsiMin, 90);
  assert.strictEqual(cfg.info.setupCards, true);
  ok('kayıt: eski tabloya setup/setupS/setupPump sonda eklendi, yazılıp okunuyor, kartlar.csv son 3 kolon; eski ayar dosyasında setupCards = true');
}

console.log('\n' + R.join('\n'));
