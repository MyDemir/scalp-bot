'use strict';

/**
 * Bilgi botu motoru — canlı bot ve backtest AYNI fonksiyonları kullanır.
 *
 *   Kontrol anı : her kapanan 1m mumda Series.apply1m() çağrılır; değerlendirme yalnızca
 *                 (a) 3m / 5m / 15m mumlarından biri kapandıysa ya da (b) bu 1m mum hacimli bir
 *                 patlamaysa yapılır. Kapanmamış dilimlerin RSI'ı devam eden mumla hesaplanır (canlı, "~").
 *   Şart        : 3m/5m/15m'den en az minTFs tanesinde RSI ≥ rsiMin
 *   Derece      : kurulum kontrol listesi skoru (8 madde) — 🔴 < grade2Min · 🔴🔴 ≥ grade2Min · 🔴🔴🔴 ≥ grade3Min
 *                 + (levelRequired) fiyatın üstünde en fazla %levelMaxPct uzakta bir seviye
 *                 + isteğe bağlı: ayrışma / destek / MACD şartları
 *   Yeni kart   : şart sağlanıyor VE önceki karttan bu yana yeni veri var (patlama, RSI dilim sayısı,
 *                 güçlü RSI, seviye/bölge, MACD ya da Stoch RSI kesişimi). Yeni veri yoksa kart yok.
 *   Negatif tepe: 1m/3m'de fiyat ≥ önceki tepe, RSI < önceki tepe (ardışık sayı) — artış yeni veri sayılır.
 *   Seri içi    : (seriesBursts) seri sürerken gelen hacimli mum ŞART ARANMADAN kart olur (#SERI).
 *   Numara      : aynı coinde kartlar #1, #2 … diye artar; kapanmış 5m RSI < resetRsi olunca sıfırlanır.
 *
 * Bu modülün yan etkisi yok (ağ/Telegram açmaz).
 */

const ta = require('./ta');
const { calcLevelSet, calcExtraLevels, fibExtensions } = require('./levels');

const RSI_TFS = ['3m', '5m', '15m'];
const DAY = 86_400_000;
const MIN = 60_000;

// ── Hacim patlamaları ──────────────────────────────────────────────────────

/** 1m tamponunun i. mumu patlama mı? */
function burstAt(d, i, s) {
  const n = s.volAvgN;
  if (i < n) return null;
  const o = d.o[i], c = d.c[i], v = d.v[i];
  if (!(o > 0) || !(v > 0)) return null;
  const body = (c - o) / o * 100;
  if (Math.abs(body) < s.burstPct1) return null;
  let sum = 0;
  for (let j = i - n; j < i; j++) sum += d.v[j];
  const avg = sum / n;
  if (!(avg > 0) || v < avg * s.volMult) return null;
  const taker = d.tb[i] / v * 100;
  return {
    t: d.t[i], body, volX: v / avg, taker,
    dir: taker > s.takerBuyPct ? 'buy' : taker < s.takerSellPct ? 'sell' : 'neutral',
    tier: Math.abs(body) >= s.burstPct2 ? 2 : 1,
    v, tb: d.tb[i],
  };
}

/** Son kapanan 1m mum patlama mı? */
function detectBurst(series, s) {
  const d = series.d['1m'];
  return burstAt(d, d.t.length - 1, s);
}

/**
 * Pencerelerdeki patlama sayaçları. Art arda gelen patlama mumları TEK patlama sayılır
 * (yön: bloğun toplam taker oranı, kademe: bloktaki en büyük gövde).
 * @returns {{[win:number]: {p1:{buy,sell,neutral}, p2:{buy,sell,neutral}}}}
 */
function burstCounts(series, s, windows) {
  const d = series.d['1m'];
  const n = d.t.length;
  if (!n) return {};
  const nowEnd = d.t[n - 1] + MIN;
  const maxWin = Math.max(...windows);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (d.t[i] + MIN <= nowEnd - maxWin * MIN) continue;
    const b = burstAt(d, i, s);
    if (!b) { cur = null; continue; }
    if (cur && cur.end === b.t - MIN) {
      cur.end = b.t; cur.v += b.v; cur.tb += b.tb;
      if (Math.abs(b.body) > cur.maxBody) cur.maxBody = Math.abs(b.body);
    } else {
      cur = { start: b.t, end: b.t, v: b.v, tb: b.tb, maxBody: Math.abs(b.body) };
      blocks.push(cur);
    }
  }
  const out = {};
  for (const w of windows) {
    const from = nowEnd - w * MIN;
    const z = () => ({ buy: 0, sell: 0, neutral: 0 });
    const r = { p1: z(), p2: z() };
    for (const bl of blocks) {
      if (bl.end + MIN <= from) continue;
      const tk = bl.tb / bl.v * 100;
      const dir = tk > s.takerBuyPct ? 'buy' : tk < s.takerSellPct ? 'sell' : 'neutral';
      r.p1[dir]++;
      if (bl.maxBody >= s.burstPct2) r.p2[dir]++;
    }
    out[w] = r;
  }
  return out;
}

/** Taker net akış (USDT): Σ(taker alış − taker satış) son w dakika */
function takerNet(series, w) {
  const d = series.d['1m'];
  const n = d.t.length;
  let net = 0;
  for (let i = Math.max(0, n - w); i < n; i++) net += 2 * d.tq[i] - d.q[i];
  return net;
}

// ── Göstergeler ────────────────────────────────────────────────────────────

function rsiOf(series, tf, period = 14) {
  const live = !series.isClosedNow(tf);
  return { v: ta.rsiLast(series.col(tf, 'c', true), period), live };
}

/**
 * Hacim derecesi (hacimli mum ve ⚡ hareket için ortak):
 *   1 = temel şart · 2 = + hacim ≥ volGrade2X × ortalama · 3 = + alış/satış oranı hareket yönünde ≥ dirGrade3Pct
 * @param {number} move   hareket/gövde yüzdesi (işaret yönü verir)
 * @param {number|null} volX  hacim / ortalama
 * @param {number|null} taker taker alış oranı (%)
 */
function volGrade(move, volX, taker, s) {
  if (!(volX >= s.volGrade2X)) return 1;
  const agree = taker == null ? 0 : move >= 0 ? taker : 100 - taker;
  return agree >= s.dirGrade3Pct ? 3 : 2;
}

const DAILY_LEVELS = ['1d MA200', '1d EMA200', '30 günlük tepe', '30 günlük en yüksek', '7 günlük en yüksek', 'Günlük bölge'];

