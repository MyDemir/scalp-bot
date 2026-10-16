'use strict';

const assert = require('assert');
const { Series, KEEP, MIN } = require('../src/series');
const binance = require('../src/binanceClient');
const infoBot = require('../src/infoBot');

const internal = infoBot._internal;
const minimum = { '1m': 25, '3m': 60, '5m': 60, '15m': 40, '1h': 15, '4h': 0, '1d': 0 };

function makeReadySeries(symbol, lastT) {
  const sr = new Series(symbol);
  for (const [tf, count] of Object.entries(minimum)) {
    if (!count) continue;
    const start = tf === '1m' ? lastT - (count - 1) * MIN : Date.now() - count * MIN;
    const candles = Array.from({ length: count }, (_, i) => ({
      t: start + i * MIN, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true,
    }));
    sr.seed(tf, candles);
  }
  assert(sr.ready(), `${symbol} fixture must be ready`);
  return sr;
}

function rawCandles(startT, count) {
  return Array.from({ length: count }, (_, i) => {
    const t = startT + i * MIN;
    return [t, '101', '102', '100', '101.5', '10', t + MIN - 1, '1015', 0, '4', '406'];
  });
}

async function main() {
  const originalFetch = binance.fetchKlines;
  const symbols = Array.from({ length: 8 }, (_, i) => `GAPTEST${i}USDT`);
  const now = Math.floor(Date.now() / MIN) * MIN;
  const lastT = now - 5 * MIN;
  let active = 0;
  let peak = 0;
  const expectedCandles = 3;

  try {
    for (const sym of symbols) {
      internal.series.set(sym, makeReadySeries(sym, lastT));
      internal.busy.delete(sym);
      internal.pending.delete(sym);
    }

    binance.fetchKlines = async (symbol, interval) => {
      assert.strictEqual(interval, '1m');
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--;
      return rawCandles(lastT + MIN, expectedCandles);
    };

    await internal.backfillGap(symbols, Date.now() - 2 * MIN);

    assert(peak > 1, `backfill should perform bounded concurrent requests; observed ${peak}`);
    assert(peak <= 4, `backfill concurrency must never exceed 4; observed ${peak}`);
    for (const sym of symbols) {
      const sr = internal.series.get(sym);
      assert.strictEqual(sr.lastT('1m'), lastT + expectedCandles * MIN, `${sym} should recover all missing candles`);
      assert.strictEqual(sr.count('1m'), minimum['1m'] + expectedCandles, `${sym} should not duplicate recovered candles`);
      assert.strictEqual(internal.busy.has(sym), false, `${sym} must be released after recovery`);
      assert.strictEqual(internal.pending.has(sym), false, `${sym} pending buffer must be flushed`);
    }
    assert.strictEqual(internal.gapMetrics.lastRecoveredCandles, symbols.length * expectedCandles);
    assert.strictEqual(internal.gapMetrics.lastFailures, 0);
    assert.strictEqual(internal.gapMetrics.lastPeakConcurrency, peak);
    assert(internal.gapMetrics.lastFetchMs >= 0);
    assert(internal.gapMetrics.lastProcessMs >= 0);
    assert(internal.gapMetrics.lastDurationMs >= 0);
    console.log(`PASS: bounded backfill concurrency (${peak}), ${internal.gapMetrics.lastRecoveredCandles} recovered candles, no duplicates or stuck busy flags`);
  } finally {
    binance.fetchKlines = originalFetch;
    for (const sym of symbols) {
      internal.series.delete(sym);
      internal.busy.delete(sym);
      internal.pending.delete(sym);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
