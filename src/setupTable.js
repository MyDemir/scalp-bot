'use strict';
/**
 * Haftalık rapor "Kurulum tablosu": tepe adayları pompa başına ilk eşleşen aday olarak gruplara göre ölçülür.
 * Yalnız ölçümdür (kural önerisi değil); kazanç/kayıp hesaplanmaz, "eşlik eden durum"dur.
 *
 * Giriş: tepe defteri satırı r = { symbol, t, price (tepe = 1dk high), feat (price = 1dk kapanış, rsi1h, rsi15, sep3, sep5,
 * pumpPct, volx_3m), out ({15:{low}, 60:{close}} — tepeye göre %) }.
 * Bellek: aday başına yalnız sembol indeksi, t, grup maskesi, iki ölçü (≈ 21 bayt, tipli dizi); satır tutulmaz.
 */
const MIN = 60_000;
const GAP_MS = 60 * MIN;             // aynı sembolde ardışık adaylar arası boşluk < 60 dk → aynı pompa
const VOLX_MIN = 10;                 // 3dk hacim kat eşiği (sabit)
const PUMP_MIN = 5;                  // pompa % eşiği (sabit)
const MIN_N = 20;
const DROP15 = -1.5;                 // 15 dk içinde kapanıştan en az bu kadar (%) aşağı

const GROUPS = [
  'Tüm pompalar',
  'Pompa ≥ %5',
  'EMA21 ayrışma',
  '1s RSI bandı',
  '15dk RSI',
  'Bu 3 şarttan ≥ 2',
  '3dk hacim ≥ 10 kat',
];

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** tepeye göre % → kapanıştan (giriş) % */
const fromEntry = (peak, price, x) => (peak > 0 && price > 0 && x != null ? (peak * (1 + x / 100) / price - 1) * 100 : null);

/** Eşikler ayardan, yoksa varsayılan; config.js'e anahtar eklenmez */
function thresholds(s = {}) {
  return { sep: s.sepPct2 ?? 2, r1h: s.gradeRsi1h ?? 80, r1hMax: s.gradeRsi1hMax ?? 88, r15: s.gradeRsi15m ?? 85 };
}

/** Grup maskesi (bit i = GROUPS[i]) */
function maskOf(feat, th) {
  const f = feat || {};
  const pump = num(f.pumpPct) != null && f.pumpPct >= PUMP_MIN;
  const sep = num(f.sep3) != null && num(f.sep5) != null && f.sep3 >= th.sep && f.sep5 >= th.sep;
  const r1h = num(f.rsi1h) != null && f.rsi1h >= th.r1h && (!(th.r1hMax > 0) || f.rsi1h < th.r1hMax);
  const r15 = num(f.rsi15) != null && f.rsi15 >= th.r15;
  const vol = num(f.volx_3m) != null && f.volx_3m >= VOLX_MIN;
  const bits = [true, pump, sep, r1h, r15, (sep ? 1 : 0) + (r1h ? 1 : 0) + (r15 ? 1 : 0) >= 2, vol];
  return bits.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
}