/**
 * Kurulum kontrol listesi (8 madde, yalnızca bilgi — kart göndermeyi engellemez):
 *   1 günlük dirence yakın (1d MA200 / 1d EMA200 / 30 günlük tepe, üstte ≤ %levelMaxPct)
 *   2 çakışan direnç (başka bir seviye %confluencePct içinde)
 *   3 3m ya da 5m RSI strongRsi–rsiEntryMax aralığında (95–98)
 *   4 15m RSI ≥ strongRsi (95)
 *   5 5m ve 15m birlikte ≥ strongRsi
 *   6 1h ve 4h RSI ≥ confRsi (şişkin)
 *   7 3m ve 5m EMA21'den ayrışmış (≥ sepATR ATR, son 3 mumda dokunmamış)
 *   8 1m ya da 3m'de ≥ 2 negatif tepe
 * Ayrıca uyarı: 3m/5m RSI ≥ 95 ama EMA21'e yakın.
 */
function checklist(snap, s) {
  const r = snap.rsi;
  const f1 = v => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
  const levels = snap.levels || [];

  let daily = null;
  for (const L of levels) {
    if (!DAILY_LEVELS.includes(L.name) && L.name !== 'Haftalık bölge') continue;
    if (L.dist > s.dipAbovePct || L.dist < -s.levelMaxPct) continue;
    if (!daily || Math.abs(L.dist) < Math.abs(daily.dist)) daily = L;
  }
  const kala = d => (d <= 0 ? `%\( {Math.abs(d).toFixed(2)} kala` : `% \){d.toFixed(2)} üstünde`);

  const ref = daily || snap.level;
  let conf = null;
  if (ref) {
    for (const L of levels) {
      if (L.name === ref.name || L.kind === 'fib' || L.name === '1h tepe') continue;
      const gapPct = Math.abs(L.value - ref.value) / ref.value * 100;
      if (gapPct <= s.confluencePct && (!conf || gapPct < conf.gapPct)) conf = { ...L, gapPct };
    }
  }

  const inBand = v => v >= s.strongRsi && v <= s.rsiEntryMax;
  const band = ['3m', '5m'].filter(tf => inBand(r[tf].v));
  const over = ['3m', '5m'].filter(tf => r[tf].v > s.rsiEntryMax);

  // EMA21 yüzde ayrışma (3m/5m max) — kademeli puan
  const sepPct = Math.max(
    Math.abs(snap.sepPct?.['3m'] ?? 0),
    Math.abs(snap.sepPct?.['5m'] ?? 0)
  );
  let sepPts = 0;
  let sepTxt = 'yok';
  if (sepPct >= (s.sepPct10 ?? 10)) { sepPts = 3; sepTxt = `≥%\( {s.sepPct10 ?? 10} ( \){sepPct.toFixed(1)}%)`; }
  else if (sepPct >= (s.sepPct5 ?? 5)) { sepPts = 2; sepTxt = `≥%\( {s.sepPct5 ?? 5} ( \){sepPct.toFixed(1)}%)`; }
  else if (sepPct >= (s.sepPct2 ?? 2)) { sepPts = 1; sepTxt = `≥%\( {s.sepPct2 ?? 2} ( \){sepPct.toFixed(1)}%)`; }

  const n1 = snap.neg?.['1m']?.count ?? 0, n3 = snap.neg?.['3m']?.count ?? 0;
  const h1 = snap.conf?.h1, h4 = snap.conf?.h4;

  const macdDown = ['3m', '5m'].some(tf => snap.macd?.[tf]?.cross === 'down');

  const items = [
    { key: 'daily', ok: Boolean(daily), pts: 1, text: daily ? `Günlük/haftalık direnç \( {kala(daily.dist)} ( \){daily.name})` : `Günlük direnç %${s.levelMaxPct} içinde yok` },
    { key: 'confluence', ok: Boolean(conf), pts: 1, text: conf ? `Çakışan direnç: ${ref.name} + ${conf.name}` : 'Çakışan direnç yok' },
    { key: 'band', ok: band.length > 0, pts: 1, text: band.length ? `3m/5m RSI \( {s.strongRsi}– \){s.rsiEntryMax} (\( {band.map(tf => ` \){tf} ${f1(r[tf].v)}`).join(' · ')})` : over.length ? `3m/5m RSI ${s.rsiEntryMax} üstü — aşırı` : `3m/5m RSI \( {s.strongRsi}– \){s.rsiEntryMax} değil` },
    { key: 'rsi15', ok: r['15m'].v >= s.strongRsi, pts: 1, text: `15m RSI ≥ \( {s.strongRsi} ( \){f1(r['15m'].v)})` },
    { key: 'rsi5_15', ok: r['5m'].v >= s.strongRsi && r['15m'].v >= s.strongRsi, pts: 1, text: `5m + 15m ≥ ${s.strongRsi}` },
    { key: 'htf', ok: h1 >= s.confRsi && h4 >= s.confRsi, pts: 1, text: `1h/4h RSI ≥ \( {s.confRsi} ( \){f1(h1)} · ${f1(h4)})` },
    { key: 'sep', ok: sepPts > 0, pts: sepPts, text: `EMA21 % ayrışma ${sepTxt}` },
    { key: 'neg', ok: Math.max(n1, n3) >= 2, pts: 1, text: `Negatif tepe ≥ 2 (1m ${n1} · 3m ${n3})` },
    { key: 'macd', ok: macdDown, pts: 1, text: macdDown ? 'MACD 3m/5m sat kesişimi' : 'MACD sat kesişimi yok' },
  ];

  const score = items.reduce((sum, x) => sum + (x.ok ? x.pts : 0), 0);
  const warn = ['3m', '5m'].some(tf => r[tf].v >= s.strongRsi) && sepPts === 0
    ? `⚠️ RSI ${s.strongRsi} üstü ama EMA21 yakın`
    : null;

  return { items, score, total: items.length, warn, daily, confluence: conf };
}

/**
 * Kart derecesi — kontrol listesi skoruna göre (kart şartı sağlanmışsa):
 *   🔴 skor < grade2Min · 🔴🔴 skor ≥ grade2Min · 🔴🔴🔴 skor ≥ grade3Min (sesli)
 */
function rsiGrade(snap, s) {
  if (!(snap.hits >= s.minTFs)) return 0;
  const sc = snap.check ? snap.check.score : 0;
  if (sc >= (s.grade4Min ?? 7)) return 4;
  if (sc >= (s.grade3Min ?? 5)) return 3;
  if (sc >= (s.grade2Min ?? 3)) return 2;
  return 1;
}

/**
 * Derece daireleri. Renk yönü gösterir: 'red' = düşüş/satış ya da aşırı alım (short tarafı),
 * 'green' = yükseliş/alış, 'white' = nötr. 0 derece → ⚪ (şart dışı).
 */
const DOT = { red: '🔴', green: '🟢', white: '⚪' };
const circles = (n, color = 'red') => (n > 0 ? (DOT[color] || DOT.red).repeat(n) : '⚪');
/** Hacimli mum / hareket yönüne göre renk */
const dirColor = (dirOrMove) => (dirOrMove === 'buy' || (typeof dirOrMove === 'number' && dirOrMove > 0) ? 'green'
  : dirOrMove === 'sell' || (typeof dirOrMove === 'number' && dirOrMove < 0) ? 'red' : 'white');

