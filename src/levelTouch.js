'use strict';

/**
 * Seviye tepkisi — izlenen coinlerde fiyat bir dirence ALTTAN değdiğinde olay açılır, sonraki 60 dk izlenir.
 * Kartı etkilemez; yalnızca istatistik için /data/cards.db'ye yazılır (/seviye komutu, backtest raporu).
 *
 *   Temas    : önceki 1m kapanış seviyenin %0.3'ten fazla altındaydı, bu 1m mumun tepesi seviyenin %0.3 yakınına
 *              geldi (ya da geçti). Aynı seviye için 60 dk içinde ikinci temas yazılmaz.
 *   Seviyeler: kartlardakiyle aynı (levelsOf): MA200/EMA200, 7/30 günlük en yüksek, günlük bölge / trend çizgisi,
 *              1h/4h tepe, Fib 0.236–0.786 (grafikteki 1 saatlik bacak)
 *   Temasta  : 3m/5m/15m RSI → RSI kart şartı sağlanıyor mu (≥ minTFs dilim ≥ rsiMin); ±5 dk içinde kart çıktı mı;
 *              fiyatın 3m EMA21'e uzaklığı
 *   60 dk    : en derin geri çekilme (o ana kadarki en yüksekten, %) ve dibe kaç dk · 3m EMA21'e dönüş ve kaç dk ·
 *              kırılım (5m kapanış seviyenin %dipAbovePct üstünde) ve kaç dk · EMA21'e döndükten SONRA kırılım ·
 *              60. dk kapanışı seviyenin üstünde mi · seviyeye göre en yüksek / en düşük / kapanış (%)
 *
 * Kazanç/kayıp hesabı YOK — yalnızca fiyatın seviyede ne yaptığı.
 */

const ta = require('./ta');
const { levelsOf, rsiOf, RSI_TFS } = require('./infoEngine');

const MIN = 60_000;
const TOUCH_PCT = 0.3;     // seviyeye bu kadar yakın tepe = temas
const WINDOW = 60;         // izleme süresi (dk)
const CARD_NEAR = 5;       // temasın ±5 dk içinde kart → "kart çıktı"

function ema21of(series) {
  const e = ta.emaSeries(series.col('3m', 'c', false), 21);
  return e.length ? e[e.length - 1] : null;
}