function createSetupAcc({ s = {} } = {}) {
  const th = thresholds(s);
  const syms = new Map();           // sembol → indeks
  let n = 0, cap = 1024;
  let sy = new Uint32Array(cap), tt = new Float64Array(cap), mk = new Uint8Array(cap), l15 = new Float32Array(cap), c60 = new Float32Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (A, T) => { const B = new T(cap); B.set(A); return B; };
    sy = g(sy, Uint32Array); tt = g(tt, Float64Array); mk = g(mk, Uint8Array); l15 = g(l15, Float32Array); c60 = g(c60, Float32Array);
  };

  /** @param {object} r tepe defteri satırı (yukarıdaki biçim) */
  function add(r) {
    if (!r || !Number.isFinite(r.t) || !r.symbol) return;
    if (n >= cap) grow();
    let i = syms.get(r.symbol);
    if (i === undefined) { i = syms.size; syms.set(r.symbol, i); }
    const price = num(r.feat?.price), peak = num(r.price);
    sy[n] = i; tt[n] = r.t; mk[n] = maskOf(r.feat, th);
    const lo = fromEntry(peak, price, num(r.out?.[15]?.low)), cl = fromEntry(peak, price, num(r.out?.[60]?.close));
    l15[n] = lo ?? NaN; c60[n] = cl ?? NaN;
    n++;
  }

  /** Ölçümler: { rows:[{name, n, below60, med60, drop15, h1, h2, n1, n2, small}], missing[], pumps, from, to, candidates } */
  function stats() {
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => sy[a] - sy[b] || tt[a] - tt[b]);
    let tMin = Infinity, tMax = -Infinity;
    for (let k = 0; k < n; k++) { if (tt[k] < tMin) tMin = tt[k]; if (tt[k] > tMax) tMax = tt[k]; }
    const mid = (tMin + tMax) / 2;
    const acc = GROUPS.map(() => ({ v60: [], neg: 0, d15: 0, n15: 0, h: [[0, 0], [0, 0]] }));
    const missing = GROUPS.map(() => 0);
    let pumps = 0;
    for (let a = 0; a < order.length;) {
      let b = a + 1;
      while (b < order.length && sy[order[b]] === sy[order[a]] && tt[order[b]] - tt[order[b - 1]] < GAP_MS) b++;
      pumps++;
      for (let g = 0; g < GROUPS.length; g++) {
        let first = -1;
        for (let q = a; q < b; q++) if (mk[order[q]] & (1 << g)) { first = order[q]; break; }
        if (first < 0) continue;
        const cl = c60[first];
        if (Number.isNaN(cl)) { missing[g]++; continue; }
        const A = acc[g], half = tt[first] < mid ? 0 : 1, down = cl < 0;
        A.v60.push(cl); if (down) A.neg++;
        A.h[half][0]++; if (down) A.h[half][1]++;
        if (!Number.isNaN(l15[first])) { A.n15++; if (l15[first] <= DROP15) A.d15++; }
      }
      a = b;
    }
    const pct = (x, y) => (y ? (x / y) * 100 : null);
    const median = v => { if (!v.length) return null; const w = Float64Array.from(v).sort(); const m = w.length >> 1; return w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2; };
    const rows = GROUPS.map((name, g) => {
      const A = acc[g], cnt = A.v60.length;
      return { name, n: cnt, below60: pct(A.neg, cnt), med60: median(A.v60), drop15: pct(A.d15, A.n15), h1: pct(A.h[0][1], A.h[0][0]), h2: pct(A.h[1][1], A.h[1][0]), n1: A.h[0][0], n2: A.h[1][0], small: cnt < MIN_N };
    });
    return { rows, missing, pumps, from: tMin, to: tMax, candidates: n };
  }

  /** Markdown bölüm gövdesi (başlık weeklyReport'ta) */
  function text() {
    const st = stats();
    const p = v => (v == null ? '—' : `%${v.toFixed(0)}`);
    const sp = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(2).replace('.', ',')}`);
    const L = [
      'Nasıl okunur: her pompada (aynı sembolde adaylar arası < 60 dk) gruba uyan İLK aday alınır; değerler 1dk kapanıştan (giriş) ölçülür, kazanç/kayıp değil eşlik eden durumdur.',
      '',
      '| Grup | n pompa | 60 dk sonra aşağıda | Medyan 60 dk | 15 dk içinde −%1,5 | 1. yarı aşağıda (n) | 2. yarı aşağıda (n) |',
      '|---|---:|---:|---:|---:|---:|---:|',
    ];
    for (const r of st.rows) {
      L.push(`| ${r.name}${r.small ? ' (az örnek)' : ''} | ${r.n} | ${p(r.below60)} | ${sp(r.med60)} | ${p(r.drop15)} | ${p(r.h1)} (${r.n1}) | ${p(r.h2)} (${r.n2}) |`);
    }
    const mis = st.rows.map((r, g) => (st.missing[g] > 0 ? `${r.name} ${st.missing[g]}` : null)).filter(Boolean);
    L.push('', `${st.pumps} pompa · ${st.candidates} aday · eşikler: EMA21 ayrışma ≥ %${th.sep} (3dk ve 5dk), 1s RSI ${th.r1h}${th.r1hMax > 0 ? `–${th.r1hMax}` : '+'}, 15dk RSI ≥ ${th.r15}, pompa ≥ %${PUMP_MIN}, 3dk hacim ≥ ${VOLX_MIN} kat. n < ${MIN_N} satırlar "(az örnek)". Yarı bölmesi kapsamın zaman orta noktasından.`,
      mis.length ? `Eksik takip (60 dk sonucu yok, ölçüye girmedi): ${mis.join(' · ')}.` : 'Eksik takip (60 dk sonucu yok): yok.');
    return L.join('\n');
  }

  return { add, text, stats };
}

module.exports = { createSetupAcc, GROUPS, maskOf, thresholds, GAP_MS, VOLX_MIN };