/** EMA21'e yüzde mesafe (pozitif = EMA üstünde) */
function separationPct(series, tf, price) {
  const c = series.col(tf, 'c');
  const e = ta.emaSeries(c, 21);
  if (!e.length || !(price > 0)) return null;
  const ema = e[e.length - 1];
  return ((price - ema) / ema) * 100;
}

/**
 * EMA21 takip / kopuş (yalnızca Detay'da gösterilir). Kapanmış 3m mumlar:
 *   değme  : mumun aralığı EMA21'i (±%0.1) içeriyor
 *   izliyor: son 10 mumun ≥ 6'sında değdi (fiyat EMA21'i trend gibi takip ediyor)
 *   koptu  : son 3 mumdan önceki 10 mumun ≥ 6'sında değmişti, son 3 mumda değmedi ve fiyat ≥ 1.5 ATR yukarıda
 */
const RIDE = { win: 10, min: 6, breakATR: 1.5 };
function emaRide(series, tf = '3m') {
  const c = series.col(tf, 'c', false), h = series.col(tf, 'h', false), l = series.col(tf, 'l', false);
  const e = ta.emaSeries(c, 21), a = ta.atrSeries(h, l, c, 14);
  const n = c.length;
  if (e.length < RIDE.win + 3 || !a.length) return null;
  const off = n - e.length;                                // e[j] ↔ c[j + off]
  const touch = i => { const ev = e[i - off]; return l[i] <= ev * 1.001 && h[i] >= ev * 0.999; };
  const count = (from, to) => { let k = 0; for (let i = from; i < to; i++) if (touch(i)) k++; return k; };
  const recent = count(n - RIDE.win, n), before = count(n - RIDE.win - 3, n - 3), last3 = count(n - 3, n);
  const atr = a[a.length - 1], dist = atr > 0 ? (c[n - 1] - e[e.length - 1]) / atr : 0;
  const state = before >= RIDE.min && last3 === 0 && dist >= RIDE.breakATR ? 'break'
    : recent >= RIDE.min ? 'ride' : 'free';
  return { tf, state, recent, before, last3, dist, win: RIDE.win };
}

// ── Short'a karşı sinyaller (yalnızca Detay'da; dereceyi etkilemez) ─────────

/**
 * Gizli pozitif uyumsuzluk (gizli PU): son iki dip — fiyat daha YÜKSEK dip, RSI daha DÜŞÜK dip → yükseliş devam eğilimi.
 *   Dip: low[i] solundaki `bars` mumdan düşük, sağındaki `bars` mumdan düşük-eşit (kapanmış mumlar).
 *   İkinci dip son `fresh` mum içinde olmalı (güncel). RSI farkı en az 1 puan.
 * @param {number[]} lows  @param {number[]} rsi  lows ile hizalı (tanımsız başı NaN)
 */
function findHiddenPU(lows, rsi, { bars = 3, lookback = 60, fresh = 10 } = {}) {
  const n = lows.length;
  const piv = [];
  for (let i = Math.max(bars, n - lookback); i < n - bars; i++) {
    if (!Number.isFinite(rsi[i])) continue;
    let ok = true;
    for (let k = 1; k <= bars && ok; k++) if (!(lows[i] < lows[i - k]) || !(lows[i] <= lows[i + k])) ok = false;
    if (ok) piv.push({ i, low: lows[i], rsi: rsi[i] });
  }
  if (piv.length < 2) return null;
  const a = piv[piv.length - 2], b = piv[piv.length - 1];
  if (n - 1 - b.i > fresh) return null;
  return b.low > a.low && b.rsi < a.rsi - 1 ? { low1: a.low, rsi1: a.rsi, low2: b.low, rsi2: b.rsi, ago: n - 1 - b.i } : null;
}
function hiddenPU(series, tf, period) {
  const l = series.col(tf, 'l', false), c = series.col(tf, 'c', false);
  if (c.length < 40) return null;
  const r = ta.rsiSeries(c, period);
  const al = new Array(c.length - r.length).fill(NaN).concat(r);
  const res = findHiddenPU(l, al);
  return res ? { tf, ...res } : null;
}

/**
 * Günlük golden cross (SMA50 / SMA200, kapanmış günlük mumlar):
 *   'crossed' — son 10 günde SMA50, SMA200'ü aşağıdan yukarı kesti
 *   'near'    — SMA50 hâlâ altında ama fark ≤ %2 ve 5 gün öncesine göre daralıyor
 */
function findGoldenCross(closes) {
  const n = closes.length;
  if (n < 211) return null;
  const sma = (end, p) => { let t = 0; for (let i = end - p + 1; i <= end; i++) t += closes[i]; return t / p; };
  const at = k => { const e = n - 1 - k, a = sma(e, 50), b = sma(e, 200); return { a, b, gap: (b - a) / b * 100 }; };
  const now = at(0);
  for (let k = 0; k < 10; k++) {
    const x = at(k), y = at(k + 1);
    if (x.a >= x.b && y.a < y.b) return { state: 'crossed', ago: k, gap: now.gap };
  }
  const prev = at(5);
  if (now.a < now.b && now.gap <= 2 && now.gap < prev.gap) return { state: 'near', gap: now.gap, prevGap: prev.gap };
  return null;
}

function macdState(series, tf) {
  const c = series.col(tf, 'c', false);                 // yalnızca kapanmış mumlar (kararlı)
  const m = ta.macdTail(c, 12, 26, 9, 6);
  if (m.length < 3) return null;
  const h = m.map(x => x.hist);
  const h0 = h[h.length - 1], h1 = h[h.length - 2];
  let falling = 0;
  for (let i = h.length - 1; i > 0 && h[i] < h[i - 1]; i--) falling++;
  let rising = 0;
  for (let i = h.length - 1; i > 0 && h[i] > h[i - 1]; i--) rising++;
  const cross = h1 > 0 && h0 <= 0 ? 'down' : h1 < 0 && h0 >= 0 ? 'up' : null;
  let text;
  if (cross === 'down') text = '↓ kesişim';
  else if (cross === 'up') text = '↑ kesişim';
  else if (h0 > 0) text = falling >= 2 ? `histogram daralıyor (${falling} mum)` : rising >= 1 ? 'pozitif, güçleniyor' : 'pozitif';
  else text = falling >= 1 ? 'negatif, derinleşiyor' : 'negatif, toparlanıyor';
  return {
    hist: h0, cross, falling, text,
    weakening: h0 <= 0 || h0 < h1,
    crossKey: cross ? `${tf}:${cross}:${series.lastT(tf)}` : null,
  };
}

