'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

// DB_PATH env var ile override edilebilir (Fly.io volume: /data/signals.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'signals.db');
let db;

function getDb() {
  if (db) return db;

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id              TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      direction       TEXT NOT NULL DEFAULT 'SHORT',
      grade           TEXT,
      score           INTEGER,
      regime          TEXT,
      hasEMC          INTEGER DEFAULT 0,

      entryPrice      REAL,
      initialRiskPct  REAL,

      rsi5m           REAL,
      rsi15m          REAL,
      rsi1h           REAL,
      rsi4h           REAL,

      ema21Distance   REAL,
      volumeRatio     REAL,
      cvdDirection    TEXT,
      oiDeltaPct      REAL,
      fundingRate     REAL,

      dailyResistance REAL,
      dailyEMA200     REAL,

      tpA             REAL,
      tpB             REAL,

      sentAt          INTEGER,

      -- Snapshot fiyatlar
      priceAt5m       REAL,
      priceAt15m      REAL,
      priceAt1h       REAL,
      priceAt4h       REAL,

      -- Trade event
      tpHit           TEXT,       -- 'TP_A' | 'TP_B' | NULL
      tpHitAt         INTEGER,
      slHit           INTEGER DEFAULT 0,
      slHitAt         INTEGER,

      -- Sonuç metrikleri
      mfe             REAL,       -- max favorable excursion (%)
      mae             REAL,       -- max adverse excursion (%)
      pnlPct          REAL,
      rMultiple       REAL,
      holdingTimeMs   INTEGER,

      -- Outcome
      outcome         TEXT,       -- WIN | LOSS | NEUTRAL | LOSS_THEN_RECOVER
      resolvedAt      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol   ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_grade    ON signals(grade);
    CREATE INDEX IF NOT EXISTS idx_signals_outcome  ON signals(outcome);
    CREATE INDEX IF NOT EXISTS idx_signals_sentAt   ON signals(sentAt);
    CREATE INDEX IF NOT EXISTS idx_signals_regime   ON signals(regime);
  `);

  return db;
}

// ── YAZMA ─────────────────────────────────────────────────────────────────

function insertSignal(sig) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO signals (
      id, symbol, direction, grade, score, regime, hasEMC,
      entryPrice, initialRiskPct,
      rsi5m, rsi15m, rsi1h, rsi4h,
      ema21Distance, volumeRatio, cvdDirection, oiDeltaPct, fundingRate,
      dailyResistance, dailyEMA200,
      tpA, tpB, sentAt
    ) VALUES (
      @id, @symbol, @direction, @grade, @score, @regime, @hasEMC,
      @entryPrice, @initialRiskPct,
      @rsi5m, @rsi15m, @rsi1h, @rsi4h,
      @ema21Distance, @volumeRatio, @cvdDirection, @oiDeltaPct, @fundingRate,
      @dailyResistance, @dailyEMA200,
      @tpA, @tpB, @sentAt
    )
  `);
  return stmt.run(sig);
}

function updateSnapshot(id, field, price) {
  const allowed = ['priceAt5m', 'priceAt15m', 'priceAt1h', 'priceAt4h'];
  if (!allowed.includes(field)) throw new Error(`Invalid snapshot field: ${field}`);
  getDb().prepare(`UPDATE signals SET ${field} = ? WHERE id = ?`).run(price, id);
}

function resolveSignal(id, data) {
  const stmt = getDb().prepare(`
    UPDATE signals SET
      tpHit       = @tpHit,
      tpHitAt     = @tpHitAt,
      slHit       = @slHit,
      slHitAt     = @slHitAt,
      mfe         = @mfe,
      mae         = @mae,
      pnlPct      = @pnlPct,
      rMultiple   = @rMultiple,
      holdingTimeMs = @holdingTimeMs,
      outcome     = @outcome,
      resolvedAt  = @resolvedAt
    WHERE id = @id
  `);
  return stmt.run({ ...data, id });
}

// ── OKUMA ─────────────────────────────────────────────────────────────────

function getRecentSignals(limit = 10) {
  return getDb()
    .prepare('SELECT * FROM signals ORDER BY sentAt DESC LIMIT ?')
    .all(limit);
}

function getUnresolved() {
  return getDb()
    .prepare("SELECT * FROM signals WHERE outcome IS NULL AND sentAt > ?")
    .all(Date.now() - 12 * 60 * 60 * 1000); // son 12 saat
}

function getStats() {
  const row = getDb().prepare(`
    SELECT
      COUNT(*)                                          AS total,
      SUM(CASE WHEN outcome = 'WIN'     THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome = 'LOSS'    THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutrals,
      ROUND(AVG(rMultiple), 2)                          AS avgR,
      ROUND(AVG(mfe), 2)                                AS avgMFE,
      ROUND(AVG(mae), 2)                                AS avgMAE
    FROM signals
    WHERE outcome IS NOT NULL
  `).get();
  return row;
}

function getWinrateByGrade() {
  return getDb().prepare(`
    SELECT
      grade,
      COUNT(*) AS total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) AS winPct,
      ROUND(AVG(rMultiple), 2) AS avgR
    FROM signals
    WHERE outcome IS NOT NULL
    GROUP BY grade
    ORDER BY grade
  `).all();
}

function getWinrateByRegime() {
  return getDb().prepare(`
    SELECT
      regime,
      COUNT(*) AS total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) AS winPct,
      ROUND(AVG(rMultiple), 2) AS avgR
    FROM signals
    WHERE outcome IS NOT NULL AND regime IS NOT NULL
    GROUP BY regime
  `).all();
}

function getEMCStats() {
  return getDb().prepare(`
    SELECT
      hasEMC,
      COUNT(*) AS total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) AS winPct
    FROM signals
    WHERE outcome IS NOT NULL
    GROUP BY hasEMC
  `).all();
}

function getBestSymbols(limit = 5) {
  return getDb().prepare(`
    SELECT symbol, COUNT(*) AS total,
      ROUND(100.0 * SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)/COUNT(*),1) AS winPct
    FROM signals WHERE outcome IS NOT NULL
    GROUP BY symbol HAVING COUNT(*) >= 3
    ORDER BY winPct DESC LIMIT ?
  `).all(limit);
}

function getWorstSymbols(limit = 5) {
  return getDb().prepare(`
    SELECT symbol, COUNT(*) AS total,
      ROUND(100.0 * SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)/COUNT(*),1) AS winPct
    FROM signals WHERE outcome IS NOT NULL
    GROUP BY symbol HAVING COUNT(*) >= 3
    ORDER BY winPct ASC LIMIT ?
  `).all(limit);
}

module.exports = {
  getDb,
  insertSignal,
  updateSnapshot,
  resolveSignal,
  getRecentSignals,
  getUnresolved,
  getStats,
  getWinrateByGrade,
  getWinrateByRegime,
  getEMCStats,
  getBestSymbols,
  getWorstSymbols,
};
