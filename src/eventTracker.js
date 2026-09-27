'use strict';

/**
 * Trade Event Tracker
 *
 * Her açık sinyal için:
 *   - +5dk, +15dk, +1h, +4h fiyat snapshot
 *   - TP-A / TP-B hit tespiti
 *   - SL hit tespiti
 *   - MFE (Maximum Favorable Excursion)
 *   - MAE (Maximum Adverse Excursion)
 *   - R-multiple hesabı
 *   - Outcome: WIN | LOSS | NEUTRAL | LOSS_THEN_RECOVER
 */

const cfg = require('./config');
const db  = require('./db');

/**
 * sinyal id → { signal, priceHistory, mfe, mae, slHit, slHitAt }
 */
const openSignals = new Map();

/**
 * Yeni sinyal takibe al
 */
function track(signal) {
  openSignals.set(signal.id, {
    signal,
    priceHistory: [],   // { ts, price }[]
    mfe: 0,             // max favorable excursion (%)
    mae: 0,             // max adverse excursion (%)
    slHit: false,
    slHitAt: null,
    tpHit: null,
    tpHitAt: null,
    snapshotsSent: new Set(),
  });
}

/**
 * Her yeni mum kapandığında tüm açık sinyaller için çağır
 * @param {string} symbol
 * @param {number} currentPrice
 * @param {number} ts - timestamp (ms)
 */
function onPrice(symbol, currentPrice, ts = Date.now()) {
  for (const [id, state] of openSignals) {
    const { signal } = state;
    if (signal.symbol !== symbol) continue;

    state.priceHistory.push({ ts, price: currentPrice });

    // SHORT sinyali için:
    // Favorable = fiyat düştü (kazanç)
    // Adverse   = fiyat yükseldi (kayıp)
    const pctChange = (signal.entryPrice - currentPrice) / signal.entryPrice * 100;

    if (pctChange > state.mfe) state.mfe = pctChange;
    if (pctChange < -state.mae) state.mae = Math.abs(pctChange);

    // TP hit kontrolü (SHORT: fiyat düşer)
    // tpA ve tpB her ikisi de dolu ve tpB < tpA ise:
    //   önce tpA kontrol et (yakın hedef), sonra tpB (derin hedef)
    // Her tick'te en son state.tpHit güncellenir (daha derin hedefe upgrade)
    // Güvence: SHORT'ta TP girişin ALTINDA olmalı. Eski sürümde TP-A girişin üstüne
    // düşebiliyordu → fiyat hiç kıpırdamadan WIN yazılıyordu. Böyle bir TP yok sayılır.
    if (signal.tpA != null && signal.tpA < signal.entryPrice && currentPrice <= signal.tpA) {
      if (!state.tpHit) {
        state.tpHit   = 'TP_A';
        state.tpHitAt = ts;
      }
    }
    if (signal.tpB != null && signal.tpB < signal.entryPrice && currentPrice <= signal.tpB) {
      // TP-B daha derin → upgrade et
      state.tpHit   = 'TP_B';
      state.tpHitAt = ts;
    }

    // SL hit: +1% yukarı giderse SL (varsayılan, config'den alınabilir)
    const slLevel = signal.entryPrice * (1 + (signal.initialRiskPct / 100));
    if (!state.slHit && currentPrice >= slLevel) {
      state.slHit   = true;
      state.slHitAt = ts;
    }

    // Snapshot pencereleri
    const elapsed = ts - signal.sentAt;
    const windows = {
      5:    'priceAt5m',
      15:   'priceAt15m',
      60:   'priceAt1h',
      240:  'priceAt4h',
    };
    for (const [mins, field] of Object.entries(windows)) {
      const ms = mins * 60 * 1000;
      if (elapsed >= ms && !state.snapshotsSent.has(field)) {
        state.snapshotsSent.add(field);
        db.updateSnapshot(id, field, currentPrice);
      }
    }

    // Çözüm kontrolü
    _tryResolve(id, state, ts);
  }
}

function _tryResolve(id, state, ts) {
  const { signal } = state;
  const elapsed = ts - signal.sentAt;
  const MAX_HOLD = 4 * 60 * 60 * 1000; // 4 saat

  // Erken çözüm: SL+TP ikisi de geldiyse sıraya bak
  if (state.slHit && state.tpHit) {
    if (state.slHitAt < state.tpHitAt) {
      // SL önce, sonra TP → LOSS_THEN_RECOVER
      _resolve(id, state, ts, 'LOSS_THEN_RECOVER');
    } else {
      // TP önce (normal WIN)
      _resolve(id, state, ts, 'WIN');
    }
    return;
  }

  // Sadece TP hit → WIN
  if (state.tpHit && !state._resolved) {
    _resolve(id, state, ts, 'WIN');
    return;
  }

  // Sadece SL hit (TP gelmedi)
  if (state.slHit && !state.tpHit) {
    _resolve(id, state, ts, 'LOSS');
    return;
  }

  // 4h geçti, ne TP ne SL
  if (elapsed >= MAX_HOLD) {
    const last = state.priceHistory.length
      ? state.priceHistory[state.priceHistory.length - 1].price
      : signal.entryPrice;
    const pct = (signal.entryPrice - last) / signal.entryPrice * 100;

    let outcome;
    if (pct > 0.3)       outcome = 'WIN';
    else if (pct < -0.3) outcome = 'LOSS';
    else                 outcome = 'NEUTRAL';

    _resolve(id, state, ts, outcome);
  }
}

function _resolve(id, state, ts, outcome) {
  const { signal } = state;
  if (openSignals.has(id) && !state._resolved) {
    state._resolved = true;

    const last = state.priceHistory.length
      ? state.priceHistory[state.priceHistory.length - 1].price
      : signal.entryPrice;

    const pnlPct       = (signal.entryPrice - last) / signal.entryPrice * 100;
    const rMultiple    = signal.initialRiskPct > 0
      ? pnlPct / signal.initialRiskPct
      : null;
    const holdingTimeMs = ts - signal.sentAt;

    db.resolveSignal(id, {
      tpHit:        state.tpHit,
      tpHitAt:      state.tpHitAt,
      slHit:        state.slHit ? 1 : 0,
      slHitAt:      state.slHitAt,
      mfe:          +state.mfe.toFixed(4),
      mae:          +state.mae.toFixed(4),
      pnlPct:       +pnlPct.toFixed(4),
      rMultiple:    rMultiple !== null ? +rMultiple.toFixed(3) : null,
      holdingTimeMs,
      outcome,
      resolvedAt:   ts,
    });

    openSignals.delete(id);
    console.log(`[TRACKER] ${id} → ${outcome} | R: ${rMultiple?.toFixed(2)} | MFE: ${state.mfe.toFixed(2)}% | MAE: ${state.mae.toFixed(2)}%`);
  }
}

/**
 * Başlangıçta çözülmemiş sinyalleri DB'den yükle
 */
function loadPending() {
  const pending = db.getUnresolved();
  for (const sig of pending) {
    if (!openSignals.has(sig.id)) {
      track({
        ...sig,
        rsi: { '5m': sig.rsi5m, '15m': sig.rsi15m, '1h': sig.rsi1h, '4h': sig.rsi4h },
      });
    }
  }
  console.log(`[TRACKER] ${pending.length} bekleyen sinyal yüklendi.`);
}

module.exports = { track, onPrice, loadPending };