function stochState(series, tf) {
  const c = series.col(tf, 'c', false);
  const s = ta.stochRsiTail(c, 14, 14, 3, 3, 2);
  if (s.length < 2) return null;
  const [p, q] = s;
  const cross = p.k > p.d && q.k <= q.d && Math.max(p.k, p.d) >= 80 ? 'down'
    : p.k < p.d && q.k >= q.d && Math.min(p.k, p.d) <= 20 ? 'up' : null;
  return { k: q.k, d: q.d, cross, crossKey: cross ? `${tf}:${cross}:${series.lastT(tf)}` : null };
}

/**
 * Negatif tepe (düşüş uyumsuzluğu) — fiyat eşit ya da daha yüksek tepe yaparken RSI daha düşük tepe.
 *   Tepe (pivot): high[i] > high[i-1] ve high[i] ≥ high[i+1] (sağında 1 kapanmış mumla teyitli).
 *   Son `lookback` kapanmış mumdaki tepeler sırayla karşılaştırılır; ardışık negatif tepe sayısı
 *   son tepede biten seridir (arada RSI'ı yükselen ya da fiyatı alçalan tepe gelirse sıfırlanır).
 *   Son tepe 6 mumdan eskiyse sayı 0 (bayat uyumsuzluk gösterilmez).
 * @returns {{count:number, key:string|null, lastAgo:number|null}|null}
 */
function negPeaks(series, tf, lookback = 40, period = 14) {
  const h = series.col(tf, 'h', false), c = series.col(tf, 'c', false), t = series.col(tf, 't', false);
  const n = c.length;
  if (n < 30) return null;
  const r = ta.rsiSeries(c, period);
  const off = n - r.length;                               // r[j] ↔ c[j + off]
  const piv = [];
  for (let i = Math.max(off + 1, n - lookback); i < n - 1; i++) {
    if (h[i] > h[i - 1] && h[i] >= h[i + 1]) piv.push({ i, h: h[i], r: r[i - off] });
  }
  let cnt = 0;
  for (let k = 1; k < piv.length; k++) {
    const a = piv[k - 1], b = piv[k];
    if (b.h >= a.h * 0.999 && b.r < a.r - 0.5) cnt++;
    else cnt = 0;
  }
  const last = piv[piv.length - 1];
  const lastAgo = last ? n - 1 - last.i : null;
  const fresh = last && lastAgo <= 6;
  return { count: fresh ? cnt : 0, key: last ? `${tf}:${t[last.i]}` : null, lastAgo };
}

/**
 * Hacim ve alış–satış (USDT) — 15 dk / 1 saat / 4 saat / 24 saat. Bellekteki mumlardan, ek istek yok.
 *   hacim  : pencerenin USDT hacmi · kat: o uzunluktaki pencerelerin normaline oranı
 *            (15 dk ve 1 saat → son 24 saatin ortalaması · 4 saat ve 24 saat → son 7 günün ortalaması)
 *   alış % : taker alış hacmi / hacim · net: alış − satış (USDT)
 */
function volStats(series) {
  const last = (tf, n, incl) => {
    const q = series.col(tf, 'q', incl), tq = series.col(tf, 'tq', incl);
    let a = 0, b = 0;
    for (let i = Math.max(0, q.length - n); i < q.length; i++) { a += q[i]; b += tq[i]; }
    return { q: a, tq: b };
  };
  const avgOf = (tf, n) => {
    const q = series.col(tf, 'q', false);
    const k = Math.min(n, q.length);
    if (k < 3) return null;
    let a = 0;
    for (let i = q.length - k; i < q.length; i++) a += q[i];
    return a / k;
  };
  const rows = [
    ['15 dk', last('1m', 15, false), avgOf('15m', 96)],
    ['1 saat', last('1m', 60, false), avgOf('1h', 24)],
    ['4 saat', last('1m', 240, false), avgOf('4h', 42)],
    ['24 saat', last('15m', 96, true), avgOf('1d', 7)],
  ];
  return rows.map(([label, w, avg]) => ({
    label, q: w.q, x: avg > 0 ? w.q / avg : null,
    buy: w.q > 0 ? w.tq / w.q * 100 : null, net: 2 * w.tq - w.q,
  }));
}

function vwapState(series, price) {
  const t = series.col('5m', 't');
  if (!t.length) return null;
  const dayStart = Math.floor(t[t.length - 1] / DAY) * DAY;
  let from = t.length;
  while (from > 0 && t[from - 1] >= dayStart) from--;
  const r = ta.vwapBands(series.col('5m', 'h'), series.col('5m', 'l'), series.col('5m', 'c'), series.col('5m', 'v'), from);
  if (!r) return null;
  return { ...r, pos: r.sigma > 0 ? (price - r.vwap) / r.sigma : 0 };
}

/**
 * Seviyeler — yalnızca KAPANMIŞ 1h / 4h / 1d mumlardan (devam eden mumun tepesi "direnç" sayılmaz;
 * sayılsaydı yükselen fiyat hep kendi tepesinin "dibinde" görünürdü). Mumlar kapanınca yeniden hesaplanır.
 *   majör (MA200/EMA200, 30 günlük tepe) + 7/30 günlük en yüksek + (levelsSwing) 1h/4h tepe + (levelsFib) Fib
 */
function levelsOf(series, s = {}) {
  const swing = s.levelsSwing !== false, fib = s.levelsFib !== false, bars = s.swingBars || 3, zoneTouches = s.zoneTouches || 3;
  const key = `${series.lastT('1h')}:${series.lastT('4h')}:${series.lastT('1d')}:${swing}:${fib}:${bars}:${zoneTouches}`;
  if (series._lv && series._lv.key === key) return series._lv.levels;
  const d = series.d['1d'];
  const days = d.t.map((_, i) => ({ high: d.h[i], close: d.c[i] }));
  const major = calcLevelSet(series.d['4h'].c, days);
  const { levels: extra, leg } = calcExtraLevels({ h1: series.d['1h'], h4: series.d['4h'], d1: series.d['1d'] }, { swing, fib, bars, zoneTouches }, major);
  const levels = [...major, ...extra];
  series._lv = { key, levels, leg };
  return levels;
}

/** Seviye kimliği (aynı adda birden fazla seviye olabilir: "1h tepe") */
const lvKey = L => (L ? `${L.name}@${L.value}` : null);

/**
 * Fiyat keşfi: %levelMaxPct içinde direnç yok ama fiyat son 24 saatte bir seviyeyi (Fib hariç) yukarı kırmış.
 * @returns {{broken:object, above:object|null, ext:{r:number,value:number}[]}|null}
 */
