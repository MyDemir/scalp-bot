'use strict';

/**
 * Tepe defteri — pompadaki HER tepe adayı ve sonucu (düştü / devam / yatay). Kart çıksın çıkmasın.
 * Amaç: bir göstergenin short teyidi olup olmadığını ölçmek için hem düşenleri hem düşmeyip devam edenleri görmek.
 *
 *   Aday     : 1m mumun tepesi son 60 dk'nın en yükseği VE son 4 saatin dibinden ≥ %pumpPct yukarıda (pompa). O dakikada
 *              tüm göstergelerin fotoğrafı alınır. Kayıttaki tepe her zaman gerçek tepedir (daha yüksek tepe → yeni aday).
 *   Sonuç    : adaydan sonraki peakWindowMin (15) dk içinde
 *                düştü — fiyat adayın %dropPct (1.5) altına indi (önce)
 *                devam — fiyat adayın üstüne çıktı (önce; contPct, varsayılan 0) → o mumda yeni aday
 *                yatay — ikisi de olmadı
 *   Kayıt    : "düştü" ve "yatay" hep kaydedilir; "devam" en fazla sampleGapMin (5) dk'da bir (pompa boyunca örnek).
 *   Kart     : o coinde adaydan cardBeforeMin (15) dk önce ile düşüşten (yoksa pencere sonundan) 5 dk sonrası arasında kart.
 *   Sonrası  : tepeye göre 5/15/60/240 dk en düşük / en yüksek / kapanış · düşmeden önce en fazla ne kadar yükseldi
 *              (upBeforeDrop) · −%1/−%2/−%3'e kaç dk'da indi (t1/t2/t3) · ilk tam 5dk mum (teyit mumu): kırmızı mı, yutan mı,
 *              önceki mumun dibini kırdı mı, kapanışı tepeye göre %, kapanışından sonraki 60 dk'nın dibi (%)
 *   Fotoğraf : temel göstergeler + 1m–4h + VWAP seti + tepki seviyesi (marketSnap) + ek özellikler (peakFeatures: CVD, mum
 *              yapısı, hacim, uyumsuzluk, Bollinger, hız, piyasa, zaman, coin geçmişi, büyük resim) + baz + likidasyon +
 *              (canlıda, sonradan eklenir) açık pozisyon, long/short oranları, emir defteri, spot (marketData)
 *   Dipte    : tepeden sonraki 60 dk'nın en düşüğü — %, dk, en yakın destek ve EMA21 merdiveni
 *
 * Kartı ve tetik kurallarını ETKİLEMEZ. Rapor dili "eşlik eden durum"dur; kazanç/kayıp hesabı yoktur.
 */

const { evaluate, separationPct } = require('./infoEngine');
const ta = require('./ta');
const { tfIndicators, vwapSet, vwapFeatures, refLevels, nearest, TF_COLS, VWAP_COLS } = require('./marketSnap');
const { maLadder, stopOf } = require('./levelTouch');
const { extraFeatures, EXTRA_COLS } = require('./peakFeatures');
const { basisPct, ENRICH_COLS, LIQ_COLS } = require('./marketData');

const MIN = 60_000;
const TROUGH_MIN = 60;      // dip: tepeden sonraki 60 dk'nın en düşüğü
const DEFAULTS = {
  pumpPct: 3, pumpLookbackMin: 240, localHighMin: 60,
  peakWindowMin: 15, dropPct: 1.5, contPct: 0, sampleGapMin: 5, cardBeforeMin: 15, cardAfterMin: 5,
  windows: [5, 15, 60, 240],
};

const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/**
 * Temel göstergelerin düz fotoğrafı.
 * @param {object} snap  evaluate(..., force=true) çıktısı
 */
