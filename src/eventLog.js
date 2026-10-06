'use strict';

/**
 * Düşüş defteri — "kart çıksın çıkmasın, pompa tepesinden düşüş geldiğinde o an her şey nasıldı?"
 *
 *   Tepe adayı : izlenen coinde 1m mumun tepesi son 60 dk'nın en yükseği VE son 4 saatin dibinden ≥ %pumpPct yukarıda.
 *                O dakikada tüm göstergelerin fotoğrafı (evaluate, şart aranmadan) alınır; daha yüksek tepe gelirse yenilenir.
 *   Düşüş      : tepeden sonraki peakWindowMin (15) dk içinde 1m dip ≤ tepe −%dropPct (1.5) → olay.
 *   Kart       : o coinde tepeden cardBeforeMin (15) dk önce ile düşüşten 5 dk sonrası arasında kart çıktı mı (kartlı / kartsız).
 *   Sonrası    : tepeye göre windows (5/15/60/240) dk'da en düşük / en yüksek / kapanış (%). En uzun pencere dolunca kaydedilir.
 *   Tekrar     : coin başına cooldownMin (60) dk'da bir olay.
 *   Tepede     : 1m/3m/5m/15m/1h/4h göstergeleri (src/marketSnap.js), VWAP seti (günlük/haftalık/aylık ±σ, kayan 90dk/24s/7g,
 *                pompa dibi), fiyatın tepki aldığı seviye (tepenin %0.3 içindeki en yakın seviye: Fib, bölge, 1h/4h/15dk tepe,
 *                VWAP bandı, EMA21 …) ve %0.5 içindeki tüm seviyeler.
 *   Dipte      : tepeden sonraki 60 dk'nın en düşük noktası — kaç % / kaç dk, dibin %0.3 içindeki en yakın destek
 *                (VWAP, EMA21, bölge, Fib …) ve 3/5/15dk EMA21 merdiveninde nereye indiği.
 *
 * Kartı ve tetik kurallarını ETKİLEMEZ — yalnızca kayıt (/data/cards.db → events) ve rapor (/kacan, dışa aktarma).
 * Rapor dili "eşlik eden durum"dur; neden-sonuç iddiası yoktur. Kazanç/kayıp hesabı yoktur.
 */

const { evaluate, separationPct } = require('./infoEngine');
const ta = require('./ta');
const { tfIndicators, vwapSet, vwapFeatures, refLevels, nearest, TF_COLS, VWAP_COLS } = require('./marketSnap');
const { maLadder, stopOf } = require('./levelTouch');

const MIN = 60_000;
const TROUGH_MIN = 60;      // dip: tepeden sonraki 60 dk'nın en düşüğü
const DEFAULTS = {
  pumpPct: 3, pumpLookbackMin: 240, localHighMin: 60,
  peakWindowMin: 15, dropPct: 1.5, cooldownMin: 60, cardBeforeMin: 15, cardAfterMin: 5,
  windows: [5, 15, 60, 240],
};

const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/**
 * Göstergelerin düz (CSV'ye uygun) fotoğrafı. Sütun sırası FEATURE_COLS'ta.
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
const PEAK_COLS = ['pumpPct', 'pumpMin', 'pkLv', 'pkLvKind', 'pkLvDist', 'pkLvTouches', 'pkNear'];
const TROUGH_COLS = ['trPct', 'trMin', 'trLv', 'trLvKind', 'trLvDist', 'trLvTouches', 'trNear', 'trEma', 'trFalling'];
const FEATURE_COLS = [...Object.keys(features({ price: 1 }, { col: () => [] })), ...PEAK_COLS, ...TF_COLS, ...VWAP_COLS, ...TROUGH_COLS];

/** Tepe anının tam fotoğrafı: temel göstergeler + çoklu zaman dilimi + VWAP seti + tepki seviyesi */
function peakFeatures(series, s, ctx, high, pump, loT, tc) {
  const snap = evaluate(series, s, ctx, true);
  const vw = vwapSet(series, loT);
  const nr = nearest(refLevels(series, s, vw), high);
  return features(snap, series, {
    pumpPct: num(pump), pumpMin: Math.round((tc - loT) / MIN),
    pkLv: nr.best?.name ?? null, pkLvKind: nr.best?.kind ?? null, pkLvDist: nr.best?.dist ?? null, pkLvTouches: nr.best?.touches ?? null, pkNear: nr.near.join('|'),
    ...tfIndicators(series, s, snap.price), ...vwapFeatures(vw, snap.price),
  });
}