function discoveryOf(series, price, all) {
  const h1l = series.d['1h'].l, m1l = series.d['1m'].l;
  let low = Infinity;
  for (let i = Math.max(0, h1l.length - 24); i < h1l.length; i++) if (h1l[i] < low) low = h1l[i];
  for (let i = Math.max(0, m1l.length - 60); i < m1l.length; i++) if (m1l[i] < low) low = m1l[i];
  let broken = null, above = null;
  for (const L of all) {
    if (L.kind === 'fib') continue;
    if (L.value < price && L.value > low && (!broken || L.value > broken.value)) broken = L;
    if (L.value > price && (!above || L.value < above.value)) above = L;
  }
  if (!broken) return null;
  return { broken, above, ext: fibExtensions(series._lv?.leg, price, 2) };
}

/**
 * Sahte kırılım (SFP) — her kapanmış 5m mumda çağrılır. `watch` coin başına kalıcı takip listesidir.
 *   Kırılım : 5m mum seviyenin %dipAbovePct'ten fazla üstünde kapanır (önceki mum altındaydı) ve o an
 *             RSI kart şartı sağlanıyor (3m/5m/15m'den en az minTFs tanesi ≥ rsiMin) → sfpBars mum boyunca izlenir.
 *   Seviyeler: yalnızca güçlü olanlar — MA200/EMA200, 30 günlük tepe, 7/30 günlük en yüksek, 4h tepe
 *             (1h tepe ve Fib izlenmez; kartta direnç olarak görünmeye devam eder).
 *   Sahte   : izlenirken bir 5m mum seviyenin ALTINDA kapanırsa ('close'),
 *             ya da aynı 5m mumun fitili seviyeyi ≥ %0.5 aşıp gövdesi ≥ %0.2 ALTINDA kapanırsa ve mumun hacmi
 *             önceki 20 mumun ortalamasının üstündeyse ('wick' — sıradan direnç temasını elemek için sıkı).
 * Aynı mumda birden fazla olay varsa en önemlisi (majör/en yüksek → salınım → Fib) döner.
 */
const KIND_RANK = { major: 0, high: 0, swing: 1, fib: 2 };
function detectSfp(series, s, watch) {
  const d = series.d['5m'];
  const n = d.c.length;
  if (n < 30) return null;
  const o = d.o[n - 1], h = d.h[n - 1], c = d.c[n - 1], cPrev = d.c[n - 2], t = d.t[n - 1];
  let vs = 0;
  for (let j = n - 21; j < n - 1; j++) vs += d.v[j];
  const volOk = d.v[n - 1] > vs / 20;
  const better = (a, b) => !b || (KIND_RANK[a.kind] ?? 3) < (KIND_RANK[b.kind] ?? 3);
  let ev = null;
  for (const [k, w] of watch) {
    if (c < w.value) {
      const e = { ...w, type: 'close', ago: Math.round((t - w.t) / MIN) };
      if (better(e, ev)) ev = e;
      watch.delete(k);
    } else if (--w.left <= 0) watch.delete(k);
  }
  // Kırılım yalnızca RSI kart şartı sağlanırken izlenir (normal RSI kartıyla aynı şart)
  const hits = RSI_TFS.filter(tf => (rsiOf(series, tf, s.rsiPeriod).v ?? 0) >= s.rsiMin).length;
  if (hits < s.minTFs) return ev;
  const up = s.dipAbovePct / 100;
  for (const L of levelsOf(series, s)) {
    if (L.kind === 'fib' || L.name === '1h tepe') continue;          // yalnızca güçlü seviyeler
    const thr = L.value * (1 + up), key = lvKey(L);
    if (watch.has(key)) continue;
    if (c > thr && cPrev <= thr) watch.set(key, { name: L.name, value: L.value, kind: L.kind, t, left: s.sfpBars });
    else if (h > L.value * 1.005 && c < L.value * 0.998 && o < L.value && volOk) {
      const e = { name: L.name, value: L.value, kind: L.kind, type: 'wick', ago: 0 };
      if (better(e, ev)) ev = e;
    }
  }
  return ev;
}

function pickLevel(price, levels, s) {
  let best = null;
  const all = [];
  for (const L of levels) {
    const dist = (price - L.value) / L.value * 100;
    all.push({ ...L, dist });
    if (dist > s.dipAbovePct || dist < -s.levelMaxPct) continue;
    if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { ...L, dist };
  }
  if (best) best.zone = best.dist >= -s.dipBelowPct ? 'dip' : 'near';
  all.sort((a, b) => b.value - a.value);
  return { level: best, all };
}

// ── Değerlendirme ──────────────────────────────────────────────────────────

/**
 * O anki durumun tam fotoğrafı. RSI şartı tutmuyorsa ucuz yoldan döner (ok:false).
 * @param {object} ctx    { funding(sym), btc1h(t) }
 * @param {boolean} force RSI şartı tutmasa da tüm alanları hesapla (/coin komutu)
 */
