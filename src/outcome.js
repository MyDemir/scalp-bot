'use strict';

/**
 * İşlem sonucu motoru — canlı tracker ve backtest AYNI kuralları kullanır.
 *
 * SHORT sinyal için kurallar:
 *   • TP-A'ya SL'den ÖNCE değerse           → WIN   (çıkış fiyatı = TP-A)
 *   • SL'ye TP-A'dan ÖNCE değerse           → LOSS  (çıkış fiyatı = SL)
 *   • Aynı fiyat çubuğunda ikisi birden      → LOSS  (sıra bilinmiyor → muhafazakâr)
 *   • Önce SL, sonra TP-A                   → LOSS_THEN_RECOVER (çıkış = SL; stop olmuştun)
 *   • 4 saatte ikisine de değmezse          → son fiyata göre: >+%0.3 WIN, <−%0.3 LOSS, arası NEUTRAL
 *
 * Sonuç belirlendikten sonra izleme 4 saat dolana ya da TP-B görülene kadar sürer:
 *   TP-B'ye ulaşılıp ulaşılmadığı ve MFE/MAE bu pencere boyunca kaydedilir (sonucu DEĞİŞTİRMEZ).
 *
 * pnlPct ve rMultiple ÇIKIŞ fiyatından hesaplanır (eskiden 4 saat sonraki fiyattan hesaplanıyordu).
 *
 * Bu modülün yan etkisi yok — saf fonksiyonlar.
 */

const HOLD_MS = 4 * 60 * 60 * 1000;
const TIMEOUT_WIN_PCT  =  0.3;
const TIMEOUT_LOSS_PCT = -0.3;

/**
 * @param {object} p
 * @param {number}      p.entryPrice
 * @param {number}      p.tpA
 * @param {number|null} p.tpB
 * @param {number}      p.slLevel
 * @param {number}      p.initialRiskPct
 * @param {number}      p.sentAt       - sinyal zamanı (ms)
 * @param {object}     [p.restore]     - DB'den geri yükleme (yeniden başlatma sonrası)
 */
function createTrade({ entryPrice, tpA, tpB = null, slLevel, initialRiskPct, sentAt, restore = {} }) {
  return {
    entryPrice, tpA, tpB, slLevel, initialRiskPct, sentAt,
    tpAHitAt:    restore.tpAHitAt    ?? null,
    tpBHitAt:    restore.tpBHitAt    ?? null,
    slHitAt:     restore.slHitAt     ?? null,
    outcome:     restore.outcome     ?? null,
    exitPrice:   restore.exitPrice   ?? null,
    pnlPct:      restore.pnlPct      ?? null,
    rMultiple:   restore.rMultiple   ?? null,
    resolvedAt:  restore.resolvedAt  ?? null,
    finalizedAt: restore.finalizedAt ?? null,
    mfe:         restore.mfe         ?? 0,
    mae:         restore.mae         ?? 0,
    lastPrice:   restore.lastPrice   ?? entryPrice,
  };
}

function _setOutcome(t, outcome, exitPrice, ts) {
  t.outcome    = outcome;
  t.exitPrice  = exitPrice;
  t.pnlPct     = +((t.entryPrice - exitPrice) / t.entryPrice * 100).toFixed(4);
  t.rMultiple  = t.initialRiskPct > 0 ? +(t.pnlPct / t.initialRiskPct).toFixed(3) : null;
  t.resolvedAt = ts;
}

/**
 * Bir fiyat çubuğunu uygula.
 *   Canlı: her 5m kline güncellemesi (mum sinyalden sonra açıldıysa high/low, değilse son fiyat)
 *   Backtest: sinyalden sonraki her 5m mum (ts = mumun kapanış anı)
 *
 * @param {object} t   createTrade() çıktısı (yerinde güncellenir)
 * @param {{ts:number, high:number, low:number, close:number}} bar
 * @returns {{ outcomeChanged: boolean, finalized: boolean }}
 */
