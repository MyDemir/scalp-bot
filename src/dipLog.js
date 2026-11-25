'use strict';

/**
 * Dip defteri — tepe defterinin (src/eventLog.js createDropLedger) AYNASI: düşüşteki HER dip adayı ve sonucu
 * (döndü / devam / yatay). Kart, derece, tetik ve bildirim DEĞİŞMEZ; yalnız kayıt (cards.db `dips`, dipler.csv).
 *
 *   Aday     : kapanmış 1m mumun LOW'u son localLowMin (60) dk'nın en düşüğü VE son dumpLookbackMin (240) dk'nın en
 *              yükseğinden ≥ %dumpPct (3) aşağıda. O dakikada tepe adayındaki fotoğrafın aynısı alınır. Kayıttaki dip
 *              her zaman gerçek diptir (daha düşük low → önceki aday "devam" ile kapanır, o mumda yeni aday).
 *   Sonuç    : adaydan sonraki bounceWindowMin (15) dk içinde
 *                döndü — fiyat dibin %bouncePct (1.5) üstüne çıktı (önce)
 *                devam — fiyat dibin altına indi (önce; contPct, varsayılan 0)
 *                yatay — ikisi de olmadı
 *              Aynı mumda ikisi: kapanış > açılış → döndü, değilse devam (sameBar = 1).
 *   Kayıt    : "döndü" ve "yatay" hep; "devam" en fazla sampleGapMin (5) dk'da bir (contSkipped sayacı).
 *   Sonrası  : dibe göre 5/15/30/60/240 dk en düşük / en yüksek / kapanış (%) · girişe (aday 1m kapanışı) göre
 *              highC15 / lowC60 / closeC60 / closeC240 · bounceC15 · downBeforeBounce · u1/u2/u3 · tepki tepesi (rb*) ·
 *              ilk tam 5dk mum (c5*).
 *
 * Canlı ve backtest aynı kod; yalnız kapanmış mumlar okunur (look-ahead yok). Rapor dili "eşlik eden durum"dur.
 */

const { evaluate, gradeAudit } = require('./infoEngine');
const ta = require('./ta');
const { tfIndicators, vwapSet, vwapFeatures, refLevels, nearest, TF_COLS, VWAP_COLS } = require('./marketSnap');
const { extraFeatures, cvdDivBull, quoteVol24h, EXTRA_COLS, EXTRA_AUDIT_COLS } = require('./peakFeatures');
const { basisPct, ENRICH_COLS, LIQ_COLS } = require('./marketData');
const { features, sepClosed, fromEntry } = require('./eventLog');
const { structureFeatures, STRUCT_COLS } = require('./structure');
const PKG_VERSION = String(require('../package.json').version ?? '');
// Kayıt davranışı değişince elle artır (dipler.csv dipVer)
const DIP_VER = '2026.11.25-1';

const MIN = 60_000;
const REBOUND_MIN = 60;     // tepki tepesi: dipten sonraki 60 dk'nın en yükseği
const DIP_DEFAULTS = {
  dumpPct: 3, dumpLookbackMin: 240, localLowMin: 60,
  bounceWindowMin: 15, bouncePct: 1.5, contPct: 0, sampleGapMin: 5, cardBeforeMin: 15, cardAfterMin: 5,
  windows: [5, 15, 30, 60, 240],
};

const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const lvFields = (pre, nr) => ({
  [`${pre}Lv`]: nr.best?.name ?? null, [`${pre}LvKind`]: nr.best?.kind ?? null, [`${pre}LvDist`]: nr.best?.dist ?? null,
  [`${pre}LvTouches`]: nr.best?.touches ?? null, [`${pre}Near`]: nr.near.join('|'),
});