function evaluate(series, s, ctx = {}, force = false) {
  const price = series.price();
  const t = series.lastT('1m') + MIN;
  const rsi = {};
  let hits = 0, hits2 = 0, strong = 0;
  for (const tf of RSI_TFS) {
    rsi[tf] = rsiOf(series, tf, s.rsiPeriod);
    if (rsi[tf].v >= s.rsiMin) hits++;
    if (rsi[tf].v >= s.rsiMin2) hits2++;
    if (rsi[tf].v >= s.strongRsi) strong++;
  }
  const snap = { symbol: series.symbol, t, price, rsi, hits, hits2, strong, rsiOk: hits >= s.minTFs, ok: false, grade: 0 };
  if (!snap.rsiOk && !force) return snap;

  const { level, all } = pickLevel(price, levelsOf(series, s), s);
  snap.level = level;
  snap.levels = all;
  snap.levelOk = !!level;
  snap.fibLeg = series._lv?.leg ?? null;
  snap.discovery = !level && s.discoveryCards !== false ? discoveryOf(series, price, all) : null;

  // EMA21 % mesafe (güven skoru) + eski ATR ayrışma (sepOk / #AYRISMA)
  snap.sepPct = {
    '3m': separationPct(series, '3m', price),
    '5m': separationPct(series, '5m', price),
  };
  // Eski ATR separation hâlâ dosyada varsa:
  if (typeof separation === 'function') {
    snap.sep = { '3m': separation(series, '3m', price), '5m': separation(series, '5m', price) };
    snap.sepOk = ['3m', '5m'].every(tf => snap.sep[tf] && snap.sep[tf].dist >= s.sepATR && !snap.sep[tf].touched);
  } else {
    // sadece % varsa: abs mesafe ≥ sepPct2 ve pozitif (üstte) ise ayrışmış say
    snap.sep = null;
    snap.sepOk = ['3m', '5m'].every(tf => (snap.sepPct[tf] ?? 0) >= (s.sepPct2 ?? 2));
  }

  snap.neg = { '1m': negPeaks(series, '1m', 40, s.rsiPeriod), '3m': negPeaks(series, '3m', 40, s.rsiPeriod) };
  snap.ride = emaRide(series, '3m');

  const r1h = ta.rsiLast(series.col('1h', 'c'), s.rsiPeriod);
  const r4h = ta.rsiLast(series.col('4h', 'c'), s.rsiPeriod);
  snap.conf = { h1: r1h, h4: r4h, score: (r1h >= s.confRsi ? 1 : 0) + (r4h >= s.confRsi ? 1 : 0) };

  // MACD 3m + 5m + 15m
  snap.macd = {
    '3m': macdState(series, '3m'),
    '5m': macdState(series, '5m'),
    '15m': macdState(series, '15m'),
  };
  snap.stoch = stochState(series, '5m');
  snap.vwap = vwapState(series, price);
  snap.vol = volStats(series);
  snap.counter = { hpu: hiddenPU(series, '4h', s.rsiPeriod), gc: findGoldenCross(series.col('1d', 'c', false)) };

  const wins = [s.windowMin, s.shortWindowMin];
  snap.bursts = burstCounts(series, s, wins);
  snap.windows = wins;
  snap.taker = { [s.windowMin]: takerNet(series, s.windowMin), [s.shortWindowMin]: takerNet(series, s.shortWindowMin) };

  snap.funding = ctx.funding ? ctx.funding(series.symbol) : null;
  snap.btc1h = ctx.btc1h ? ctx.btc1h(t) : null;

  const c1 = series.d['1m'].c, k = c1.length - 1 - s.shortWindowMin;
  snap.chg = k >= 0 && c1[k] > 0 ? (price - c1[k]) / c1[k] * 100 : null;
  snap.chgMin = s.shortWindowMin;

  const fails = [];
  if (s.levelRequired && !snap.levelOk && !snap.discovery) fails.push('seviye');
  if (s.sepRequired && !snap.sepOk) fails.push('ayrışma');
  if (s.confRequired && snap.conf.score < 1) fails.push('destek');
  if (s.macdRequired && !(snap.macd['5m'] && snap.macd['5m'].weakening)) fails.push('macd');
  snap.fails = fails;
  if (!snap.rsiOk) fails.unshift('rsi');
  snap.ok = fails.length === 0;
  snap.check = checklist(snap, s);
  snap.grade = rsiGrade(snap, s);
  return snap;
}

// ── Kart takibi (yeni veri tespiti + numaralandırma) ─────────────────────────