function features(snap, series, extra = {}) {
  const vol = Object.fromEntries((snap.vol || []).map(v => [v.label, v]));
  const b60 = snap.bursts?.[snap.windows?.[0]]?.p1;
  const c5 = series.col('5m', 'c', false), h5 = series.col('5m', 'h', false), l5 = series.col('5m', 'l', false);
  const atr = ta.atrSeries(h5, l5, c5, 14);
  const price = snap.price;
  const mc = tf => snap.macd?.[tf] ? (snap.macd[tf].cross || (snap.macd[tf].weakening ? 'zayıf' : 'güçlü')) : null;
  return {
    price,
    rsi3: num(snap.rsi?.['3m']?.v, 1), rsi5: num(snap.rsi?.['5m']?.v, 1), rsi15: num(snap.rsi?.['15m']?.v, 1),
    rsi1h: num(snap.conf?.h1, 1), rsi4h: num(snap.conf?.h4, 1),
    hits: snap.hits, rsiOk: Boolean(snap.rsiOk), ok: Boolean(snap.ok), grade: snap.grade ?? 0, score: snap.check?.score ?? null,
    checkOk: snap.check ? snap.check.items.filter(x => x.ok).map(x => x.key).join('|') : '',
    fails: (snap.fails || []).join('|'),
    lvName: snap.level?.name ?? null, lvKind: snap.level?.kind ?? null, lvDist: num(snap.level?.dist, 3), lvZone: snap.level?.zone ?? null,
    discovery: Boolean(snap.discovery),
    sep3: num(snap.sepPct?.['3m']), sep5: num(snap.sepPct?.['5m']), sep15: num(separationPct(series, '15m', price)),
    atr5Pct: atr.length && price > 0 ? num(atr[atr.length - 1] / price * 100, 3) : null,
    ride: snap.ride?.state ?? null,
    neg1: snap.neg?.['1m']?.count ?? 0, neg3: snap.neg?.['3m']?.count ?? 0,
    macd3: mc('3m'), macd5: mc('5m'), macd15: mc('15m'),
    stochK: num(snap.stoch?.k, 1), stochD: num(snap.stoch?.d, 1), stochCross: snap.stoch?.cross ?? null,
    vwapSig: num(snap.vwap?.pos), vwapPct: snap.vwap?.vwap > 0 ? num((price - snap.vwap.vwap) / snap.vwap.vwap * 100) : null,
    vol15x: num(vol['15 dk']?.x), vol15buy: num(vol['15 dk']?.buy, 1), vol60x: num(vol['1 saat']?.x), vol60buy: num(vol['1 saat']?.buy, 1),
    vol240x: num(vol['4 saat']?.x), vol240buy: num(vol['4 saat']?.buy, 1), vol24x: num(vol['24 saat']?.x), vol24buy: num(vol['24 saat']?.buy, 1),
    burstBuy60: b60 ? b60.buy : null, burstSell60: b60 ? b60.sell : null,
    funding: snap.funding ? num(snap.funding.rate * 100, 4) : null, btc1h: num(snap.btc1h), chg15: num(snap.chg),
    hpu4h: Boolean(snap.counter?.hpu), gc1d: snap.counter?.gc?.state ?? null,
    ...extra,
  };
}
const BASE_COLS = Object.keys(features({ price: 1 }, { col: () => [] }));
const PEAK_COLS = ['pumpPct', 'pumpMin', 'pkLv', 'pkLvKind', 'pkLvDist', 'pkLvTouches', 'pkNear'];
const TROUGH_COLS = ['trPct', 'trMin', 'trLv', 'trLvKind', 'trLvDist', 'trLvTouches', 'trNear', 'trEma', 'trFalling'];
const OUTCOME_COLS = ['outcome', 'upBeforeDrop', 't1', 't2', 't3', 'c5Red', 'c5Engulf', 'c5BelowPrev', 'c5ClosePct', 'c5Next60Low'];
const FEATURE_COLS = [...BASE_COLS, ...PEAK_COLS, ...TF_COLS, ...VWAP_COLS, ...EXTRA_COLS, 'basisPct', ...LIQ_COLS, ...ENRICH_COLS, ...TROUGH_COLS, ...OUTCOME_COLS];

/** Tepe anının tam fotoğrafı */
function peakFeatures(series, s, ctx, high, pump, loT, tc, history = null) {
  const snap = evaluate(series, s, ctx, true);
  const vw = vwapSet(series, loT);
  const nr = nearest(refLevels(series, s, vw), high);
  const tfi = tfIndicators(series, s, snap.price);
  const sym = series.symbol;
  const prem = ctx.funding ? ctx.funding(sym) : null;
  const d = series.d['1m'], n = d.q.length;
  let q15 = 0; for (let i = Math.max(0, n - 15); i < n; i++) q15 += d.q[i];
  return features(snap, series, {
    pumpPct: num(pump), pumpMin: Math.round((tc - loT) / MIN),
    pkLv: nr.best?.name ?? null, pkLvKind: nr.best?.kind ?? null, pkLvDist: nr.best?.dist ?? null, pkLvTouches: nr.best?.touches ?? null, pkNear: nr.near.join('|'),
    ...tfi, ...vwapFeatures(vw, snap.price),
    ...extraFeatures(series, { s, ctx, price: snap.price, t: tc, pumpPct: pump, pumpMin: Math.round((tc - loT) / MIN), atr1h: tfi.atr_1h, funding: prem, history }),
    basisPct: basisPct(prem),
    ...(ctx.liq ? ctx.liq(sym, tc, q15) : Object.fromEntries(LIQ_COLS.map(k => [k, null]))),
    ...Object.fromEntries(ENRICH_COLS.map(k => [k, null])),
  });
}

/** Dip anı: en yakın destek + EMA21 merdiveni */
function troughFeatures(series, s, low, anchorT) {
  const vw = vwapSet(series, anchorT);
  const nr = nearest(refLevels(series, s, vw), low);
  const st = stopOf(low, maLadder(series));
  return { trLv: nr.best?.name ?? null, trLvKind: nr.best?.kind ?? null, trLvDist: nr.best?.dist ?? null, trLvTouches: nr.best?.touches ?? null, trNear: nr.near.join('|'), trEma: st.stop };
}

/**
 * @param {object} opts  DEFAULTS + { enrich(sym, {t, price, futQ60}) → Promise<obj|null>, orderBook(sym) → Promise<obj|null> }
 */