/** Dip anı: en yakın destek + EMA21 merdiveni */
function troughFeatures(series, s, low, anchorT) {
  const vw = vwapSet(series, anchorT);
  const nr = nearest(refLevels(series, s, vw), low);
  const st = stopOf(low, maLadder(series));
  return { trLv: nr.best?.name ?? null, trLvKind: nr.best?.kind ?? null, trLvDist: nr.best?.dist ?? null, trLvTouches: nr.best?.touches ?? null, trNear: nr.near.join('|'), trEma: st.stop };
}

function createDropLedger(opts = {}) {
  const E = { ...DEFAULTS, ...opts };
  const W = [...E.windows].sort((a, b) => a - b), WMAX = W[W.length - 1];
  const state = new Map();     // sym → { peak, coolUntil, open: [] }
  const cards = new Map();     // sym → [{t, grade}]
  let openN = 0;
  const st = sym => { let x = state.get(sym); if (!x) { x = { peak: null, coolUntil: 0, open: [] }; state.set(sym, x); } return x; };

  function finish(e) {
    const cs = (cards.get(e.symbol) || []).filter(c => c.t >= e.t - E.cardBeforeMin * MIN && c.t <= e.dropT + E.cardAfterMin * MIN);
    const trMin = e.trT != null ? Math.round((e.trT - e.t) / MIN) : null;
    const trough = {
      trPct: e.trLow < Infinity ? num((e.trLow - e.price) / e.price * 100, 3) : null, trMin,
      trLv: null, trLvKind: null, trLvDist: null, trLvTouches: null, trNear: '', trEma: null, ...(e.trSnap || {}), trFalling: trMin != null && trMin >= TROUGH_MIN - 5,
    };
    return {
      id: e.id, symbol: e.symbol, t: e.t, price: e.price, dropT: e.dropT, dropMin: e.dropMin,
      card: cs.length > 0, cardGrade: cs.length ? Math.max(...cs.map(c => c.grade || 0)) : null,
      feat: { ...e.feat, ...trough }, out: e.out,
    };
  }

  function advance(e, c) {          // c: kapanmış 1m mum (t = açılış)
    if (c.t < e.t) return false;      // tepe dakikası ve öncesi
    if (c.t + MIN - e.t <= TROUGH_MIN * MIN && c.l < e.trLow) { e.trLow = c.l; e.trT = c.t + MIN; e.trPending = true; }
    if (c.l < e.lo) e.lo = c.l;
    if (c.h > e.hi) e.hi = c.h;
    e.last = c.c;
    const el = c.t + MIN - e.t;
    for (const w of W) {
      if (e.out[w] || el < w * MIN) continue;
      const p = e.price;
      e.out[w] = { low: num((e.lo - p) / p * 100, 3), high: num((e.hi - p) / p * 100, 3), close: num((e.last - p) / p * 100, 3) };
    }
    return Boolean(e.out[WMAX]);
  }

  return {
    E,
    /**
     * Kapanmış her 1m mumda (canlı / backtest; step'ten SONRA) çağrılır.
     * @returns {object[]} en uzun penceresi dolan olaylar (kayda hazır)
     */
    observe(series, s, ctx = {}) {
      const sym = series.symbol;
      const d = series.d['1m'];
      const i = d.t.length - 1;
      if (i < 30) return [];
      const c = { t: d.t[i], h: d.h[i], l: d.l[i], c: d.c[i] }, tc = c.t + MIN;
      const x = st(sym);
      const done = [];
      // 1) açık olaylar (yeni dip geldiyse o anki destek fotoğrafı)
      for (let k = x.open.length - 1; k >= 0; k--) {
        const e = x.open[k];
        const full = advance(e, c);
        if (e.trPending) { e.trSnap = troughFeatures(series, s, e.trLow, e.anchorT); e.trPending = false; }
        if (full) { done.push(finish(e)); x.open.splice(k, 1); openN--; }
      }
      // 2) düşüş
      const pk = x.peak;
      if (pk && tc > pk.t) {
        if (tc - pk.t > E.peakWindowMin * MIN) x.peak = null;
        else if (c.l <= pk.high * (1 - E.dropPct / 100)) {
          const e = { id: `${sym}-${pk.t}`, symbol: sym, t: pk.t, price: pk.high, dropT: tc, dropMin: Math.round((tc - pk.t) / MIN),
            feat: pk.feat, anchorT: pk.anchorT, lo: Infinity, hi: -Infinity, last: null, out: {}, trLow: Infinity, trT: null };
          for (let j = 0; j <= i; j++) if (d.t[j] >= pk.t && advance(e, { t: d.t[j], h: d.h[j], l: d.l[j], c: d.c[j] })) break;
          if (e.trPending) { e.trSnap = troughFeatures(series, s, e.trLow, e.anchorT); e.trPending = false; }
          if (e.out[WMAX]) done.push(finish(e)); else { x.open.push(e); openN++; }
          x.coolUntil = pk.t + E.cooldownMin * MIN;
          x.peak = null;
        }
      }
      // 3) yeni tepe adayı (bekleme süresinde aranmaz)
      if (tc < x.coolUntil || !series.ready()) return done;
      if (x.peak && c.h <= x.peak.high) return done;
      let hi60 = -Infinity, lo4h = Infinity, loT = null;
      for (let j = Math.max(0, i - E.localHighMin + 1); j <= i; j++) if (d.h[j] > hi60) hi60 = d.h[j];
      if (c.h < hi60) return done;
      for (let j = Math.max(0, i - E.pumpLookbackMin + 1); j <= i; j++) if (d.l[j] < lo4h) { lo4h = d.l[j]; loT = d.t[j]; }
      const pump = (c.h / lo4h - 1) * 100;
      if (!(pump >= E.pumpPct)) return done;
      x.peak = { t: tc, high: c.h, anchorT: loT, feat: peakFeatures(series, s, ctx, c.h, pump, loT, tc) };
      return done;
    },

    noteCard(sym, t, grade) {
      const a = cards.get(sym) || [];
      a.push({ t, grade });
      while (a.length && a[0].t < t - (WMAX + E.cardBeforeMin + 30) * MIN) a.shift();
      cards.set(sym, a);
    },

    /** Mum gelmeyen coinlerin süresi dolan olaylarını (kaydetmeden) bırakır */
    sweep(now = Date.now()) {
      for (const [sym, x] of state) {
        for (let k = x.open.length - 1; k >= 0; k--) if (now - x.open[k].t > (WMAX + 15) * MIN) { x.open.splice(k, 1); openN--; }
        if (x.peak && now - x.peak.t > (E.peakWindowMin + 5) * MIN) x.peak = null;
        if (!x.open.length && !x.peak && x.coolUntil < now) state.delete(sym);
      }
      for (const [sym, a] of cards) if (!a.length || a[a.length - 1].t < now - (WMAX + 60) * MIN) cards.delete(sym);
    },
    openCount: () => openN,
  };
}

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
function dropText(rows, { title = '', s = {}, E = DEFAULTS } = {}) {
  const head = `📉 <b>Düşüş defteri</b>${title ? `\n🗓 ${title}` : ''}
<i>Pompa tepesi → ${E.peakWindowMin} dk'da ≥ %${E.dropPct} düşüş</i>`;
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
• Coin başına ${E.cooldownMin} dk'da bir olay · kazanç/kayıp değildir, "eşlik eden durum"dur</blockquote>`,
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
  const o = { id: r.id, symbol: r.symbol, time: Number.isFinite(r.t) ? new Date(r.t).toISOString() : null, peak: r.price, dropMin: r.dropMin, card: r.card ? 1 : 0, cardGrade: r.cardGrade };
  for (const w of windows) for (const k of ['low', 'high', 'close']) o[`${k}${w}`] = r.out?.[w]?.[k] ?? null;
  for (const c of FEATURE_COLS) o[c] = typeof r.feat?.[c] === 'boolean' ? (r.feat[c] ? 1 : 0) : r.feat?.[c] ?? null;
  return o;
}
const dropCols = (windows = DEFAULTS.windows) => Object.keys(flatDrop({ out: {}, feat: {} }, windows));

module.exports = { createDropLedger, features, peakFeatures, FEATURE_COLS, TROUGH_COLS, DEFAULTS, dropText, toCsv, flatDrop, dropCols };