const BASE_COLS = Object.keys(features({ price: 1 }, { col: () => [] }));
const DIP_SPEC_COLS = ['dumpPct', 'dumpMin', 'dpLv', 'dpLvKind', 'dpLvDist', 'dpLvTouches', 'dpNear'];
const REBOUND_COLS = ['rbPct', 'rbMin', 'rbLv', 'rbLvKind', 'rbLvDist', 'rbLvTouches', 'rbNear'];
const DIP_OUTCOME_COLS = ['downBeforeBounce', 'u1', 'u2', 'u3', 'c5Green', 'c5Engulf', 'c5AbovePrev', 'c5ClosePct', 'c5Next60High'];
const DIP_AUDIT_COLS = ['sameBar', 'cardWhen', 'contSkipped', 'rsi15c', 'rsi1hc', 'rsi4hc', ...EXTRA_AUDIT_COLS, 'spotQ60', 'spotShare60t',
  'rsi3c', 'rsi5c', 'sep3c', 'sep5c', 'incTf', 'inc5', 'inc15', 'lvZoneHiN', 'lvZoneLoN', 'dpLvTouchUp', 'dpLvTouchDn',
  'gradeOld', 'g_sep', 'g_h1', 'g_r15', 'g_atr', 'g_macd', 'g_stoch', 'g_rsi3hi', 'g_runaway', 'cfgGradeRsi15m', 'cfgGradeAtr5Pct', 'cfgGradeMacd5m', 'cfgGradeStoch5m', 'cfgSepPct2', 'cfgGradeRsi3m', 'gradeVer',
  'highC15', 'lowC60', 'closeC60', 'closeC240', 'bounceC15',
  'avwHigh_pct', 'cvdDivBull', 'bounces24h', 'minsSinceBounce',
  'cfgDumpPct', 'cfgBouncePct', 'cfgBounceWindowMin', 'cfgSampleGapMin', 'cfgVer', 'dipVer',
  'breadth20', 'dumping', 'q24h',
  ...STRUCT_COLS];   // fiyat yapısı (src/structure.js) en sonda
const DIP_COLS = [...BASE_COLS, ...DIP_SPEC_COLS, ...TF_COLS, ...VWAP_COLS, ...EXTRA_COLS, 'basisPct', ...LIQ_COLS, ...ENRICH_COLS,
  ...REBOUND_COLS, ...DIP_OUTCOME_COLS, ...DIP_AUDIT_COLS];

/**
 * Dip anının tam fotoğrafı (tepe adayındaki peakFeatures'ın aynası).
 * avwLow_pct (pompa dibinden sabitlenmiş VWAP) dipte uygulanamaz → null; yerine avwHigh_pct (düşüşün 4s tepesinden sabitlenmiş VWAP).
 */
