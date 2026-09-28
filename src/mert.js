'use strict';

/**
 * Mert varyantı — Mert'in kendi anlatımına göre kurallar.
 * ŞİMDİLİK YALNIZCA BACKTEST'TE (--compare) kullanılır; canlı botun kararını değiştirmez.
 *
 *   Yer     : Fiyat bir direnç seviyesinin dibinde: seviyenin altında en fazla %belowPct,
 *             üstünde en fazla %abovePct (fitil payı). Seviyeyi aşıp yukarıda duruyorsa sinyal yok.
 *             Seviyeler: 4h MA200, 4h EMA200, 1d MA200, 1d EMA200, günlük majör direnç.
 *   Karar   : 3m / 5m / 15m RSI'lardan en az minTFs tanesi ≥ rsiMin (üst sınır yok; rsiCap verilirse uygulanır)
 *   Güven   : 1h RSI ≥ rsi1hMin → +1, 4h RSI ≥ rsi4hMin → +1 (0–2). ZORUNLU DEĞİL — sinyale yazılır,
 *             raporda sonuçlar güven puanına göre ayrılır
 *   Ayrışma : Fiyat 3m VE 5m EMA21'den ≥ separationATR × ATR uzakta, iki TF'de de son 3 mumda
 *             EMA21 dokunuşu yok ("3 ve 5 dk EMA21'den ayrıştığını görmek şart")
 *   Plan    : TP-A = 3m EMA21 ("düşüşte 3dk EMA21'e yaklaştığında TP")
 *             TP-B = 5m EMA21 (TP-A'dan sonra ulaşılıp ulaşılmadığı izlenir)
 *             SL   = giriş × (1 + slPct/100) ("stop genelde %1–1.5")
 *   Yönetim : Aynı coinde açık işlem varken yeni işlem açılmaz (bir hareket = bir işlem).
 *
 * Bu modülün yan etkisi yok (ağ/DB/Telegram açmaz) — saf fonksiyonlar.
 */

const cfg = require('./config');
const { roundPx, calcLevelSet } = require('./levels');

/** Test edilecek kombinasyonlar (aşırı uydurmayı önlemek için küçük tutuldu) */
function mertVariants() {
  const m = cfg.mert;
  const out = [];
  for (const rsiMin of m.grid.rsiMin) {
    for (const minTFs of m.grid.minTFs) {
      for (const slPct of m.grid.slPct) {
        out.push({
          key: `mert_${rsiMin}_${minTFs}_${String(slPct).replace('.', '')}`,
          kind: 'mert',
          rsiMin, minTFs, slPct,
          // backtest karar anları: 3m ve 5m kapanışları (15m kapanışları ikisinin de katı)
          rsiTFs: m.rsiTFs, entryTF: '3m',
          label: `RSI ≥ ${rsiMin} (${minTFs}/${m.rsiTFs.length} TF) · SL %${slPct}`,
          short: `${rsiMin} ${minTFs}/${m.rsiTFs.length} ${slPct.toFixed(1)}`,
        });
      }
    }
  }
  return out;
}

/**
 * Fiyat bir seviyenin dibinde mi? (altında ≤ belowPct, üstünde ≤ abovePct)
 * @returns {{ name, value, distPct } | null}  en yakın uygun seviye; distPct > 0 → seviyenin üstünde
 */
function locate(price, levels, belowPct = cfg.mert.levelBelowPct, abovePct = cfg.mert.levelAbovePct) {
  let best = null;
  for (const l of levels) {
    const distPct = (price - l.value) / l.value * 100;
    if (distPct < -belowPct || distPct > abovePct) continue;
    if (!best || Math.abs(distPct) < Math.abs(best.distPct)) best = { ...l, distPct };
  }
  return best;
}

/** Karar: kaç TF eşiği geçti ve üst sınır aşıldı mı */
function rsiCheck(v, r) {
  const m = cfg.mert;
  const hits = m.rsiTFs.filter(tf => r['rsi' + tf] >= v.rsiMin).length;
  const capped = m.rsiCap != null && m.capTFs.some(tf => r['rsi' + tf] > m.rsiCap);
  return { hits, capped, pass: hits >= v.minTFs && !capped };
}

/** Güven puanı (0–2): 1h ve 4h RSI şişkinliği — karar vermez, yalnızca kaydedilir */
function confidence(r1h, r4h) {
  return (r1h >= cfg.mert.rsi1hMin ? 1 : 0) + (r4h >= cfg.mert.rsi4hMin ? 1 : 0);
}

/** Ayrışma: 3m ve 5m EMA21'den uzak, dokunuş yok */
function separationOk(ind3m, ind5m) {
  const k = cfg.mert.separationATR;
  return ind3m.distance >= k && !ind3m.touched && ind5m.distance >= k && !ind5m.touched;
}

/** İşlem planı: TP-A 3m EMA21, TP-B 5m EMA21, SL yüzde */
function makePlan(price, ema21_3m, ema21_5m, slPct) {
  const tpA = roundPx(ema21_3m);
  if (!(tpA < price)) return { valid: false, reason: 'TP-A girişin altında değil' };
  const tpB = Number.isFinite(ema21_5m) && ema21_5m < tpA ? roundPx(ema21_5m) : null;
  return { valid: true, tpA, tpB, slLevel: roundPx(price * (1 + slPct / 100)) };
}

module.exports = { mertVariants, calcLevelSet, locate, rsiCheck, confidence, separationOk, makePlan };