function applyBar(t, { ts, high, low, close }) {
  const ev = { outcomeChanged: false, finalized: false };
  if (t.finalizedAt != null) return ev;

  // MFE/MAE (SHORT: düşüş lehte, yükseliş aleyhte)
  const fav = (t.entryPrice - low)  / t.entryPrice * 100;
  const adv = (high - t.entryPrice) / t.entryPrice * 100;
  if (fav > t.mfe) t.mfe = +fav.toFixed(4);
  if (adv > t.mae) t.mae = +adv.toFixed(4);
  t.lastPrice = close;

  // Seviye geçişleri — TP-B, TP-A'nın altında olduğundan TP-B'yi geçmek TP-A'yı da geçmek demek
  if (t.slHitAt  == null && high >= t.slLevel) t.slHitAt = ts;
  if (t.tpB != null && t.tpBHitAt == null && low <= t.tpB) t.tpBHitAt = ts;
  if (t.tpAHitAt == null && (low <= t.tpA || t.tpBHitAt != null)) t.tpAHitAt = ts;

  // ── Sonuç ──
  if (t.outcome == null) {
    if (t.tpAHitAt != null && t.slHitAt != null) {
      if (t.slHitAt === t.tpAHitAt)     _setOutcome(t, 'LOSS', t.slLevel, t.slHitAt);            // aynı çubuk → sıra bilinmiyor
      else if (t.tpAHitAt < t.slHitAt)  _setOutcome(t, 'WIN', t.tpA, t.tpAHitAt);                // önce TP-A
      else                              _setOutcome(t, 'LOSS_THEN_RECOVER', t.slLevel, t.slHitAt); // önce SL, sonra TP-A
      ev.outcomeChanged = true;
    } else if (t.tpAHitAt != null) {
      _setOutcome(t, 'WIN', t.tpA, t.tpAHitAt);
      ev.outcomeChanged = true;
    } else if (t.slHitAt != null) {
      _setOutcome(t, 'LOSS', t.slLevel, t.slHitAt);
      ev.outcomeChanged = true;
    }
  } else if (t.outcome === 'LOSS' && t.tpAHitAt != null && t.tpAHitAt > t.slHitAt) {
    // Stop olduktan sonra fiyat TP-A'ya döndü — çıkış yine SL'de, sadece etiket değişir
    t.outcome = 'LOSS_THEN_RECOVER';
    ev.outcomeChanged = true;
  }

  // ── İzlemenin sonu: TP-B görüldü ya da 4 saat doldu ──
  const timedOut = ts - t.sentAt >= HOLD_MS;
  if (t.tpBHitAt != null || timedOut) {
    if (t.outcome == null) {
      const pnl = (t.entryPrice - close) / t.entryPrice * 100;
      const oc  = pnl > TIMEOUT_WIN_PCT ? 'WIN' : pnl < TIMEOUT_LOSS_PCT ? 'LOSS' : 'NEUTRAL';
      _setOutcome(t, oc, close, ts);
      ev.outcomeChanged = true;
    }
    t.finalizedAt = ts;
    ev.finalized  = true;
  }

  return ev;
}

/** Sonuç: sinyalden sonucun belli olduğu ana kadar geçen süre */
function holdingTimeMs(t) {
  return t.resolvedAt != null ? t.resolvedAt - t.sentAt : null;
}

/** DB/rapor için düz kayıt */
function toRecord(t) {
  const tpHit = t.tpBHitAt != null ? 'TP_B' : t.tpAHitAt != null ? 'TP_A' : null;
  return {
    outcome:       t.outcome,
    tpHit,
    tpHitAt:       t.tpAHitAt,
    tpBHitAt:      t.tpBHitAt,
    slHit:         t.slHitAt != null ? 1 : 0,
    slHitAt:       t.slHitAt,
    exitPrice:     t.exitPrice,
    pnlPct:        t.pnlPct,
    rMultiple:     t.rMultiple,
    mfe:           t.mfe,
    mae:           t.mae,
    holdingTimeMs: holdingTimeMs(t),
    resolvedAt:    t.resolvedAt,
    finalizedAt:   t.finalizedAt,
  };
}

module.exports = { createTrade, applyBar, toRecord, HOLD_MS };