function dipFeatures(series, s, ctx, low, dump, hiT, tc, history = {}) {
  const snap = evaluate(series, s, ctx, true);
  const vw = vwapSet(series, hiT);
  const vwLv = { ...vw, aLow: null };              // "Pompa dibi VWAP" adı dipte yanlış olur: seviye listesine girmez
  const nr = nearest(refLevels(series, s, vwLv), low);
  const tfi = tfIndicators(series, s, snap.price);
  const sym = series.symbol;
  const prem = ctx.funding ? ctx.funding(sym) : null;
  const d = series.d['1m'], n = d.q.length;
  let q15 = 0; for (let i = Math.max(0, n - 15); i < n; i++) q15 += d.q[i];
  const dumpMin = Math.round((tc - hiT) / MIN);
  const vf = vwapFeatures(vw, snap.price);
  const avwHigh = vf.avwLow_pct; vf.avwLow_pct = null;
  const mk = ctx.market ? ctx.market(tc) : null;
  return features(snap, series, {
    dumpPct: num(dump), dumpMin,
    ...lvFields('dp', nr), dpLvTouchUp: nr.best?.touchesUp ?? null, dpLvTouchDn: nr.best?.touchesDn ?? null,
    lvZoneHiN: nr.best?.zoneHiN ?? null, lvZoneLoN: nr.best?.zoneLoN ?? null,
    ...tfi, ...vf, avwHigh_pct: avwHigh,
    // pumpPct/pumpMin yerine düşüş (pozitif %) ve süresi: pumpAtr = dumpPct / 1h ATR %, volPeakX(c) = dip 1dk hacmi / düşüş süresi ortalaması
    ...extraFeatures(series, { s, ctx, price: snap.price, t: tc, pumpPct: dump, pumpMin: dumpMin, atr1h: tfi.atr_1h, funding: prem,
      history: { samples24h: history.samples24h, cards24h: history.cards24h, lastOutcome: history.lastOutcome } }),
    bounces24h: history.bounces24h ?? null, minsSinceBounce: history.minsSinceBounce ?? null,
    basisPct: basisPct(prem),
    ...(ctx.liq ? ctx.liq(sym, tc, q15) : Object.fromEntries(LIQ_COLS.map(k => [k, null]))),
    ...Object.fromEntries(ENRICH_COLS.map(k => [k, null])), spotQ60: null, spotShare60t: null,
    rsi15c: num(ta.rsiLast(series.col('15m', 'c', false), s.rsiPeriod), 1),
    rsi1hc: num(ta.rsiLast(series.col('1h', 'c', false), s.rsiPeriod), 1),
    rsi4hc: num(ta.rsiLast(series.col('4h', 'c', false), s.rsiPeriod), 1),
    rsi3c: num(ta.rsiLast(series.col('3m', 'c', false), s.rsiPeriod), 1),
    rsi5c: num(ta.rsiLast(series.col('5m', 'c', false), s.rsiPeriod), 1),
    sep3c: sepClosed(series, '3m'), sep5c: sepClosed(series, '5m'),
    incTf: ['3m', '5m', '15m', '1h', '4h'].filter(tf => series.incomplete(tf, 14) > 0).join('|'),
    inc5: series.incomplete('5m', 14), inc15: series.incomplete('15m', 14),
    ...gradeAudit(snap, s),
    cvdDivBull: cvdDivBull(d),
    breadth20: mk?.breadth20 ?? null, dumping: mk?.dumping ?? null, q24h: quoteVol24h(series),
    ...structureFeatures(series, snap.price, tc),
  });
}

/**
 * @param {object} opts  DIP_DEFAULTS + { enrich(sym, {t, price, futQ60}) → Promise<obj|null>, orderBook(sym) → Promise<obj|null> }
 *                       (tepe defteriyle aynı imza; verilmezse ENRICH alanları null)
 */