// Yüzde metinleri (Türkçe: %1.25) — kart okunaklı olsun diye işaret yerine kelime kullanılır
const pa = (v, d = 2) => `%${Math.abs(v).toFixed(d)}`;
const ps = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d)}`;
const distTxt = dist => (dist <= 0 ? `${pa(dist)} kala` : `${pa(dist)} üstünde`);
const fpx = v => String(+(+v).toPrecision(6));

/** Sahte kırılım yeniliği */
function sfpText(e) {
  return e.type === 'wick'
    ? `⚠️ Sahte kırılım (fitil): ${e.name} ${fpx(e.value)} · 5dk mum üstüne çıktı, altında kapandı`
    : `⚠️ Sahte kırılım: ${e.name} ${fpx(e.value)} · ${e.ago} dk önce üstüne çıktı, şimdi altında kapandı`;
}

/** Fiyat keşfi yeniliği (ayrıntı — kırılan seviye, sonraki direnç, Fib uzantı — kartın gövdesinde) */
function discoveryText(dc) {
  return `🚀 Fiyat keşfi: ${dc.broken.name} kırıldı`;
}

/** Hacimli mum yeniliği. Yön ve renk FİYATTAN (🟢 yükselen · 🔴 düşen mum); alış/satış oranı ayrıca yazılır,
 *  fiyatın tersine ağırsa belirtilir (ör. yükselen mumda satış %78). */
function burstText(b) {
  const up = b.body >= 0;
  const buyHeavy = b.taker >= 50;
  const share = buyHeavy ? `alış ${pa(b.taker, 0)}` : `satış ${pa(100 - b.taker, 0)}`;
  const against = up !== buyHeavy && b.dir !== 'neutral' ? ' (fiyatın tersine)' : '';
  return `${circles(b.grade || 1, up ? 'green' : 'red')} Hacimli ${up ? 'yükselen' : 'düşen'} mum: ${ps(b.body, 1)} · hacim ${b.volX.toFixed(1)} kat · ${share}${against}`;
}

/** 1 dk hareket yeniliği (RSI kartının içinde): "⚡🟢🟢🟢 1 dk +%3.29 · hacim 34.0 kat · alış %70" */
function moveText(m) {
  const up = m.pct > 0;
  const share = m.taker == null ? null : m.taker >= 50 ? `alış ${pa(m.taker, 0)}` : `satış ${pa(100 - m.taker, 0)}`;
  return [`⚡${circles(m.grade || 1, up ? 'green' : 'red')} 1 dk ${ps(m.pct)}`, m.volX != null ? `hacim ${m.volX.toFixed(1)} kat` : null, share].filter(Boolean).join(' · ');
}

/** Gün anahtarı (gösterim saat dilimi, varsayılan İstanbul) — günlük hareket sayacı bu günde sıfırlanır */
let dayFmt = null;
function dayKey(t) {
  try {
    dayFmt = dayFmt || new Intl.DateTimeFormat('en-CA', { timeZone: process.env.DISPLAY_TZ || 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' });
    return dayFmt.format(new Date(t));
  } catch { return new Date(t).toISOString().slice(0, 10); }
}

const GRADE_TXT = { 0: 'şart dışı', 1: 'kart şartı', 2: 'kontrol listesi', 3: 'kontrol listesi' };

function createTracker() {
  const mem = new Map();   // symbol → { seq, last, log: [{t, price, seq}] }

  const get = sym => {
    let m = mem.get(sym);
    if (!m) { m = { seq: 0, last: null, log: [] }; mem.set(sym, m); }
    return m;
  };

  return {
    /** Kapanmış 5m RSI resetRsi'nin altındaysa seri biter → sonraki kart #1 */
    observe5m(sym, rsi5mClosed, s) {
      if (rsi5mClosed == null || rsi5mClosed >= s.resetRsi) return;
      const m = mem.get(sym);
      if (m && m.seq) { m.seq = 0; m.last = null; }
    },

    /** Yeni veri listesi (boşsa kart gönderilmez) — düz Türkçe, her biri kartta ayrı satır */
    news(sym, snap, trig, s) {
      const m = get(sym);
      const L = m.last;
      const out = [];
      const above = RSI_TFS.filter(tf => snap.rsi[tf].v >= s.rsiMin);
      if (!L) {
        if (snap.rsiOk !== false) out.push('İlk kart');        // RSI ve direnç zaten kartta ayrı satırlarda
        if (snap.discovery) out.push(discoveryText(snap.discovery));
        if (trig.move) out.push(moveText(trig.move));
        else if (trig.burst) out.push(burstText(trig.burst));
        return out;
      }
      if (trig.move) out.push(moveText(trig.move));          // aynı mum hem hareket hem hacimli mumsa yalnız hareket
      else if (trig.burst) out.push(burstText(trig.burst));
      // RSI eşik geçişleri — aynı olay tek satırda: "RSI 85 üstüne çıktı: 3m 86.1 · 5m 85.4"
      const prevAbove = L.above || [];
      const f1 = tf => `${tf} ${snap.rsi[tf].v.toFixed(1)}`;
      const line = (txt, tfs) => { if (tfs.length) out.push(`${txt}: ${tfs.map(f1).join(' · ')}`); };
      line(`RSI ${s.rsiMin} üstüne çıktı`, RSI_TFS.filter(tf => above.includes(tf) && !prevAbove.includes(tf)));
      line(`RSI ${s.rsiMin} altına indi`, RSI_TFS.filter(tf => !above.includes(tf) && prevAbove.includes(tf)));
      if (s.rsiMin2 > s.rsiMin) line(`RSI ${s.rsiMin2} üstüne çıktı`, RSI_TFS.filter(tf => snap.rsi[tf].v >= s.rsiMin2 && !(L.above2 || []).includes(tf)));
      line(`RSI ${s.strongRsi} üstüne çıktı`, RSI_TFS.filter(tf => snap.rsi[tf].v >= s.strongRsi && !L.strong.includes(tf)));
      const sc = snap.check?.score, psc = L.score;
      if (snap.grade !== (L.grade ?? snap.grade)) {
        out.push(`Derece ${snap.grade > L.grade ? 'yükseldi' : 'düştü'}: ${circles(snap.grade)}${sc != null ? ` (kontrol ${sc}/${snap.check.total})` : ` (${GRADE_TXT[snap.grade]})`}`);
      } else if (sc != null && psc != null && sc !== psc) {
        out.push(`Kontrol listesi ${psc}/${snap.check.total} → ${sc}/${snap.check.total}`);
      }
      const dKey = snap.discovery ? lvKey(snap.discovery.broken) : null;
      const discNew = dKey && dKey !== L.discKey;
      if (discNew) out.push(discoveryText(snap.discovery));
      const key = lvKey(snap.level);
      if (key !== L.levelKey) {
        if (discNew) { /* kırılım fiyat keşfi satırında yazıldı */ } else if (L.level && snap.price > L.level.value * (1 + s.dipAbovePct / 100)) {
          out.push(`⚠️ ${L.level.name} seviyesi kırıldı${snap.level ? ` · sıradaki: ${snap.level.name} (${distTxt(snap.level.dist)})` : ' · yakında başka direnç yok'}`);
        } else if (snap.level) {
          out.push(`Yeni direnç: ${snap.level.name} (${distTxt(snap.level.dist)})`);
        }
      } else if (snap.level && snap.level.zone !== L.zone) {
        out.push(snap.level.zone === 'dip'
          ? `⭐ Fiyat dirence dayandı: ${snap.level.name} (${distTxt(snap.level.dist)})`
          : `Fiyat dirençten geri çekildi: ${snap.level.name} (${distTxt(snap.level.dist)})`);
      }
      for (const tf of ['5m', '15m']) {
        const k = snap.macd[tf]?.crossKey;
        if (k && k !== L.macdKeys[tf]) out.push(`${tf} MACD ${snap.macd[tf].cross === 'down' ? 'aşağı' : 'yukarı'} kesti`);
      }
      const sk = snap.stoch?.crossKey;
      if (sk && sk !== L.stochKey) out.push(`5m Stoch RSI ${snap.stoch.cross === 'down' ? 'aşağı' : 'yukarı'} kesti`);
      for (const tf of ['1m', '3m']) {
        const ng = snap.neg?.[tf];
        if (ng && ng.count >= 1 && (ng.count > (L.neg?.[tf] ?? 0) || (ng.count === (L.neg?.[tf] ?? 0) && ng.key !== L.negKey?.[tf]))) {
          out.push(`${tf}'de ${ng.count}. negatif tepe (fiyat yükseldi, RSI düştü)`);
        }
      }
      return out;
    },

    /** Kart gönderildi → durumu kaydet, numarayı döndür */
    commit(sym, snap, s) {
      const m = get(sym);
      m.seq++;
      m.last = {
        hits: snap.hits,
        above: RSI_TFS.filter(tf => snap.rsi[tf].v >= s.rsiMin),
        above2: RSI_TFS.filter(tf => snap.rsi[tf].v >= s.rsiMin2),
        grade: snap.grade,
        score: snap.check?.score ?? null,
        strong: RSI_TFS.filter(tf => snap.rsi[tf].v >= s.strongRsi),
        levelKey: lvKey(snap.level),
        discKey: snap.discovery ? lvKey(snap.discovery.broken) : null,
        level: snap.level,
        zone: snap.level ? snap.level.zone : null,
        macdKeys: { '5m': snap.macd['5m']?.crossKey ?? (m.last?.macdKeys['5m'] ?? null), '15m': snap.macd['15m']?.crossKey ?? (m.last?.macdKeys['15m'] ?? null) },
        stochKey: snap.stoch?.crossKey ?? (m.last?.stochKey ?? null),
        neg: { '1m': snap.neg?.['1m']?.count ?? 0, '3m': snap.neg?.['3m']?.count ?? 0 },
        negKey: { '1m': snap.neg?.['1m']?.key ?? null, '3m': snap.neg?.['3m']?.key ?? null },
      };
      m.log.push({ t: snap.t, price: snap.price, seq: m.seq });
      while (m.log.length && m.log[0].t < snap.t - DAY) m.log.shift();
      return m.seq;
    },

    /** Seri devam ediyor mu? (bu coinde kart gitmiş ve 5m RSI henüz resetRsi'nin altında kapanmamış) */
    active: sym => (mem.get(sym)?.seq ?? 0) > 0,

    /** Günlük 1 dk hareket sayacı (bellekte; diske yazılmaz, gün değişince sıfırlanır) */
    countMove(sym, t, dir) {
      const m = get(sym), k = dayKey(t);
      if (!m.mv || m.mv.day !== k) m.mv = { day: k, up: 0, down: 0 };
      if (dir > 0) m.mv.up++; else m.mv.down++;
    },
    moveStats(sym, t) {
      const mv = mem.get(sym)?.mv;
      return mv && mv.day === dayKey(t) ? { up: mv.up, down: mv.down } : { up: 0, down: 0 };
    },

    /** Sahte kırılım takip listesi (coin başına, seri sıfırlansa da korunur) */
    sfpWatch(sym) { const m = get(sym); if (!m.sfp) m.sfp = new Map(); return m.sfp; },

    log: sym => mem.get(sym)?.log ?? [],
    forget: sym => mem.delete(sym),
  };
}

