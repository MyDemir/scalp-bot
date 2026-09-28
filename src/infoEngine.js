'use strict';

/**
 * Bilgi botu motoru — canlı bot ve backtest AYNI fonksiyonları kullanır.
 *
 *   Kontrol anı : her kapanan 1m mumda Series.apply1m() çağrılır; değerlendirme yalnızca
 *                 (a) 3m / 5m / 15m mumlarından biri kapandıysa ya da (b) bu 1m mum hacimli bir
 *                 patlamaysa yapılır. Kapanmamış dilimlerin RSI'ı devam eden mumla hesaplanır (canlı, "~").
 *   Şart        : 3m/5m/15m'den en az minTFs tanesinde RSI ≥ rsiMin
 *                 + (levelRequired) fiyatın üstünde en fazla %levelMaxPct uzakta bir seviye
 *                 + isteğe bağlı: ayrışma / destek / MACD şartları
 *   Yeni kart   : şart sağlanıyor VE önceki karttan bu yana yeni veri var (patlama, RSI dilim sayısı,
 *                 güçlü RSI, seviye/bölge, MACD ya da Stoch RSI kesişimi). Yeni veri yoksa kart yok.
 *   Numara      : aynı coinde kartlar #1, #2 … diye artar; kapanmış 5m RSI < resetRsi olunca sıfırlanır.
 *
 * Bu modülün yan etkisi yok (ağ/Telegram açmaz).
 */

const ta = require('./ta');
const { calcLevelSet } = require('./levels');

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

function rsiOf(series, tf) {
  const live = !series.isClosedNow(tf);
  return { v: ta.rsiLast(series.col(tf, 'c', true)), live };
}