function createDropLedger(opts = {}) {
  const E = { ...DEFAULTS, ...opts };
  const W = [...E.windows].sort((a, b) => a - b), WMAX = W[W.length - 1];
  const state = new Map();     // sym → { cand, lastCommit, open: [], hist: [{t, outcome}], obAt, ob }
  const cards = new Map();     // sym → [{t, grade}]
  let openN = 0;
  const st = sym => { let x = state.get(sym); if (!x) { x = { cand: null, lastCommit: 0, open: [], hist: [], obAt: 0, ob: null }; state.set(sym, x); } return x; };

  function history(sym, x, t) {
    const h = x.hist.filter(e => e.t >= t - 1440 * MIN);
    const drops = h.filter(e => e.outcome === 'düştü');
    const cs = (cards.get(sym) || []).filter(c => c.t >= t - 1440 * MIN && c.t <= t);
    return { samples24h: h.length, drops24h: drops.length, cards24h: cs.length, lastOutcome: h.length ? h[h.length - 1].outcome : null,
      minsSinceDrop: drops.length ? Math.round((t - drops[drops.length - 1].t) / MIN) : null };
  }

  function finish(e) {
    const until = (e.dropT ?? e.t + E.peakWindowMin * MIN) + E.cardAfterMin * MIN;
    const cs = (cards.get(e.symbol) || []).filter(c => c.t >= e.t - E.cardBeforeMin * MIN && c.t <= until);
    const trMin = e.trT != null ? Math.round((e.trT - e.t) / MIN) : null;
    const tail = {
      trPct: e.trLow < Infinity ? num((e.trLow - e.price) / e.price * 100, 3) : null, trMin,
      trLv: null, trLvKind: null, trLvDist: null, trLvTouches: null, trNear: '', trEma: null, ...(e.trSnap || {}), trFalling: trMin != null && trMin >= TROUGH_MIN - 5,
      outcome: e.status, upBeforeDrop: num(e.upMax * 100, 3), t1: e.hit[1], t2: e.hit[2], t3: e.hit[3],
      c5Red: e.c5 ? e.c5.red : null, c5Engulf: e.c5 ? e.c5.engulf : null, c5BelowPrev: e.c5 ? e.c5.belowPrev : null,
      c5ClosePct: e.c5 ? e.c5.closePct : null, c5Next60Low: e.c5 && e.c5.low < Infinity ? num((e.c5.low - e.c5.close) / e.c5.close * 100, 3) : null,
    };
    return {
      id: e.id, symbol: e.symbol, t: e.t, price: e.price, outcome: e.status, dropT: e.dropT ?? null, dropMin: e.dropT ? Math.round((e.dropT - e.t) / MIN) : null,
      card: cs.length > 0, cardGrade: cs.length ? Math.max(...cs.map(c => c.grade || 0)) : null,
      feat: { ...e.feat, ...tail }, out: e.out,
    };
  }

  /** Aday / örnek için bir 1m mumu işle (c.t = açılış). Sonuç ilk kez belli olduysa true döner. */
  function advance(e, c) {
    if (c.t < e.t) return false;
    const el = c.t + MIN - e.t, p = e.price;
    if (el <= TROUGH_MIN * MIN && c.l < e.trLow) { e.trLow = c.l; e.trT = c.t + MIN; e.trPending = true; }
    if (c.l < e.lo) e.lo = c.l;
    if (c.h > e.hi) e.hi = c.h;
    e.last = c.c;
    for (const k of [1, 2, 3]) if (e.hit[k] == null && c.l <= p * (1 - k / 100)) e.hit[k] = Math.round(el / MIN);
    if (e.c5 && e.c5.low !== undefined && c.t >= e.c5.T && c.t + MIN - e.c5.T <= 60 * MIN && c.l < e.c5.low) e.c5.low = c.l;
    for (const w of W) {
      if (e.out[w] || el < w * MIN) continue;
      e.out[w] = { low: num((e.lo - p) / p * 100, 3), high: num((e.hi - p) / p * 100, 3), close: num((e.last - p) / p * 100, 3) };
    }
    let resolved = false;
    if (e.status == null) {
      const drop = c.l <= p * (1 - E.dropPct / 100), cont = c.h > p * (1 + E.contPct / 100);
      if (!drop) e.upMax = Math.max(e.upMax, (c.h - p) / p);
      if (drop && cont) e.status = c.c < c.o ? 'düştü' : 'devam';
      else if (drop) e.status = 'düştü';
      else if (cont) e.status = 'devam';
      else if (el >= E.peakWindowMin * MIN) e.status = 'yatay';
      if (e.status === 'düştü') e.dropT = c.t + MIN;
      resolved = e.status != null;
    }
    return resolved;
  }

  /** İlk tam 5dk mum (açılışı ≥ tepe anı): teyit mumu */
  function confirm5(e, series) {
    if (e.c5) return;
    const d5 = series.d['5m'], n = d5.t.length;
    if (n < 2 || d5.t[n - 1] < e.t) return;
    let j = n - 1;
    while (j > 0 && d5.t[j - 1] >= e.t) j--;
    const o = d5.o[j], c = d5.c[j], po = d5.o[j - 1], pc = d5.c[j - 1], pl = d5.l[j - 1];
    e.c5 = { T: d5.t[j] + 5 * MIN, close: c, low: Infinity, red: c < o, engulf: c < o && o >= Math.max(po, pc) && c <= Math.min(po, pc),
      belowPrev: c < pl, closePct: num((c - e.price) / e.price * 100, 3) };
  }

  function newSample(series, s, ctx, x, c, tc, pump, loT) {
    const sym = series.symbol;
    const e = { id: `${sym}-${tc}`, symbol: sym, t: tc, price: c.h, anchorT: loT, status: null, dropT: null, upMax: 0,
      hit: { 1: null, 2: null, 3: null }, c5: null, lo: Infinity, hi: -Infinity, last: null, out: {}, trLow: Infinity, trT: null,
      feat: peakFeatures(series, s, ctx, c.h, pump, loT, tc, history(sym, x, tc)) };
    // Emir defteri tepe anında (coin başına en fazla 60 sn'de bir; araya giren adaylar son fotoğrafı kullanır)
    if (E.orderBook) {
      if (tc - x.obAt >= MIN) {
        x.obAt = tc;
        const setOb = ob => { if (ob) { x.ob = ob; Object.assign(e.feat, ob); } };
        const r = E.orderBook(sym);
        if (r && typeof r.then === 'function') r.then(setOb).catch(() => {}); else setOb(r);
      } else if (x.ob) Object.assign(e.feat, x.ob);
    }
    return e;
  }

  function commit(series, x, e) {
    x.open.push(e); openN++;
    x.lastCommit = e.t;
    x.hist.push({ t: e.t, outcome: e.status });
    while (x.hist.length && x.hist[0].t < e.t - 1440 * MIN) x.hist.shift();
    if (E.enrich) {
      const d = series.d['1m'], n = d.q.length;
      let q60 = 0; for (let i = Math.max(0, n - 60); i < n; i++) q60 += d.q[i];
      const merge = r => { if (r) for (const [k, v] of Object.entries(r)) if (!(k.startsWith('ob') && e.feat[k] != null)) e.feat[k] = v; };
      const r = E.enrich(e.symbol, { t: e.t, price: e.price, futQ60: q60 });   // canlıda Promise (saniyeler), testte düz nesne olabilir
      if (r && typeof r.then === 'function') r.then(merge).catch(() => {}); else merge(r);
    }
  }

  return {
    E,
    /**
     * Kapanmış her 1m mumda (canlı / backtest; step'ten SONRA) çağrılır.
     * @returns {object[]} en uzun penceresi dolan örnekler (kayda hazır)
     */
    observe(series, s, ctx = {}) {
      const sym = series.symbol;
      const d = series.d['1m'];
      const i = d.t.length - 1;
      if (i < 30) return [];
      const c = { t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] }, tc = c.t + MIN;
      const x = st(sym);
      const done = [];
      // 1) kaydedilmiş örnekler
      for (let k = x.open.length - 1; k >= 0; k--) {
        const e = x.open[k];
        advance(e, c);
        confirm5(e, series);
        if (e.trPending) { e.trSnap = troughFeatures(series, s, e.trLow, e.anchorT); e.trPending = false; }
        if (e.out[WMAX]) { done.push(finish(e)); x.open.splice(k, 1); openN--; }
      }
      // 2) açık aday: sonuç belli olduysa kaydet ya da bırak
      const cd = x.cand;
      if (cd && tc > cd.t) {
        advance(cd, c);
        confirm5(cd, series);
        if (cd.trPending) { cd.trSnap = troughFeatures(series, s, cd.trLow, cd.anchorT); cd.trPending = false; }
        if (cd.status) {
          x.cand = null;
          if (cd.status !== 'devam' || cd.t - x.lastCommit >= E.sampleGapMin * MIN) {
            commit(series, x, cd);
            if (cd.out[WMAX]) { done.push(finish(cd)); x.open.pop(); openN--; }
          }
        }
      }
      // 3) yeni aday: 60 dk'nın en yükseği + pompa (önceki aday daha yüksek tepeyle "devam" olarak kapandıysa bu mum yeni aday)
      if (!series.ready() || x.cand) return done;
      let hi60 = -Infinity, lo4h = Infinity, loT = null;
      for (let j = Math.max(0, i - E.localHighMin + 1); j <= i; j++) if (d.h[j] > hi60) hi60 = d.h[j];
      if (c.h < hi60) return done;
      for (let j = Math.max(0, i - E.pumpLookbackMin + 1); j <= i; j++) if (d.l[j] < lo4h) { lo4h = d.l[j]; loT = d.t[j]; }
      const pump = (c.h / lo4h - 1) * 100;
      if (!(pump >= E.pumpPct)) return done;
      x.cand = newSample(series, s, ctx, x, c, tc, pump, loT);
      return done;
    },

    noteCard(sym, t, grade) {
      const a = cards.get(sym) || [];
      a.push({ t, grade });
      while (a.length && a[0].t < t - 1500 * MIN) a.shift();
      cards.set(sym, a);
    },

    /** Mum gelmeyen coinlerin süresi dolan örneklerini (kaydetmeden) bırakır */
    sweep(now = Date.now()) {
      for (const [sym, x] of state) {
        for (let k = x.open.length - 1; k >= 0; k--) if (now - x.open[k].t > (WMAX + 15) * MIN) { x.open.splice(k, 1); openN--; }
        if (x.cand && now - x.cand.t > (E.peakWindowMin + 5) * MIN) x.cand = null;
        while (x.hist.length && x.hist[0].t < now - 1440 * MIN) x.hist.shift();
        if (!x.open.length && !x.cand && !x.hist.length) state.delete(sym);
      }
      for (const [sym, a] of cards) if (!a.length || a[a.length - 1].t < now - 1500 * MIN) cards.delete(sym);
    },
    openCount: () => openN,
  };
}
const createPeakLedger = createDropLedger;