/**
 * Bir 1m kapanışı sonrası tek adım: gerekirse değerlendirir, kart nesnesi ya da null döner.
 * @param {Set<string>} closedTfs  Series.apply1m()'in döndürdüğü küme
 * @param {object} ctx  { funding, btc1h, isMuted(sym,t), isFollowed(sym) }
 */
function step(series, closedTfs, s, tracker, ctx = {}) {
  if (!series.ready()) return null;
  const sym = series.symbol;
  if (closedTfs.has('5m')) tracker.observe5m(sym, ta.rsiLast(series.col('5m', 'c', false), s.rsiPeriod), s);

  const tfs = RSI_TFS.filter(tf => closedTfs.has(tf));
  const burst = detectBurst(series, s);
  if (burst) burst.grade = volGrade(burst.body, burst.volX, burst.taker, s);
  // Sahte kırılım takibi her 5m kapanışında (kart şartından bağımsız)
  let sfp = null;
  if (s.sfpCards !== false && closedTfs.has('5m')) {
    const w = tracker.sfpWatch(sym);
    sfp = detectSfp(series, s, w);
    // Bekleme: bir sahte kırılım kartından sonra sfpBars × 5 dk yeni SFP kartı yok (aynı bölgede art arda kart olmasın)
    if (sfp && w.until && series.lastT('1m') + MIN < w.until) sfp = null;
  }
  // 1 dk hareket (≥ moveAlertPct): günlük sayaca yazılır; RSI şartı sağlanıyorsa karta girer (ayrı uyarı yok)
  let move = null;
  if (s.moveAlertPct > 0) {
    const d = series.d['1m'], i = d.c.length - 1;
    const pct = i >= 1 ? movePct(d.c[i - 1], d.t[i - 1], { t: d.t[i], o: d.o[i], c: d.c[i] }) : null;
    if (pct != null && Math.abs(pct) >= s.moveAlertPct) {
      let sum = 0, k = 0;
      for (let j = Math.max(0, i - 20); j < i; j++) { sum += d.v[j]; k++; }
      const volX = k >= 5 && sum > 0 ? d.v[i] / (sum / k) : null;
      const taker = d.v[i] > 0 ? d.tb[i] / d.v[i] * 100 : null;
      move = { pct, from: d.t[i - 1] === d.t[i] - MIN ? d.c[i - 1] : d.o[i], to: d.c[i], volX, taker, t: d.t[i] + MIN };
      move.grade = volGrade(pct, volX, taker, s);
      tracker.countMove(sym, move.t, pct);
    }
  }
  if (!tfs.length && !burst && !move) return null;

  let snap = evaluate(series, s, ctx);
  // Sahte kırılım kartı yalnızca KART ANINDA da RSI şartı sağlanıyorsa (kırılım anındaki şart yetmez)
  if (sfp && !snap.rsiOk) sfp = null;
  if (sfp) { const w = tracker.sfpWatch(sym); w.until = snap.t + s.sfpBars * 5 * MIN; }
  let inSeries = false;
  if (!snap.ok) {
    // Şart dışı ama yine de kart: (a) sahte kırılım, (b) seri sürerken gelen hacimli mum
    // (ör. tepedeki sert satış mumu RSI'ı 90'ın altına indirse de bildirilir)
    const seriesBurst = Boolean(burst && s.seriesBursts && tracker.active(sym));
    const moveCard = Boolean(move && snap.rsiOk);           // hareket: yalnızca RSI şartı sağlanan coinlerde kart
    if (!sfp && !seriesBurst && !moveCard) return null;
    if (!snap.rsiOk) snap = evaluate(series, s, ctx, true);
    inSeries = seriesBurst;
    if (sfp && !(snap.grade > 0)) {             // SFP kartında derece kontrol listesinden (RSI eşiği aranmaz)
      const sc = snap.check ? snap.check.score : 0;
      snap.grade = sc >= s.grade3Min ? 3 : sc >= s.grade2Min ? 2 : 1;
    }
  }
  if (ctx.isMuted && ctx.isMuted(sym, snap.t)) return null;

  const trig = { tfs, burst, inSeries, sfp, move };
  const news = tracker.news(sym, snap, trig, s);
  if (sfp) news.unshift(sfpText(sfp));
  if (inSeries) {
    const why = snap.fails.map(f => (f === 'rsi' ? `RSI ${s.rsiMin} üstü ${snap.hits}/3` : f === 'seviye' ? 'yakında direnç yok' : f)).join(', ');
    news.push(`Seri sürüyor, şart artık sağlanmıyor (${why})`);
  }
  if (!news.length) return null;
  const seq = tracker.commit(sym, snap, s);

  const followed = ctx.isFollowed ? ctx.isFollowed(sym) : false;
  const dip = snap.level?.zone === 'dip';
  const tags = [
    `#${sym}`, `#DERECE${snap.grade}`,
    snap.level ? (dip ? '#DIRENCTE' : '#YAKLASIYOR') : null,
    burst ? '#HACIM' : null,
    move ? '#HAREKET' : null,
    inSeries ? '#SERI' : null,
    sfp ? '#SAHTEKIRILIM' : null,
    snap.discovery ? '#FIYATKESFI' : null,
    Math.max(snap.neg?.['1m']?.count ?? 0, snap.neg?.['3m']?.count ?? 0) >= 2 ? '#NEGTEPE' : null,
    snap.sepOk ? '#AYRISMA' : null,
    followed ? '#TAKIP' : null,
  ].filter(Boolean);

  return {
    id: `${sym}-${snap.t}`, symbol: sym, seq, t: snap.t, price: snap.price,
    snap, news, trig, tags, followed, inSeries,
    moveStats: tracker.moveStats(sym, snap.t),
    grade: snap.grade,
    // Bildirim: cardSound açıksa her kart sesli; kapalıysa yalnız 🔴🔴🔴 ve takipteki coinler
    silent: !(s.cardSound !== false || snap.grade === 3 || followed),
  };
}

/**
 * 1 dakikalık fiyat hareketi: kapanış, bir önceki 1m kapanışa göre (önceki yoksa açılışa göre).
 * @returns {number|null} yüzde değişim
 */
function movePct(prevClose, prevT, c) {
  const base = prevClose > 0 && prevT === c.t - MIN ? prevClose : c.o;
  return base > 0 ? (c.c - base) / base * 100 : null;
}

module.exports = { rsiOf, findHiddenPU, findGoldenCross, volStats, emaRide, moveText, evaluate, step, createTracker, detectBurst, burstCounts, takerNet, burstAt, pickLevel, levelsOf, detectSfp, discoveryOf, negPeaks, movePct, volGrade, rsiGrade, checklist, circles, dirColor, RSI_TFS };