function createDipLedger(opts = {}) {
  const E = { ...DIP_DEFAULTS, ...opts };
  const W = [...E.windows].sort((a, b) => a - b), WMAX = W[W.length - 1];
  const state = new Map();     // sym → { cand, lastCommit, skipped, open: [], hist: [{t, outcome}], obAt, ob }
  const cards = new Map();     // sym → [{t, grade}]
  let openN = 0;
  const st = sym => { let x = state.get(sym); if (!x) { x = { cand: null, lastCommit: 0, skipped: 0, open: [], hist: [], obAt: 0, ob: null }; state.set(sym, x); } return x; };

  function history(sym, x, t) {
    const h = x.hist.filter(e => e.t >= t - 1440 * MIN);
    const b = h.filter(e => e.outcome === 'döndü');
    const cs = (cards.get(sym) || []).filter(c => c.t >= t - 1440 * MIN && c.t <= t);
    return { samples24h: h.length, bounces24h: b.length, cards24h: cs.length, lastOutcome: h.length ? h[h.length - 1].outcome : null,
      minsSinceBounce: b.length ? Math.round((t - b[b.length - 1].t) / MIN) : null };
  }

  function finish(e) {
    const endT = e.bounceT ?? e.t + E.bounceWindowMin * MIN;
    const until = endT + E.cardAfterMin * MIN;
    const cs = (cards.get(e.symbol) || []).filter(c => c.t >= e.t - E.cardBeforeMin * MIN && c.t <= until);
    const cardT = cs.length ? Math.min(...cs.map(c => c.t)) : null;
    const rbMin = e.rbT != null ? Math.round((e.rbT - e.t) / MIN) : null;
    const entry = e.feat.price;
    const fe = (w, k) => num(fromEntry(e.out[w]?.[k], e.price, entry), 3);
    const highC15 = fe(15, 'high');
    const tail = {
      highC15, lowC60: fe(60, 'low'), closeC60: fe(60, 'close'), closeC240: fe(240, 'close'),
      bounceC15: highC15 == null ? null : highC15 >= E.bouncePct ? 1 : 0,
      sameBar: e.sameBar ? 1 : 0,
      cardWhen: cardT == null ? null : cardT <= e.t ? 'önce' : cardT <= endT ? 'arada' : 'sonra',
      rbPct: e.rbHigh > -Infinity ? num((e.rbHigh - e.price) / e.price * 100, 3) : null, rbMin,
      rbLv: null, rbLvKind: null, rbLvDist: null, rbLvTouches: null, rbNear: '', ...(e.rbSnap || {}),
      downBeforeBounce: num(e.downMin * 100, 3), u1: e.hit[1], u2: e.hit[2], u3: e.hit[3],
      c5Green: e.c5 ? e.c5.green : null, c5Engulf: e.c5 ? e.c5.engulf : null, c5AbovePrev: e.c5 ? e.c5.abovePrev : null,
      c5ClosePct: e.c5 ? e.c5.closePct : null, c5Next60High: e.c5 && e.c5.high > -Infinity ? num((e.c5.high - e.c5.close) / e.c5.close * 100, 3) : null,
    };
    return {
      id: e.id, symbol: e.symbol, t: e.t, price: e.price, outcome: e.status, bounceT: e.bounceT ?? null,
      bounceMin: e.bounceT ? Math.round((e.bounceT - e.t) / MIN) : null,
      card: cs.length > 0, cardGrade: cs.length ? Math.max(...cs.map(c => c.grade || 0)) : null,
      feat: { ...e.feat, ...tail }, out: e.out,
    };
  }

  /** Aday / örnek için bir 1m mumu işle (c.t = açılış). Sonuç ilk kez belli olduysa true döner. */
  function advance(e, c) {
    if (c.t < e.t) return false;
    const el = c.t + MIN - e.t, p = e.price;
    if (el <= REBOUND_MIN * MIN && c.h > e.rbHigh) { e.rbHigh = c.h; e.rbT = c.t + MIN; e.rbPending = true; }
    if (c.l < e.lo) e.lo = c.l;
    if (c.h > e.hi) e.hi = c.h;
    e.last = c.c;
    for (const k of [1, 2, 3]) if (e.hit[k] == null && c.h >= p * (1 + k / 100)) e.hit[k] = Math.round(el / MIN);
    if (e.c5 && c.t >= e.c5.T && c.t + MIN - e.c5.T <= 60 * MIN && c.h > e.c5.high) e.c5.high = c.h;
    for (const w of W) {
      if (e.out[w] || el < w * MIN) continue;
      e.out[w] = { low: num((e.lo - p) / p * 100, 3), high: num((e.hi - p) / p * 100, 3), close: num((e.last - p) / p * 100, 3) };
    }
    let resolved = false;
    if (e.status == null) {
      const bounce = c.h >= p * (1 + E.bouncePct / 100), cont = c.l < p * (1 - E.contPct / 100);
      if (!bounce) e.downMin = Math.min(e.downMin, (c.l - p) / p);
      if (bounce && cont) { e.status = c.c > c.o ? 'döndü' : 'devam'; e.sameBar = 1; }
      else if (bounce) e.status = 'döndü';
      else if (cont) e.status = 'devam';
      else if (el >= E.bounceWindowMin * MIN) e.status = 'yatay';
      if (e.status === 'döndü') e.bounceT = c.t + MIN;
      resolved = e.status != null;
    }
    return resolved;
  }

  /** İlk tam 5dk mum (açılışı ≥ dip anı): teyit mumu */
  function confirm5(e, series) {
    if (e.c5) return;
    const d5 = series.d['5m'], n = d5.t.length;
    if (n < 2 || d5.t[n - 1] < e.t) return;
    let j = n - 1;
    while (j > 0 && d5.t[j - 1] >= e.t) j--;
    const o = d5.o[j], c = d5.c[j], po = d5.o[j - 1], pc = d5.c[j - 1], ph = d5.h[j - 1];
    e.c5 = { T: d5.t[j] + 5 * MIN, close: c, high: -Infinity, green: c > o, engulf: c > o && o <= Math.min(po, pc) && c >= Math.max(po, pc),
      abovePrev: c > ph, closePct: num((c - e.price) / e.price * 100, 3) };
  }

  function rebound(e, series, s) {
    if (!e.rbPending) return;
    e.rbPending = false;
    const vw = { ...vwapSet(series, e.anchorT), aLow: null };
    e.rbSnap = lvFields('rb', nearest(refLevels(series, s, vw), e.rbHigh));
  }

  function newSample(series, s, ctx, x, c, tc, dump, hiT) {
    const sym = series.symbol;
    const e = { id: `${sym}-${tc}`, symbol: sym, t: tc, price: c.l, anchorT: hiT, status: null, bounceT: null, downMin: 0,
      hit: { 1: null, 2: null, 3: null }, sameBar: 0, c5: null, lo: Infinity, hi: -Infinity, last: null, out: {}, rbHigh: -Infinity, rbT: null,
      feat: dipFeatures(series, s, ctx, c.l, dump, hiT, tc, history(sym, x, tc)) };
    Object.assign(e.feat, { cfgDumpPct: E.dumpPct, cfgBouncePct: E.bouncePct, cfgBounceWindowMin: E.bounceWindowMin, cfgSampleGapMin: E.sampleGapMin,
      cfgVer: PKG_VERSION, dipVer: DIP_VER });
    if (E.orderBook) {   // tepe defteriyle aynı: coin başına en fazla 60 sn'de bir; araya giren adaylar son fotoğrafı kullanır
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
    e.feat.contSkipped = x.skipped; x.skipped = 0;
    x.hist.push({ t: e.t, outcome: e.status });
    while (x.hist.length && x.hist[0].t < e.t - 1440 * MIN) x.hist.shift();
    if (E.enrich) {
      const d = series.d['1m'], n = d.q.length;
      let q60 = 0; for (let i = Math.max(0, n - 60); i < n; i++) q60 += d.q[i];
      const merge = r => {
        if (r) for (const [k, v] of Object.entries(r)) if (!(k.startsWith('ob') && e.feat[k] != null)) e.feat[k] = v;
        const sq = e.feat.spotQ60, fq = e.feat.futQ60t;
        if (sq != null && fq != null && sq + fq > 0) e.feat.spotShare60t = num(sq / (sq + fq), 3);
      };
      const r = E.enrich(e.symbol, { t: e.t, price: e.price, futQ60: q60 });
      if (r && typeof r.then === 'function') r.then(merge).catch(() => {}); else merge(r);
    }
  }

  return {
    E,
    /**
     * Kapanmış her 1m mumda (step'ten SONRA) çağrılır.
     * @returns {object[]} en uzun penceresi dolan dip örnekleri (kayda hazır)
     */
    observe(series, s, ctx = {}) {
      const sym = series.symbol;
      const d = series.d['1m'];
      const i = d.t.length - 1;
      if (i < 30) return [];
      const c = { t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i] }, tc = c.t + MIN;
      const x = st(sym);
      const done = [];
      const fin = [];
      for (let k = x.open.length - 1; k >= 0; k--) {
        const e = x.open[k];
        advance(e, c);
        confirm5(e, series);
        rebound(e, series, s);
        if (e.out[WMAX]) { fin.push(e); x.open.splice(k, 1); openN--; }
      }
      fin.sort((a, b) => a.t - b.t);
      for (const e of fin) done.push(finish(e));
      const cd = x.cand;
      if (cd && tc > cd.t) {
        advance(cd, c);
        confirm5(cd, series);
        rebound(cd, series, s);
        if (cd.status) {
          x.cand = null;
          if (cd.status !== 'devam' || cd.t - x.lastCommit >= E.sampleGapMin * MIN) {
            commit(series, x, cd);
            if (cd.out[WMAX]) { done.push(finish(cd)); x.open.pop(); openN--; }
          } else x.skipped++;
        }
      }
      // yeni aday: 60 dk'nın en düşüğü + düşüş (önceki aday daha düşük dibe "devam" ile kapandıysa bu mum yeni aday)
      if (!series.ready() || x.cand) return done;
      let lo60 = Infinity, hi4h = -Infinity, hiT = null;
      for (let j = Math.max(0, i - E.localLowMin + 1); j <= i; j++) if (d.l[j] < lo60) lo60 = d.l[j];
      if (c.l > lo60) return done;
      for (let j = Math.max(0, i - E.dumpLookbackMin + 1); j <= i; j++) if (d.h[j] > hi4h) { hi4h = d.h[j]; hiT = d.t[j]; }
      const dump = hi4h > 0 ? (1 - c.l / hi4h) * 100 : NaN;
      if (!(dump >= E.dumpPct)) return done;
      x.cand = newSample(series, s, ctx, x, c, tc, dump, hiT);
      return done;
    },

    noteCard(sym, t, grade) {
      const a = cards.get(sym) || [];
      a.push({ t, grade });
      while (a.length && a[0].t < t - 1500 * MIN) a.shift();
      cards.set(sym, a);
    },

    /** Son ±winMin dk içinde (dip anı) bu coinde dip adayı oluştu mu — destek teması kaydı için (bellekteki geçmişten) */
    hasDipNear(sym, t, winMin = 5) {
      const x = state.get(sym);
      if (!x) return false;
      const near = e => e && Math.abs(e.t - t) <= winMin * MIN;
      return near(x.cand) || x.open.some(near) || x.hist.some(near);
    },

    sweep(now = Date.now()) {
      for (const [sym, x] of state) {
        for (let k = x.open.length - 1; k >= 0; k--) if (now - x.open[k].t > (WMAX + 15) * MIN) { x.open.splice(k, 1); openN--; }
        if (x.cand && now - x.cand.t > (E.bounceWindowMin + 5) * MIN) x.cand = null;
        while (x.hist.length && x.hist[0].t < now - 1440 * MIN) x.hist.shift();
        if (!x.open.length && !x.cand && !x.hist.length) state.delete(sym);
      }
      for (const [sym, a] of cards) if (!a.length || a[a.length - 1].t < now - 1500 * MIN) cards.delete(sym);
    },
    openCount: () => openN,
  };
}

/** Dip olayı → düz CSV satırı: id, symbol, time, dip, outcome, bounceMin, card, cardGrade, low/high/close × pencereler, DIP_COLS */
function flatDip(r, windows = DIP_DEFAULTS.windows) {
  const o = { id: r.id, symbol: r.symbol, time: Number.isFinite(r.t) ? new Date(r.t).toISOString() : null, dip: r.price,
    outcome: r.outcome ?? r.feat?.outcome ?? null, bounceMin: r.bounceMin ?? null, card: r.card ? 1 : 0, cardGrade: r.cardGrade ?? null };
  for (const w of windows) for (const k of ['low', 'high', 'close']) o[`${k}${w}`] = r.out?.[w]?.[k] ?? null;
  for (const c of DIP_COLS) o[c] = typeof r.feat?.[c] === 'boolean' ? (r.feat[c] ? 1 : 0) : r.feat?.[c] ?? null;
  return o;
}
const dipCols = (windows = DIP_DEFAULTS.windows) => Object.keys(flatDip({ out: {}, feat: {} }, windows));

module.exports = { createDipLedger, DIP_DEFAULTS, DIP_COLS, DIP_VER, flatDip, dipCols, dipFeatures };