function createTouchTracker({ window = WINDOW, touchPct = TOUCH_PCT } = {}) {
  const open = new Map();       // sym → açık olaylar
  const cool = new Map();       // sym → Map(seviye anahtarı → bu zamana kadar yeni temas yok)
  const cardT = new Map();      // sym → son kart zamanları
  let openN = 0;

  function finish(e, c) {
    const v = e.value;
    const nearCard = (cardT.get(e.symbol) || []).some(t => Math.abs(t - e.t) <= CARD_NEAR * MIN);
    return {
      id: e.id, symbol: e.symbol, t: e.t, name: e.name, kind: e.kind, value: v,
      hits: e.hits, rsiOk: e.rsiOk, card: nearCard,
      rsi: e.rsi, emaGap: e.emaGap,
      pb: +e.pb.toFixed(3), pbMin: e.pbMin,
      emaMin: e.emaMin, brokeMin: e.brokeMin, brokeAfterEma: e.brokeAfterEma,
      held: c > v,
      up: +((e.hi - v) / v * 100).toFixed(3), dn: +((e.lo - v) / v * 100).toFixed(3), c60: +((c - v) / v * 100).toFixed(3),
    };
  }

  return {
    /**
     * Kapanmış her 1m mumda (series.apply1m'den sonra) çağrılır.
     * @returns {object[]} 60 dk'sı dolan olaylar (kayda hazır)
     */
    observe(series, closedTfs, s) {
      const sym = series.symbol;
      const d = series.d['1m'];
      const i = d.c.length - 1;
      if (i < 1) return [];
      const h = d.h[i], l = d.l[i], c = d.c[i], tClose = d.t[i] + MIN;
      const done = [];

      // 1) Açık olayları ilerlet
      const arr = open.get(sym);
      let ema = null;
      if (arr && arr.length) {
        ema = ema21of(series);
        const up = (s.dipAbovePct ?? 0.3) / 100;
        const c5 = closedTfs && closedTfs.has('5m') ? series.d['5m'].c[series.d['5m'].c.length - 1] : null;
        for (let k = arr.length - 1; k >= 0; k--) {
          const e = arr[k];
          const m = Math.round((tClose - e.t) / MIN);
          if (h > e.peak) e.peak = h;
          const dd = (e.peak - l) / e.peak * 100;
          if (dd > e.pb) { e.pb = dd; e.pbMin = m; }
          if (h > e.hi) e.hi = h;
          if (l < e.lo) e.lo = l;
          if (e.emaMin == null && ema != null && l <= ema) e.emaMin = m;
          if (e.brokeMin == null && c5 != null && c5 > e.value * (1 + up)) {
            e.brokeMin = m;
            e.brokeAfterEma = e.emaMin != null;
          }
          if (m >= window) { done.push(finish(e, c)); arr.splice(k, 1); openN--; }
        }
        if (!arr.length) open.delete(sym);
      }

      // 2) Yeni temaslar (alttan)
      if (d.t[i - 1] !== d.t[i] - MIN) return done;             // kopukluk: önceki kapanış yok
      const prev = d.c[i - 1];
      let cm = cool.get(sym);
      let rsi = null;
      for (const L of levelsOf(series, s)) {
        const thr = L.value * (1 - touchPct / 100);
        if (!(prev < thr && h >= thr)) continue;
        const key = `${L.name}@${L.value}`;
        if (cm && cm.get(key) > tClose) continue;
        if (!cm) { cm = new Map(); cool.set(sym, cm); }
        cm.set(key, tClose + window * MIN);
        if (!rsi) {
          rsi = {};
          for (const tf of RSI_TFS) { const v = rsiOf(series, tf, s.rsiPeriod).v; rsi[tf] = v != null ? +v.toFixed(1) : null; }
          if (ema == null) ema = ema21of(series);
        }
        const hits = RSI_TFS.filter(tf => (rsi[tf] ?? 0) >= s.rsiMin).length;
        const e = {
          id: `${sym}-${tClose}-${L.name}-${L.value}`, symbol: sym, t: tClose, name: L.name, kind: L.kind, value: L.value,
          rsi, hits, rsiOk: hits >= s.minTFs, emaGap: ema ? +((c - ema) / ema * 100).toFixed(3) : null,
          peak: h, pb: 0, pbMin: 0, hi: h, lo: l,
          emaMin: ema != null && l <= ema ? 0 : null, brokeMin: null, brokeAfterEma: false,
        };
        if (!open.has(sym)) open.set(sym, []);
        open.get(sym).push(e);
        openN++;
      }
      return done;
    },

    /** Kart gönderildiğinde çağrılır (temasın ±5 dk içindeki kartlar olaya "kart çıktı" diye yazılır) */
    noteCard(sym, t) {
      const a = cardT.get(sym) || [];
      a.push(t);
      while (a.length && a[0] < t - 2 * window * MIN) a.shift();
      cardT.set(sym, a);
    },

    /** Mum gelmeyen coinlerin süresi dolan olaylarını (kaydetmeden) bırakır, eski bekleme kayıtlarını temizler */
    sweep(now = Date.now()) {
      for (const [sym, arr] of open) {
        for (let k = arr.length - 1; k >= 0; k--) if (now - arr[k].t > (window + 15) * MIN) { arr.splice(k, 1); openN--; }
        if (!arr.length) open.delete(sym);
      }
      for (const [sym, cm] of cool) {
        for (const [k, until] of cm) if (until < now) cm.delete(k);
        if (!cm.size) cool.delete(sym);
      }
      for (const [sym, a] of cardT) if (!a.length || a[a.length - 1] < now - 2 * window * MIN) cardT.delete(sym);
    },

    openCount: () => openN,
  };
}

module.exports = { createTouchTracker, TOUCH_PCT, WINDOW };
