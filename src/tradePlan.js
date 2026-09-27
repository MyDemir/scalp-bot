'use strict';

/**
 * SHORT işlem planı: TP-A, TP-B, SL
 *
 * Canlı bot (signalEngine) ve backtest AYNI fonksiyonu kullanır.
 *
 *   TP-A = EMA21 + %0.15   (EMA21'e yaklaşma hedefi)
 *   TP-B = EMA21 - 0.3×ATR (derin hedef)
 *   SL   = giriş × (1 + initialRiskPct/100)
 *
 * Geometri kuralı (SHORT): giriş > TP-A > TP-B
 *
 * Neden plan geçersiz sayılabiliyor:
 *   Kapı "EMA21 uzaklığı ≥ 0.5 ATR" diyor, ama TP-A EMA21'in %0.15 ÜSTÜNDE.
 *   Düşük volatiliteli coinlerde (ATR ≈ %0.1–0.2) uzaklık %0.15'ten az kalabiliyor
 *   → TP-A girişin ÜSTÜNE düşüyordu. Tracker ilk fiyat güncellemesinde
 *   "fiyat ≤ TP-A" görüp fiyat hiç kıpırdamadan WIN yazıyordu (sahte kazanç).
 *   Bu durumda EMA21'e doğru kazanılacak alan yok → sinyal gönderilmez.
 */

const { roundPx } = require('./levels');

/**
 * @param {object} p
 * @param {number}      p.entryPrice
 * @param {number|null} p.ema21
 * @param {number|null} p.atr
 * @param {number}      p.initialRiskPct
 * @returns {{ valid: true, tpA: number, tpB: number|null, slLevel: number }
 *         | { valid: false, reason: string }}
 */
function calcTradePlan({ entryPrice, ema21, atr, initialRiskPct }) {
  if (ema21 == null || !Number.isFinite(ema21)) {
    return { valid: false, reason: 'EMA21 hesaplanamadı — TP-A yok' };
  }

  const tpA = roundPx(ema21 * 1.0015);

  if (tpA >= entryPrice) {
    const roomPct = ((entryPrice - ema21) / ema21 * 100).toFixed(3);
    return {
      valid:  false,
      reason: `TP-A (${tpA}) girişin (${entryPrice}) üstünde/eşit — EMA21'e alan yok (uzaklık %${roomPct} < %0.15)`,
    };
  }

  const rawTpB = atr != null && Number.isFinite(atr) ? roundPx(ema21 - atr * 0.3) : null;
  const tpB    = rawTpB != null && rawTpB < tpA ? rawTpB : null;
  const slLevel = roundPx(entryPrice * (1 + initialRiskPct / 100));

  return { valid: true, tpA, tpB, slLevel };
}

module.exports = { calcTradePlan };
