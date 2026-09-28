'use strict';

/**
 * Kart sınıfları ve "kart sonrası fiyat" özetleri — backtest raporu ve canlı /istatistik ORTAK kullanır.
 * Kazanç/kayıp hesabı yoktur: yalnızca karttan sonraki 15/60 dk'da fiyatın en düşük / en yüksek /
 * kapanış değişimi (kart anındaki fiyata göre, medyan).
 */

const { RSI_TFS } = require('./infoEngine');

const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctS = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const fmtDate = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function compact(c) {
  const sn = c.snap;
  return {
    symbol: c.symbol, t: c.t, time: fmtDate(c.t), seq: c.seq, price: c.price, silent: c.silent, inSeries: Boolean(c.inSeries),
    news: c.news, tags: c.tags,
    rsi: Object.fromEntries(RSI_TFS.map(tf => [tf, +sn.rsi[tf].v.toFixed(2)])), hits: sn.hits,
    level: sn.level ? { name: sn.level.name, value: sn.level.value, dist: +sn.level.dist.toFixed(3), zone: sn.level.zone } : null,
    burst: c.trig.burst ? { dir: c.trig.burst.dir, body: +c.trig.burst.body.toFixed(2), volX: +c.trig.burst.volX.toFixed(1), taker: Math.round(c.trig.burst.taker) } : null,
    trigTFs: c.trig.tfs,
    sepOk: sn.sepOk, conf: sn.conf.score,
    neg1m: sn.neg?.['1m']?.count ?? 0, neg3m: sn.neg?.['3m']?.count ?? 0, rsi1h: sn.conf.h1 != null ? +sn.conf.h1.toFixed(1) : null, rsi4h: sn.conf.h4 != null ? +sn.conf.h4.toFixed(1) : null,
    macd5m: sn.macd['5m']?.text ?? null, macd15m: sn.macd['15m']?.text ?? null,
    stoch5m: sn.stoch ? { k: +sn.stoch.k.toFixed(1), d: +sn.stoch.d.toFixed(1), cross: sn.stoch.cross } : null,
    vwapSigma: sn.vwap ? +sn.vwap.pos.toFixed(2) : null,
    bursts: sn.bursts, btc1h: sn.btc1h != null ? +sn.btc1h.toFixed(2) : null,
    fwd: c.fwd,
  };
}

const CLASSES = [
  ['Tüm kartlar',          () => true],
  ['İlk kart (#1)',        c => c.seq === 1],
  ['RSI 2/3',              c => c.hits === 2],
  ['RSI 3/3',              c => c.hits === 3],
  ['DİPTE',                c => c.level?.zone === 'dip'],
  ['Yaklaşıyor',           c => c.level?.zone === 'near'],
  ['Hacim tetikli',        c => c.burst != null],
  ['  ↳ satış patlaması',  c => c.burst?.dir === 'sell'],
  ['  ↳ alım patlaması',   c => c.burst?.dir === 'buy'],
  ['  ↳ seri içi (şartsız)', c => c.inSeries],
  ['    ↳ satış',          c => c.inSeries && c.burst?.dir === 'sell'],
  ['Ayrışma ✓',            c => c.sepOk],
  ['Destek 2/2',           c => c.conf === 2],
  ['Negatif tepe ≥2',      c => Math.max(c.neg1m || 0, c.neg3m || 0) >= 2],
  ['3/3 + DİPTE (sesli)',  c => c.hits === 3 && c.level?.zone === 'dip'],
];

function classTable(cards) {
  const rows = [];
  for (const [name, f] of CLASSES) {
    const sub = cards.filter(f);
    const ok = sub.filter(c => c.fwd?.[60]);
    rows.push({
      name, n: sub.length,
      low60: median(ok.map(c => c.fwd[60].low)), high60: median(ok.map(c => c.fwd[60].high)), close60: median(ok.map(c => c.fwd[60].close)),
      low15: median(sub.filter(c => c.fwd?.[15]).map(c => c.fwd[15].low)),
    });
  }
  return rows;
}

function load(cards) {
  const perMin = new Map(), perHour = new Map();
  for (const c of cards) {
    perMin.set(c.t, (perMin.get(c.t) || 0) + 1);
    const h = Math.floor(c.t / 3_600_000);
    perHour.set(h, (perHour.get(h) || 0) + 1);
  }
  const maxMin = Math.max(0, ...perMin.values()), maxHour = Math.max(0, ...perHour.values());
  const over20 = [...perMin.values()].filter(v => v > 20).length;
  const peakHour = [...perHour.entries()].sort((a, b) => b[1] - a[1])[0];
  return { maxMin, maxHour, over20, peakHour: peakHour ? { at: fmtDate(peakHour[0] * 3_600_000), n: peakHour[1] } : null };
}

module.exports = { median, pctS, fmtDate, compact, CLASSES, classTable, load };