function separation(series, tf, price) {
  const c = series.col(tf, 'c'), h = series.col(tf, 'h'), l = series.col(tf, 'l');
  const e = ta.emaSeries(c, 21), a = ta.atrSeries(h, l, c, 14);
  if (!e.length || !a.length) return null;
  const ema = e[e.length - 1], atr = a[a.length - 1];
  let touched = false;
  for (let k = 1; k <= 3 && k <= e.length; k++) {
    const i = c.length - k, ev = e[e.length - k];
    if (l[i] <= ev && ev <= h[i]) { touched = true; break; }
  }
  return { ema, atr, dist: atr > 0 ? (price - ema) / atr : 0, touched };
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
 * Seviyeler — yalnızca KAPANMIŞ 4h ve 1d mumlardan (devam eden günün tepesi "direnç" sayılmaz;
 * sayılsaydı yükselen fiyat hep kendi tepesinin "dibinde" görünürdü). 4h/1d kapanınca yeniden hesaplanır.
 */
function levelsOf(series) {
  const key = `${series.lastT('4h')}:${series.lastT('1d')}`;
  if (series._lv && series._lv.key === key) return series._lv.levels;
  const d = series.d['1d'];
  const days = d.t.map((_, i) => ({ high: d.h[i], close: d.c[i] }));
  const levels = calcLevelSet(series.d['4h'].c, days);
  series._lv = { key, levels };
  return levels;
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
  const t = series.lastT('1m') + MIN;                    // son 1m mumun kapanış anı
  const rsi = {};
  let hits = 0, strong = 0;
  for (const tf of RSI_TFS) {
    rsi[tf] = rsiOf(series, tf);
    if (rsi[tf].v >= s.rsiMin) hits++;
    if (rsi[tf].v >= s.strongRsi) strong++;
  }
  const snap = { symbol: series.symbol, t, price, rsi, hits, strong, rsiOk: hits >= s.minTFs, ok: false };
  if (!snap.rsiOk && !force) return snap;

  const { level, all } = pickLevel(price, levelsOf(series), s);
  snap.level = level;
  snap.levels = all;
  snap.levelOk = !!level;

  snap.sep = { '3m': separation(series, '3m', price), '5m': separation(series, '5m', price) };
  snap.sepOk = ['3m', '5m'].every(tf => snap.sep[tf] && snap.sep[tf].dist >= s.sepATR && !snap.sep[tf].touched);

  const r1h = ta.rsiLast(series.col('1h', 'c')), r4h = ta.rsiLast(series.col('4h', 'c'));
  snap.conf = { h1: r1h, h4: r4h, score: (r1h >= s.confRsi ? 1 : 0) + (r4h >= s.confRsi ? 1 : 0) };

  snap.macd = { '5m': macdState(series, '5m'), '15m': macdState(series, '15m') };
  snap.stoch = stochState(series, '5m');
  snap.vwap = vwapState(series, price);

  const wins = [s.windowMin, s.shortWindowMin];
  snap.bursts = burstCounts(series, s, wins);
  snap.windows = wins;
  snap.taker = { [s.windowMin]: takerNet(series, s.windowMin), [s.shortWindowMin]: takerNet(series, s.shortWindowMin) };

  snap.funding = ctx.funding ? ctx.funding(series.symbol) : null;
  snap.btc1h = ctx.btc1h ? ctx.btc1h(t) : null;

  const fails = [];
  if (s.levelRequired && !snap.levelOk) fails.push('seviye');
  if (s.sepRequired && !snap.sepOk) fails.push('ayrışma');
  if (s.confRequired && snap.conf.score < 1) fails.push('destek');
  if (s.macdRequired && !(snap.macd['5m'] && snap.macd['5m'].weakening)) fails.push('macd');
  snap.fails = fails;
  if (!snap.rsiOk) fails.unshift('rsi');
  snap.ok = fails.length === 0;
  return snap;
}

// ── Kart takibi (yeni veri tespiti + numaralandırma) ─────────────────────────

const pct = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`;

function burstText(b) {
  const lab = b.dir === 'sell' ? '▼ satış' : b.dir === 'buy' ? '▲ alım' : '◆ nötr';
  return `${lab} patlaması ${pct(b.body, 1)} · hacim ${b.volX.toFixed(1)}× · taker %${Math.round(b.taker)}`;
}

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

    /** Yeni veri listesi (boşsa kart gönderilmez) */
    news(sym, snap, trig, s) {
      const m = get(sym);
      const L = m.last;
      const out = [];
      if (trig.burst) out.push(burstText(trig.burst));
      if (!L) {
        out.unshift(`İlk kart · RSI ${snap.hits}/3 ≥ ${s.rsiMin}${snap.level ? ` · ${snap.level.name} ${pct(snap.level.dist)}` : ''}`);
        return out;
      }
      if (snap.hits !== L.hits) out.push(`RSI ${snap.hits}/3 ${snap.hits > L.hits ? '↑' : '↓'}`);
      for (const tf of RSI_TFS) {
        if (snap.rsi[tf].v >= s.strongRsi && !L.strong.includes(tf)) out.push(`${tf} RSI ${s.strongRsi}↑`);
      }
      const key = snap.level ? snap.level.name : null;
      if (key !== L.levelKey) {
        if (L.level && snap.price > L.level.value * (1 + s.dipAbovePct / 100)) {
          out.push(`⚠️ ${L.level.name} kırıldı${snap.level ? ` → ${snap.level.name} ${pct(snap.level.dist)}` : ''}`);
        } else if (snap.level) {
          out.push(`Seviye: ${snap.level.name} ${pct(snap.level.dist)}`);
        }
      } else if (snap.level && snap.level.zone !== L.zone) {
        out.push(snap.level.zone === 'dip' ? `⭐ DİPTE: ${snap.level.name} ${pct(snap.level.dist)}` : `${snap.level.name}: dipten uzaklaştı ${pct(snap.level.dist)}`);
      }
      for (const tf of ['5m', '15m']) {
        const k = snap.macd[tf]?.crossKey;
        if (k && k !== L.macdKeys[tf]) out.push(`MACD ${tf} ${snap.macd[tf].cross === 'down' ? '↓' : '↑'} kesişim`);
      }
      const sk = snap.stoch?.crossKey;
      if (sk && sk !== L.stochKey) out.push(`Stoch RSI 5m ${snap.stoch.cross === 'down' ? '↓' : '↑'} kesişim`);
      return out;
    },

    /** Kart gönderildi → durumu kaydet, numarayı döndür */
    commit(sym, snap, s) {
      const m = get(sym);
      m.seq++;
      m.last = {
        hits: snap.hits,
        strong: RSI_TFS.filter(tf => snap.rsi[tf].v >= s.strongRsi),
        levelKey: snap.level ? snap.level.name : null,
        level: snap.level,
        zone: snap.level ? snap.level.zone : null,
        macdKeys: { '5m': snap.macd['5m']?.crossKey ?? (m.last?.macdKeys['5m'] ?? null), '15m': snap.macd['15m']?.crossKey ?? (m.last?.macdKeys['15m'] ?? null) },
        stochKey: snap.stoch?.crossKey ?? (m.last?.stochKey ?? null),
      };
      m.log.push({ t: snap.t, price: snap.price, seq: m.seq });
      while (m.log.length && m.log[0].t < snap.t - DAY) m.log.shift();
      return m.seq;
    },

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
  if (closedTfs.has('5m')) tracker.observe5m(sym, ta.rsiLast(series.col('5m', 'c', false)), s);

  const tfs = RSI_TFS.filter(tf => closedTfs.has(tf));
  const burst = detectBurst(series, s);
  if (!tfs.length && !burst) return null;

  const snap = evaluate(series, s, ctx);
  if (!snap.ok) return null;
  if (ctx.isMuted && ctx.isMuted(sym, snap.t)) return null;

  const trig = { tfs, burst };
  const news = tracker.news(sym, snap, trig, s);
  if (!news.length) return null;
  const seq = tracker.commit(sym, snap, s);

  const followed = ctx.isFollowed ? ctx.isFollowed(sym) : false;
  const dip = snap.level?.zone === 'dip';
  const tags = [
    `#${sym}`, `#RSI${snap.hits}`,
    snap.level ? (dip ? '#DIPTE' : '#YAKLASIYOR') : null,
    burst ? '#HACIM' : null,
    snap.sepOk ? '#AYRISMA' : null,
    followed ? '#TAKIP' : null,
  ].filter(Boolean);

  return {
    id: `${sym}-${snap.t}`, symbol: sym, seq, t: snap.t, price: snap.price,
    snap, news, trig, tags, followed,
    silent: !((snap.hits === 3 && dip) || followed),
  };
}

module.exports = { evaluate, step, createTracker, detectBurst, burstCounts, takerNet, burstAt, pickLevel, levelsOf, RSI_TFS };
