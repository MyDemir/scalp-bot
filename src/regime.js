'use strict';

/**
 * Market Regime Tespiti
 *
 * REVERSAL          → Aşırı gerilen fiyat geri döner — SHORT sinyali geçerli
 * CONTINUATION      → Güçlü momentum devam ediyor — SHORT sinyali iptal
 * NEUTRAL           → Belirsiz
 *
 * 5 gösterge kombinasyonu ile karar verilir:
 *   1. CVD yönü
 *   2. OI delta
 *   3. Candle body oranı (son 3 mum ortalaması)
 *   4. Volume ivmesi
 *   5. Fiyat / VWAP farkı (opsiyonel, varsa kullanılır)
 */

/**
 * @param {object} indicators  - indicators.js computeAll() çıktısı
 * @param {number|null} oiDeltaPct - OI değişim % (pozitif = arttı)
 * @param {number|null} fundingRate
 * @param {object[]} candles   - son 5m mumlar
 * @returns {'REVERSAL' | 'CONTINUATION' | 'NEUTRAL'}
 */
function detectRegime({ indicators, oiDeltaPct, fundingRate, candles }) {
  let reversalScore     = 0;
  let continuationScore = 0;

  // ── 1. CVD ────────────────────────────────────────────
  // Satıcı baskısı artıyorsa → reversal teyidi
  if (indicators.cvdDir === 'NEGATIVE') reversalScore     += 2;
  if (indicators.cvdDir === 'POSITIVE') continuationScore += 2;

  // ── 2. OI Delta ───────────────────────────────────────
  // OI artıyor + short signal → yeni short pozisyonları açılıyor (reversal güçlü)
  // OI artıyor + long baskısı → continuation
  if (oiDeltaPct !== null && oiDeltaPct !== undefined) {
    if (oiDeltaPct > 0.5) {
      // SHORT sinyali bağlamında OI artışı → reversal teyidi (yeni shortlar açılıyor)
      reversalScore += 1;
    } else if (oiDeltaPct < -0.5) {
      // Short kapanıyor → continuation (long momentum)
      continuationScore += 1;
    }
  }

  // ── 3. Candle body oranı (son 3 mum) ──────────────────
  // Küçük body → alıcı enerjisi tükeniyor → reversal
  // Büyük body → güçlü momentum → continuation
  if (candles && candles.length >= 3) {
    const recent = candles.slice(-3);
    const avgBody = recent.reduce((s, c) => {
      const total = c.high - c.low;
      return s + (total > 0 ? Math.abs(c.close - c.open) / total : 0);
    }, 0) / 3;

    if (avgBody < 0.35) reversalScore     += 2; // küçük body → tereddüt / tükenme
    if (avgBody > 0.65) continuationScore += 2; // büyük body → momentum devam
  }

  // ── 4. Volume ivmesi ──────────────────────────────────
  // Volume spike oldu ama azalıyorsa → pump bitti → reversal
  // Volume hâlâ artıyorsa → continuation
  if (indicators.volAccel !== undefined) {
    if (indicators.volAccel < -0.2) reversalScore     += 1; // volume azalıyor
    if (indicators.volAccel >  0.3) continuationScore += 1; // volume artıyor
  }

  // ── 5. Volume ratio ───────────────────────────────────
  // Aşırı yüksek volume (spike) → pump sona yakın → reversal olasılığı
  if (indicators.volRatio > 4) reversalScore += 1;

  // ── KARAR ─────────────────────────────────────────────
  const total = reversalScore + continuationScore;
  if (total === 0) return 'NEUTRAL';

  const reversalPct = reversalScore / total;

  if (reversalPct >= 0.60) return 'REVERSAL';
  if (reversalPct <= 0.35) return 'CONTINUATION';
  return 'NEUTRAL';
}

/**
 * Momentum continuation rejiminde SHORT sinyali iptal edilmeli mi?
 */
function shouldBlockSignal(regime) {
  return regime === 'CONTINUATION';
}

module.exports = { detectRegime, shouldBlockSignal };
