'use strict';

/**
 * Trade Event Tracker — canlı sinyalleri outcome.js kurallarıyla takip eder
 *
 * Her açık sinyal için:
 *   - Sonuç: WIN | LOSS | LOSS_THEN_RECOVER | NEUTRAL (kurallar outcome.js'te, backtest ile ortak)
 *   - TP-A'da WIN yazılır; ardından 4 saat boyunca TP-B'ye ulaşılıp ulaşılmadığı izlenir
 *   - MFE / MAE, çıkış fiyatından pnl ve R-multiple
 *   - +5dk, +15dk, +1h, +4h fiyat snapshot'ları
 *
 * Bellek: fiyat geçmişi TUTULMAZ (eski sürüm her güncellemeyi diziye ekliyordu:
 * açık sinyal başına 4 saatte ~14 MB). Sadece sinyal başına sabit boyutlu durum saklanır.
 */

const db = require('./db');
const { createTrade, applyBar, toRecord, HOLD_MS } = require('./outcome');

const FIVE_MIN = 5 * 60 * 1000;
const SNAPSHOTS = [
  [5   * 60 * 1000, 'priceAt5m'],
  [15  * 60 * 1000, 'priceAt15m'],
  [60  * 60 * 1000, 'priceAt1h'],
  [240 * 60 * 1000, 'priceAt4h'],
];

/** symbol → Map(id → state) */
const bySymbol = new Map();

function openCount() {
  let n = 0;
  for (const m of bySymbol.values()) n += m.size;
  return n;
}

/**
 * Yeni sinyali takibe al
 * @param {object} signal  - signalEngine sinyal objesi (entryPrice, tpA, tpB, slLevel, initialRiskPct, sentAt)
 * @param {object} [restore] - DB'den geri yüklenen durum
 */
function track(signal, restore = {}) {
  const slLevel = signal.slLevel ?? signal.entryPrice * (1 + signal.initialRiskPct / 100);
  const state = {
    id:     signal.id,
    symbol: signal.symbol,
    // Sinyal, 5m mum kapanışında üretilir → o kapanıştan SONRA açılan mumlar tamamen sinyal sonrasıdır
    decisionAt: Math.floor(signal.sentAt / FIVE_MIN) * FIVE_MIN,
    trade: createTrade({
      entryPrice:     signal.entryPrice,
      tpA:            signal.tpA,
      tpB:            signal.tpB ?? null,
      slLevel,
      initialRiskPct: signal.initialRiskPct,
      sentAt:         signal.sentAt,
      restore,
    }),
    snapshotsDone: new Set(restore.snapshotsDone ?? []),
  };

  // Güvence: SHORT'ta TP girişin ALTINDA olmalı. Eski sürümde TP-A girişin üstüne düşebiliyordu
  // → fiyat hiç kıpırdamadan WIN yazılıyordu. Böyle bir TP'ye asla ulaşılamaz sayılır.
  if (!(state.trade.tpA < state.trade.entryPrice)) state.trade.tpA = -Infinity;
  if (state.trade.tpB != null && !(state.trade.tpB < state.trade.entryPrice)) state.trade.tpB = null;

  if (!bySymbol.has(signal.symbol)) bySymbol.set(signal.symbol, new Map());
  bySymbol.get(signal.symbol).set(signal.id, state);
}

/**
 * 5m kline güncellemesiyle çağrılır.
 * @param {string} symbol
 * @param {{ price:number, high?:number, low?:number, candleStart?:number }} tick
 * @param {number} ts
 */
function onPrice(symbol, tick, ts = Date.now()) {
  const open = bySymbol.get(symbol);
  if (!open || open.size === 0) return;

  const { price } = tick;
  for (const [id, st] of open) {
    // Mum tamamen sinyalden sonra açıldıysa high/low'u kullan (güncellemeler arası fitilleri yakalar);
    // aksi halde mumun sinyal öncesi kısmı karışmasın diye yalnızca son fiyat.
    const useRange = tick.candleStart != null && tick.candleStart >= st.decisionAt
                     && Number.isFinite(tick.high) && Number.isFinite(tick.low);
    const bar = useRange
      ? { ts, high: Math.max(tick.high, price), low: Math.min(tick.low, price), close: price }
      : { ts, high: price, low: price, close: price };

    const ev = applyBar(st.trade, bar);

    // Snapshot pencereleri
    const elapsed = ts - st.trade.sentAt;
    for (const [ms, field] of SNAPSHOTS) {
      if (elapsed >= ms && !st.snapshotsDone.has(field)) {
        st.snapshotsDone.add(field);
        db.updateSnapshot(id, field, price);
      }
    }

    if (ev.outcomeChanged || ev.finalized) {
      db.saveTrade(id, toRecord(st.trade));
    }
    if (ev.outcomeChanged) {
      const t = st.trade;
      console.log(`[TRACKER] ${id} → ${t.outcome} | çıkış ${t.exitPrice} | R: ${t.rMultiple} | MFE: ${t.mfe}% | MAE: ${t.mae}%`);
    }
    if (ev.finalized) {
      const t = st.trade;
      console.log(`[TRACKER] ${id} izleme bitti | ${t.outcome} | TP-B: ${t.tpBHitAt ? 'ulaşıldı' : 'ulaşılmadı'} | MFE: ${t.mfe}%`);
      open.delete(id);
    }
  }
  if (open.size === 0) bySymbol.delete(symbol);
}

/**
 * Başlangıçta izlemesi bitmemiş sinyalleri DB'den yükle (sonuç/TP/SL durumlarıyla)
 */
function loadPending() {
  // 4 saatlik pencere dolmuşsa kopukluk sırasında ne olduğunu bilemeyiz — sonuç uydurmadan kapat
  const closed = db.closeStale(HOLD_MS);
  const pending = db.getUnresolved();

  for (const row of pending) {
    const snapshotsDone = SNAPSHOTS.map(([, f]) => f).filter(f => row[f] != null);
    track(row, {
      tpAHitAt:    row.tpHitAt,
      tpBHitAt:    row.tpBHitAt,
      slHitAt:     row.slHitAt,
      outcome:     row.outcome,
      exitPrice:   row.exitPrice,
      pnlPct:      row.pnlPct,
      rMultiple:   row.rMultiple,
      resolvedAt:  row.resolvedAt,
      finalizedAt: null,
      mfe:         row.mfe ?? 0,
      mae:         row.mae ?? 0,
      snapshotsDone,
    });
  }
  console.log(`[TRACKER] ${pending.length} açık sinyal yüklendi${closed ? `, ${closed} eski kayıt kapatıldı` : ''}.`);
}

module.exports = { track, onPrice, loadPending, openCount };