// ── Rapor (/kacan, backtest) ────────────────────────────────────────────────

const median = a => { const b = a.filter(v => v != null && Number.isFinite(v)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pc = v => (v == null ? '—' : `%${Math.round(v)}`);
const pS = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d)}`);
const n0 = v => (v == null ? '—' : String(Math.round(v)));
const rate = (a, f) => (a.length ? a.filter(f).length / a.length * 100 : null);
const sgm = v => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

/** En sık 6 değer: "▫️ Günlük VWAP +2σ — %18 (40)"; değeri olmayanlar `none` satırında */
function topBlock(title, rows, f, none, max = 6) {
  if (!rows.length) return null;
  const m = new Map();
  for (const r of rows) { const k = f(r) || '∅'; m.set(k, (m.get(k) || 0) + 1); }
  const lines = [...m.entries()].filter(([k]) => k !== '∅').sort((a, b) => b[1] - a[1]).slice(0, max)
    .map(([k, n]) => `▫️ ${k} — ${pc(n / rows.length * 100)} (${n})`);
  if (m.get('∅')) lines.push(`▫️ ${none} — ${pc(m.get('∅') / rows.length * 100)} (${m.get('∅')})`);
  return [title, ...lines].join('\n');
}

function failNames(s) {
  return {
    rsi: `RSI ${s.rsiMin ?? 85}+ (3'te ${s.minTFs ?? 2}) yok`,
    seviye: `Direnç yok (%${s.levelMaxPct ?? 2.5} içinde)`,
    'ayrışma': 'Ayrışma şartı yok', destek: '1s/4s destek yok', macd: 'MACD şartı yok',
  };
}

