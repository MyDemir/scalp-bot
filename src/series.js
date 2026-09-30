'use strict';

/**
 * Tek bir coinin çoklu zaman dilimi mum deposu — 1m mumlardan beslenir.
 *
 *   • Canlıda WebSocket'ten yalnızca KAPANMIŞ 1m mumlar gelir; 3m/5m/15m/1h/4h/1d burada 1m'lerden
 *     üretilir (coin başına tek stream → tüm market tek bağlantıya sığar).
 *   • Başlangıçta her TF REST'ten tohumlanır (seed); REST'in döndürdüğü devam eden mum "yarım mum"
 *     (partial) olur, sonraki 1m'ler onun üstüne eklenir.
 *   • Backtest AYNI sınıfı kullanır: geçmiş 1m'ler sırayla apply1m() ile verilir → canlıyla aynı hesap.
 *
 * Saklama sütunludur (t/o/h/l/c/v/tb/q/tq ayrı sayı dizileri) — yüzlerce coinde bellek ve hız için.
 *   tb = taker alış hacmi (baz), q = hacim (USDT), tq = taker alış hacmi (USDT)
 *
 * Bu modülün yan etkisi yok.
 */

const MIN = 60_000;
const TF_MS = { '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN };
const HTF = ['3m', '5m', '15m', '1h', '4h', '1d'];
const COLS = ['t', 'o', 'h', 'l', 'c', 'v', 'tb', 'q', 'tq'];

// Tampon boyları (kapanmış mum). Seed limitleri de bunlardan gelir.
const KEEP = { '1m': 240, '3m': 300, '5m': 300, '15m': 300, '1h': 336, '4h': 600, '1d': 400 };   // 1h: 2 hafta (Fib bacağı)   // 1d: ~13 ay (günlük bölge, trend çizgisi, geniş Fib)

// Değerlendirme için gereken en az kapanmış mum
const MIN_READY = { '1m': 25, '3m': 60, '5m': 60, '15m': 40, '1h': 15, '4h': 0, '1d': 0 };

function emptyCols() {
  const o = {};
  for (const k of COLS) o[k] = [];
  return o;
}

/** REST/WS mumunu ortak biçime çevirir. Ham Binance dizisi ya da nesne kabul eder. */
function normKline(k, now = Date.now()) {
  if (Array.isArray(k)) {
    return {
      t: Number(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
      closeTime: Number(k[6]), q: +k[7] || 0, tb: +k[9] || 0, tq: +k[10] || 0,
      closed: Number(k[6]) < now,
    };
  }
  return k;
}

class Series {
  constructor(symbol, keep = KEEP) {
    this.symbol = symbol;
    this.keep = keep;
    this.d = {};
    this.part = {};
    for (const tf of Object.keys(TF_MS)) { this.d[tf] = emptyCols(); this.part[tf] = null; }
  }

  // ── yazma ────────────────────────────────────────────────

  _push(tf, c) {
    const d = this.d[tf];
    const n = d.t.length;
    if (n && d.t[n - 1] === c.t) {                 // aynı mum → üstüne yaz
      for (const k of COLS) d[k][n - 1] = c[k] ?? 0;
      return;
    }
    if (n && d.t[n - 1] > c.t) return;             // eski mum → yok say
    for (const k of COLS) d[k].push(c[k] ?? 0);
    if (d.t.length > this.keep[tf]) for (const k of COLS) d[k].shift();
  }

  /**
   * Tohumlama: kapanmış mumlar tampona, son kapanmamış mum yarım mum olur (1m'de yarım mum tutulmaz).
   * @param {object[]} candles normKline biçiminde, eski → yeni
   */
  seed(tf, candles) {
    this.d[tf] = emptyCols();
    this.part[tf] = null;
    for (const c of candles) {
      if (c.closed === false) { if (tf !== '1m') this.part[tf] = { ...c }; continue; }
      this._push(tf, c);
    }
  }

  /**
   * Kapanmış bir 1m mumu ekler ve üst TF'leri günceller.
   * @returns {Set<string>} bu mumla KAPANAN üst TF'ler (ör. {'3m','15m'})
   */
  apply1m(c) {
    const closed = new Set();
    const d1 = this.d['1m'];
    const last = d1.t.length ? d1.t[d1.t.length - 1] : -Infinity;
    if (c.t <= last) return closed;                // tekrar ya da eski
    this._push('1m', c);

    const end = c.t + MIN;                         // bu 1m'in kapanış sınırı
    for (const tf of HTF) {
      const ms = TF_MS[tf];
      const ps = Math.floor(c.t / ms) * ms;
      let p = this.part[tf];
      if (p && p.t < ps) { this._push(tf, p); p = null; }          // önceki periyot bitmiş (boşluk vb.)
      if (p && p.t > ps) continue;                                  // (olmamalı) daha yeni yarım mum
      if (!p) {
        p = { t: ps, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, tb: c.tb || 0, q: c.q || 0, tq: c.tq || 0 };
      } else {
        if (c.h > p.h) p.h = c.h;
        if (c.l < p.l) p.l = c.l;
        p.c = c.c; p.v += c.v; p.tb += c.tb || 0; p.q += c.q || 0; p.tq += c.tq || 0;
      }
      if (end === ps + ms) { this._push(tf, p); this.part[tf] = null; closed.add(tf); }
      else this.part[tf] = p;
    }
    return closed;
  }

  // ── okuma ────────────────────────────────────────────────

  /** Sütun (kopyalamaz; withPartial ise yarım mum eklenmiş YENİ dizi) */
  col(tf, name, withPartial = true) {
    const a = this.d[tf][name];
    const p = this.part[tf];
    return withPartial && p ? a.concat([p[name]]) : a;
  }

  /** Bu TF'in son mumu şu an kapalı mı (yarım mum yok)? */
  isClosedNow(tf) { return this.part[tf] == null; }

  count(tf) { return this.d[tf].t.length; }

  lastT(tf = '1m') { const t = this.d[tf].t; return t.length ? t[t.length - 1] : null; }

  price() {
    const c = this.d['1m'].c;
    return c.length ? c[c.length - 1] : (this.part['3m']?.c ?? null);
  }

  /** i. son kapanmış 1m mum (0 = en son) */
  m1(i = 0) {
    const d = this.d['1m'], n = d.t.length - 1 - i;
    if (n < 0) return null;
    const o = {};
    for (const k of COLS) o[k] = d[k][n];
    return o;
  }

  ready() {
    for (const [tf, n] of Object.entries(MIN_READY)) if (this.count(tf) < n) return false;
    return true;
  }
}

module.exports = { Series, normKline, TF_MS, KEEP, HTF, MIN };