/**
 * Telegram metni (HTML) — telefona göre kısa satırlar.
 * @param {object[]} rows  finish() çıktıları (DB'den okunan da aynı biçimde)
 */
function dropText(allRows, { title = '', s = {}, E = DEFAULTS } = {}) {
  const rows = allRows.filter(r => (r.outcome || r.feat?.outcome || 'düştü') === 'düştü');
  const oc = k => allRows.filter(r => (r.outcome || r.feat?.outcome || 'düştü') === k).length;
  const head = `📉 <b>Düşüş defteri</b>${title ? `\n🗓 ${title}` : ''}
<i>Pompa tepesi → ${E.peakWindowMin} dk'da ≥ %${E.dropPct} düşüş</i>${allRows.length > rows.length ? `\n🔎 Tepe adayı ${allRows.length}: düştü ${rows.length} · devam ${oc('devam')} · yatay ${oc('yatay')}` : ''}`;
  if (!rows.length) return `${head}\n\nKayıt yok.`;
  const yes = rows.filter(r => r.card), no = rows.filter(r => !r.card);
  const F = failNames(s);
  const reasons = new Map();
  for (const r of no) {
    const fs = (r.feat?.fails || '').split('|').filter(Boolean);
    if (!fs.length) reasons.set('none', (reasons.get('none') || 0) + 1);
    for (const f of fs) reasons.set(f, (reasons.get(f) || 0) + 1);
  }
  const reasonLines = [...reasons.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `▫️ ${k === 'none' ? 'Şart vardı, kart çıkmadı*' : (F[k] || k)} — ${pc(n / no.length * 100)} (${n})`);
  const hitsLine = no.length ? `▫️ ${s.rsiMin ?? 85}+ dilim: 0 → ${pc(rate(no, r => r.feat?.hits === 0))} · 1 → ${pc(rate(no, r => r.feat?.hits === 1))} · 2+ → ${pc(rate(no, r => r.feat?.hits >= 2))}` : null;
  const md = (a, k) => median(a.map(r => r.feat?.[k]));
  const cmp = (label, f) => `▫️ ${label}: ${f(yes)} / ${f(no)}`;
  const parts = [
    head,
    [`✅ Kartlı: ${yes.length} (${pc(yes.length / rows.length * 100)})`, `❌ Kartsız: ${no.length} (${pc(no.length / rows.length * 100)})`].join('\n'),
    no.length ? ['❓ <b>Kartsızlarda eksik şart</b>', ...reasonLines, hitsLine].filter(Boolean).join('\n') : null,
    no.length ? ['🌡 <b>Kartsızlarda tepe RSI</b> (medyan)', `3dk ${n0(md(no, 'rsi3'))} · 5dk ${n0(md(no, 'rsi5'))} · 15dk ${n0(md(no, 'rsi15'))}`, `1s ${n0(md(no, 'rsi1h'))} · 4s ${n0(md(no, 'rsi4h'))}`].join('\n') : null,
    ['📊 <b>Kartlı / kartsız</b> (medyan)',
      cmp('RSI 5dk', a => n0(md(a, 'rsi5'))),
      cmp('RSI 15dk', a => n0(md(a, 'rsi15'))),
      cmp('3dk EMA21 üstü', a => pS(md(a, 'sep3'))),
      cmp('15dk EMA21 üstü', a => pS(md(a, 'sep15'))),
      cmp('VWAP σ', a => { const v = md(a, 'vwapSig'); return v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`; }),
      cmp('Pompa (4s dip→tepe)', a => pS(md(a, 'pumpPct'), 0)),
      cmp('Hacim 15dk (kat)', a => { const v = md(a, 'vol15x'); return v == null ? '—' : v.toFixed(1); }),
      cmp('MACD 3/5dk sat kes.', a => pc(rate(a, r => r.feat?.macd3 === 'down' || r.feat?.macd5 === 'down'))),
      cmp('Negatif tepe ≥ 2', a => pc(rate(a, r => Math.max(r.feat?.neg1 || 0, r.feat?.neg3 || 0) >= 2))),
      cmp('Dirençte', a => pc(rate(a, r => r.feat?.lvZone === 'dip'))),
    ].join('\n'),
    topBlock('🎯 <b>Tepe nereden tepki aldı</b>', rows, r => r.feat?.pkLv, 'Seviyeye değmedi'),
    (() => {
      const k = rows.filter(r => r.feat?.pkLvTouches != null);
      if (!k.length) return null;
      const minT = s.chartMinTouches ?? 4;
      return ['💪 <b>Tepki seviyesinin gücü</b>',
        `▫️ ${minT}+ kez test edilmiş — ${pc(rate(k, r => r.feat.pkLvTouches >= minT))} (${k.filter(r => r.feat.pkLvTouches >= minT).length})`,
        `▫️ 1–${minT - 1} kez — ${pc(rate(k, r => r.feat.pkLvTouches >= 1 && r.feat.pkLvTouches < minT))}`,
        `▫️ İlk kez — ${pc(rate(k, r => r.feat.pkLvTouches === 0))}`,
        `▫️ Medyan: ${n0(median(k.map(r => r.feat.pkLvTouches)))} temas`].join('\n');
    })(),
    topBlock('🛑 <b>Düşüş nerede durdu</b> (60 dk dibi)', rows, r => r.feat?.trLv, 'Desteğe değmedi'),
    topBlock('🪜 <b>Dip, EMA21 merdiveninde</b>', rows, r => (r.feat?.trEma === 'yok' ? null : r.feat?.trEma), 'EMA21\'e inmedi'),
    ['📐 <b>Tepede VWAP</b> (medyan, σ)',
      `Gün ${sgm(md(rows, 'vwD_sig'))} · Hafta ${sgm(md(rows, 'vwW_sig'))} · Ay ${sgm(md(rows, 'vwM_sig'))}`,
      `90dk ${sgm(md(rows, 'vw90_sig'))} · pompa dibi VWAP ${pS(md(rows, 'avwLow_pct'))}`].join('\n'),
    ['📉 <b>Tepeden sonra</b> (medyan)',
      ...E.windows.filter(w => w >= 15).map(w => cmp(`${w >= 60 ? `${w / 60} s` : `${w} dk`} en düşük`, a => pS(median(a.map(r => r.out?.[w]?.low))))),
      cmp('60 dk kapanış', a => pS(median(a.map(r => r.out?.[60]?.close)))),
      cmp('Düşüşe kadar', a => { const v = median(a.map(r => r.dropMin)); return v == null ? '—' : `${Math.round(v)} dk`; }),
      cmp('Düşmeden önce en fazla', a => pS(median(a.map(r => r.feat?.upBeforeDrop)), 2)),
      cmp('−%2\'ye', a => { const v = median(a.map(r => r.feat?.t2)); return v == null ? '—' : `${Math.round(v)} dk`; }),
    ].join('\n'),
    `<blockquote expandable>ℹ️ <b>Nasıl ölçülür</b>
• Tepe: 1 dk mumun tepesi son ${E.localHighMin} dk'nın en yükseği ve son ${E.pumpLookbackMin / 60} saatin dibinden ≥ %${E.pumpPct} yukarıda; o dakikada tüm göstergelerin fotoğrafı alınır
• Düşüş: tepeden sonraki ${E.peakWindowMin} dk içinde fiyat tepenin %${E.dropPct} altına indi
• Kartlı: o coinde tepeden ${E.cardBeforeMin} dk önce ile düşüşten ${E.cardAfterMin} dk sonrası arasında kart çıktı
• Eksik şart: tepe anında kart şartlarından tutmayanlar (biri birden fazla olabilir)
• *Şart vardı, kart çıkmadı: yeni bilgi yoktu, coin susturulmuştu ya da kontrol anı (3/5/15 dk kapanışı) tepeye denk gelmedi
• Tepki: tepenin %0.3 içindeki en yakın seviye — Fib, günlük/haftalık bölge, trend çizgisi, 7/30g en yüksek, MA200/EMA200, 1s/4s/15dk tepe, VWAP (gün/hafta/ay ±1/2/3σ, 90dk, 24s, 7g, pompa dibi), EMA21 (3/5/15dk/1s)
• Seviye gücü: seviyenin önceki ~100 günde (4s mumlar) kaç ayrı kez test edildiği (VWAP/EMA gibi hareketli seviyelerde yok)
• Durdu: tepeden sonraki 60 dk'nın dibine %0.3 içindeki en yakın seviye; EMA21 merdiveni: dibin indiği 3/5/15dk EMA21
• Tepeden sonra: tepe fiyatına göre en düşük / kapanış
• Yalnız "düştü" sonuçlu tepe adayları (devam / yatay için /teyit) · kazanç/kayıp değildir, "eşlik eden durum"dur</blockquote>`,
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 4096);
}

// ── Teyit adayları (/teyit) ───────────────────────────────────────────────────

/** [ad, alan (varlık için), koşul] — alan null olan adaylar o satırda sayılmaz */
const CANDS = [
  ['RSI 3/5/15dk hepsi eşikte', 'hits', f => f.hits >= 3],
  ['RSI 1s ≥ 80', 'rsi1h', f => f.rsi1h >= 80],
  ['RSI 4s ≥ 70', 'rsi4h', f => f.rsi4h >= 70],
  ['Negatif tepe ≥ 2 (1/3dk)', 'neg1', f => Math.max(f.neg1 || 0, f.neg3 || 0) >= 2],
  ['Negatif tepe 5dk', 'neg5', f => f.neg5 >= 1],
  ['Negatif tepe 15dk', 'neg15', f => f.neg15 >= 1],
  ['Negatif tepe 1s', 'neg1h', f => f.neg1h >= 1],
  ['CVD uyumsuz', 'cvdDiv', f => f.cvdDiv === true],
  ['Alış azalıyor (≥10 puan)', 'buyChg', f => f.buyChg <= -10],
  ['1dk üst fitil ≥ %50', 'wick_1m', f => f.wick_1m >= 0.5],
  ['5dk üst fitil ≥ %50', 'wick_5m', f => f.wick_5m >= 0.5],
  ['Hacim azalıyor (15dk)', 'volTrend15', f => f.volTrend15 < 0.8],
  ['Pompa yavaşlıyor', 'accel', f => f.accel < 0],
  ['BB 5dk dışında', 'bbB_5m', f => f.bbB_5m > 1],
  ['BB 15dk dışında', 'bbB_15m', f => f.bbB_15m > 1],
  ['BB 1s dışında', 'bbB_1h', f => f.bbB_1h > 1],
  ['VWAP gün ≥ +2σ', 'vwD_sig', f => f.vwD_sig >= 2],
  ['VWAP hafta ≥ +2σ', 'vwW_sig', f => f.vwW_sig >= 2],
  ['3dk EMA21 ≥ %2 üstü', 'sep3', f => f.sep3 >= 2],
  ['15dk EMA21 ≥ %5 üstü', 'sep15', f => f.sep15 >= 5],
  ['4+ temaslı seviyede', 'pkLvTouches', f => f.pkLvTouches >= 4],
  ['MACD 3/5dk sat kes.', 'macd3', f => f.macd3 === 'down' || f.macd5 === 'down'],
  ['Funding negatif', 'funding', f => f.funding < 0],
  ['Funding ≥ +%0.05', 'funding', f => f.funding >= 0.05],
  ['Baz ≥ +%0.1', 'basisPct', f => f.basisPct >= 0.1],
  ['OI 15dk düşüyor', 'oiChg15', f => f.oiChg15 < 0],
  ['OI 60dk ≥ +%5', 'oiChg60', f => f.oiChg60 >= 5],
  ['Short likidasyon ≥ %1', 'liqShortPct15', f => f.liqShortPct15 >= 1],
  ['Büyük trader long ≥ 1.5', 'lsTopPos', f => f.lsTopPos >= 1.5],
  ['Taker satış ağır (< 1)', 'takerLS', f => f.takerLS < 1],
  ['Defter satış ağır (%1)', 'obBid1', f => f.obBid1 < 0.4],
  ['Perp spot\'tan ≥ %0.3 pahalı', 'spotPrem', f => f.spotPrem >= 0.3],
  ['Spot hacim payı < %20', 'spotShare60', f => f.spotShare60 < 0.2],
  ['Gün ≥ +%20', 'dayChg', f => f.dayChg >= 20],
  ['1s Ichimoku üstünde', 'ichiPos', f => f.ichiPos === 'üst'],
  ['ABD seansı', 'session', f => f.session === 'ABD'],
  ['Funding\'e ≤ 30 dk', 'minToFunding', f => f.minToFunding <= 30],
  ['Kart çıktı', 'rsiOk', f => f.__card === true],
];
const isDrop = r => (r.outcome || r.feat?.outcome || 'düştü') === 'düştü';

/** Her aday için: varken / yokken düşüş oranı ve adet */
function teyitRows(rows, minN = 5) {
  const out = [];
  for (const [label, field, pred] of CANDS) {
    const av = rows.filter(r => r.feat && r.feat[field] != null);
    const yes = av.filter(r => pred({ ...r.feat, __card: r.card })), no = av.filter(r => !pred({ ...r.feat, __card: r.card }));
    if (yes.length < minN || !no.length) continue;
    const a = yes.filter(isDrop).length / yes.length * 100, b = no.filter(isDrop).length / no.length * 100;
    out.push({ label, n: yes.length, yes: a, no: b, diff: a - b });
  }
  return out.sort((x, y) => y.diff - x.diff);
}

function teyitText(rows, { title = '', E = DEFAULTS, minN = 5 } = {}) {
  const head = `🔬 <b>Teyit adayları</b>${title ? `\n🗓 ${title}` : ''}
<i>Tepe → ${E.peakWindowMin} dk'da ≥ %${E.dropPct} düştü mü?</i>`;
  if (!rows.length) return `${head}\n\nKayıt yok.`;
  const oc = k => rows.filter(r => (r.outcome || r.feat?.outcome || 'düştü') === k).length;
  const base = oc('düştü') / rows.length * 100;
  const T = teyitRows(rows, minN);
  const line = r => `▫️ ${r.label} — ${pc(r.yes)} / ${pc(r.no)} (${r.n})`;
  const up = T.filter(r => r.diff >= 3), down = T.filter(r => r.diff <= -3).reverse();
  const c5 = rows.filter(r => r.feat?.c5Next60Low != null);
  const c5rate = (f) => { const a = c5.filter(f); return a.length ? `${pc(a.filter(r => r.feat.c5Next60Low <= -E.dropPct).length / a.length * 100)} (${a.length})` : '—'; };
  const parts = [
    head,
    `🎯 ${rows.length} tepe adayı\n🔴 düştü ${pc(base)} · 🟢 devam ${pc(oc('devam') / rows.length * 100)} · ⚪ yatay ${pc(oc('yatay') / rows.length * 100)}`,
    up.length ? ['📈 <b>Varken daha sık düşüyor</b>', '<i>düşüş: varken / yokken (adet)</i>', ...up.slice(0, 14).map(line)].join('\n') : '📈 Belirgin fark yok (en az %3 puan)',
    down.length ? ['📉 <b>Varken daha AZ düşüyor</b> (devam riski)', ...down.slice(0, 6).map(line)].join('\n') : null,
    c5.length ? ['🕯 <b>5dk teyit mumu</b>', `<i>sonraki 60 dk ≥ %${E.dropPct} düşüş oranı</i>`,
      `▫️ Kırmızı — ${c5rate(r => r.feat.c5Red === true)}`,
      `▫️ Yutan ayı — ${c5rate(r => r.feat.c5Engulf === true)}`,
      `▫️ Önceki dibi kırdı — ${c5rate(r => r.feat.c5BelowPrev === true)}`,
      `▫️ Yeşil — ${c5rate(r => r.feat.c5Red === false)}`].join('\n') : null,
    `<blockquote expandable>ℹ️ <b>Nasıl okunur</b>
• Aday: pompada (4 saatlik dipten ≥ %${E.pumpPct}) 60 dk'nın en yüksek tepesi; fiyat daha yükseğe çıkarsa yeni aday
• Düştü: ${E.peakWindowMin} dk içinde önce %${E.dropPct} düşüş · devam: önce daha yüksek tepe · yatay: ikisi de değil
• Satır: o durum varken / yokken adayların yüzde kaçı düştü, parantezde varken adet (en az ${minN}). Fark ≥ 3 puan olanlar
• Aynı pompadan birden fazla aday olabilir (devam en fazla ${E.sampleGapMin} dk'da bir) — adaylar birbirinden bağımsız değildir
• 5dk teyit mumu: tepeden sonraki ilk tam 5dk mum; oran mumun kapanışından sonraki 60 dk'ya göre
• Kazanç/kayıp değildir, "eşlik eden durum"dur; az örnekte farklar tesadüf olabilir</blockquote>`,
  ].filter(Boolean);
  return parts.join('\n\n').slice(0, 4096);
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const csvCell = v => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** @param {object[]} rows  @param {string[]} cols */
function toCsv(rows, cols) {
  return '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/** Düşüş olayı → düz CSV satırı */
function flatDrop(r, windows = DEFAULTS.windows) {
  const o = { id: r.id, symbol: r.symbol, time: Number.isFinite(r.t) ? new Date(r.t).toISOString() : null, peak: r.price, outcome: r.outcome ?? r.feat?.outcome ?? null, dropMin: r.dropMin, card: r.card ? 1 : 0, cardGrade: r.cardGrade };
  for (const w of windows) for (const k of ['low', 'high', 'close']) o[`${k}${w}`] = r.out?.[w]?.[k] ?? null;
  for (const c of FEATURE_COLS) if (c !== 'outcome') o[c] = typeof r.feat?.[c] === 'boolean' ? (r.feat[c] ? 1 : 0) : r.feat?.[c] ?? null;
  return o;
}
const dropCols = (windows = DEFAULTS.windows) => Object.keys(flatDrop({ out: {}, feat: {} }, windows));

module.exports = { teyitText, teyitRows, CANDS, createDropLedger, createPeakLedger, features, peakFeatures, FEATURE_COLS, TROUGH_COLS, OUTCOME_COLS, DEFAULTS, dropText, toCsv, flatDrop, dropCols };
