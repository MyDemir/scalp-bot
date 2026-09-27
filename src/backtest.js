'use strict';

/**
 * Backtest Motoru — Scalp Sinyal Motoru
 *
 * Amacı:
 *   1. Binance REST'ten geçmiş kline verisi çek (her sembol × TF)
 *   2. Her 5m mumda sinyal motoru mantığını replay et
 *   3. Sinyal üretildiğinde ileriye dönük mumlarla TP/SL simüle et
 *   4. Grade / Regime / EMC bazında win rate tablosu yaz
 *
 * Çalıştırma:
 *   node src/backtest.js
 *   node src/backtest.js --symbol BTCUSDT --days 90
 *   node src/backtest.js --symbol ETHUSDT,SOLUSDT --days 30 --min-score 55
 *
 * Çıktı: backtest-results/ klasörüne JSON + konsol özeti
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const cfg            = require('./config');
const { restClient } = require('./binanceClient');
const { computeAll } = require('./indicators');
const { detectRegime }  = require('./regime');
const { checkGates }    = require('./gates');
const { calcScore }     = require('./scorer');

// ── CLI argümanları ─────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const SYMBOLS     = args.symbol
  ? args.symbol.split(',').map(s => s.trim().toUpperCase())
  : cfg.testSymbols;

const DAYS        = parseInt(args.days    || 90, 10);
const MIN_SCORE   = parseInt(args['min-score'] || cfg.minScoreToSend, 10);
const CANDLE_LIMIT = Math.min(1000, DAYS * 288 + 50); // 288 mum/gün (5m)

const OUT_DIR = path.join(__dirname, '..', 'backtest-results');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Ana fonksiyon ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n════════════════════════════════════════════');
  console.log('  Scalp Bot — Backtest Motoru');
  console.log(`  Semboller  : ${SYMBOLS.join(', ')}`);
  console.log(`  Gün        : ${DAYS}  |  Min skor: ${MIN_SCORE}`);
  console.log('════════════════════════════════════════════\n');

  const allResults = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n[${symbol}] Veri çekiliyor...`);
    const result = await backtestSymbol(symbol);
    allResults.push(...result);
    printSymbolSummary(symbol, result);
  }

  // ── Genel rapor ─────────────────────────────────────────────────────────
  console.log('\n\n════════════════════════════════════════════');
  console.log('  GENEL RAPOR');
  console.log('════════════════════════════════════════════');

  printGradeBreakdown(allResults);
  printRegimeBreakdown(allResults);
  printEMCBreakdown(allResults);
  printScoreCalibration(allResults);

  // JSON çıktı
  const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19);
  const outFile   = path.join(OUT_DIR, `backtest-${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(allResults, null, 2));
  console.log(`\n📁 Detaylı sonuçlar: ${outFile}\n`);
}

// ── Sembol Backtest ─────────────────────────────────────────────────────────

async function backtestSymbol(symbol) {
  // Tüm TF verilerini çek
  const [candles5m, candles15m, candles1h, candles4h, candles1d] = await Promise.all([
    fetchKlines(symbol, '5m',  CANDLE_LIMIT),
    fetchKlines(symbol, '15m', Math.ceil(CANDLE_LIMIT / 3)),
    fetchKlines(symbol, '1h',  Math.ceil(CANDLE_LIMIT / 12)),
    fetchKlines(symbol, '4h',  Math.ceil(CANDLE_LIMIT / 48)),
    fetchKlines(symbol, '1d',  90),
  ]);

  if (candles5m.length < 100) {
    console.warn(`  [${symbol}] Yetersiz 5m veri (${candles5m.length} mum)`);
    return [];
  }

  // Günlük seviye — tüm backtest boyunca sabit (gerçekçi yaklaşım için rolling yapılabilir)
  const daily = calcDailyLevels(candles1d);

  const signals = [];
  const MIN_CANDLES = 50; // her TF için minimum buffer

  // 5m üzerinde kayan pencere — her mumda sinyal motoru çalıştır
  for (let i = MIN_CANDLES; i < candles5m.length; i++) {
    const ts5m = candles5m[i].openTime;

    // Her TF için zaman eşleşmeli slice al
    const slice5m  = candles5m.slice(0, i + 1).slice(-200);
    const slice15m  = getSliceUpToTime(candles15m, ts5m, 200);
    const slice1h   = getSliceUpToTime(candles1h,  ts5m, 200);
    const slice4h   = getSliceUpToTime(candles4h,  ts5m, 200);

    if (slice15m.length < MIN_CANDLES || slice1h.length < MIN_CANDLES) continue;

    const ind5m  = computeAll(slice5m);
    const ind15m = computeAll(slice15m);
    const ind1h  = computeAll(slice1h);
    const ind4h  = slice4h.length >= MIN_CANDLES ? computeAll(slice4h) : null;

    const price  = ind5m.price;
    const rsi5m  = ind5m.rsi;
    const rsi15m = ind15m.rsi;
    const rsi1h  = ind1h.rsi;
    const rsi4h  = ind4h?.rsi ?? null;

    // Günlük yakınlık
    const dailyProximity = Math.max(
      calcDailyProximity(price, daily.ema200),
      calcDailyProximity(price, daily.resistance),
    );
    const nearDailyLevel = dailyProximity >= 0.3;

    // Regime (backtest'te OI/funding yok — null geçiyoruz)
    const regime = detectRegime({
      indicators:  ind5m,
      oiDeltaPct:  null,
      fundingRate: null,
      candles:     slice5m,
    });

    // Gates
    const gateResult = checkGates({
      rsi5m,
      rsi15m,
      rsi1h,
      rsi4h,
      ema21Distance: ind5m.distance,
      ema21Touched:  ind5m.touched,
      nearDailyLevel,
      fundingRate:   null,
      regime,
    });

    if (!gateResult.pass) continue;

    // Skor
    const primaryRSI = Math.max(rsi5m ?? 0, rsi15m ?? 0);
    const { score, grade, breakdown } = calcScore({
      rsi:           primaryRSI,
      ema21Distance: ind5m.distance,
      dailyProximity,
      volRatio:      ind5m.volRatio,
      cvdDir:        ind5m.cvdDir,
      oiDeltaPct:    null,
      negPeaks:      ind5m.negPeaks,
      hasEMC:        gateResult.hasEMC,
    });

    if (score < MIN_SCORE) continue;

    // TP hesabı (aynı signalEngine.js mantığı)
    const ema21_5m = ind5m.ema21;
    const atr5m    = ind5m.atr;
    const tpA = ema21_5m != null ? +(ema21_5m * 1.0015).toFixed(6) : null;
    const tpB = ema21_5m != null && atr5m != null
      ? +(ema21_5m - atr5m * 0.3).toFixed(6)
      : null;
    const safeTpB = tpB != null && tpA != null && tpB < tpA ? tpB : null;

    // SL seviyesi
    const slLevel = price * (1 + cfg.initialRiskPct / 100);

    // İleriye dönük simülasyon
    const futureCandles = candles5m.slice(i + 1, i + 1 + 288); // maks 24h (288 × 5m)
    const outcome = simulateOutcome(price, slLevel, tpA, safeTpB, futureCandles);

    signals.push({
      symbol,
      ts:     ts5m,
      date:   new Date(ts5m).toISOString(),
      grade,
      score,
      regime,
      hasEMC: gateResult.hasEMC ? 1 : 0,
      entryPrice: price,
      tpA,
      tpB: safeTpB,
      slLevel,
      rsi5m:         rsi5m    != null ? +rsi5m.toFixed(2)    : null,
      rsi15m:        rsi15m   != null ? +rsi15m.toFixed(2)   : null,
      rsi1h:         rsi1h    != null ? +rsi1h.toFixed(2)    : null,
      rsi4h:         rsi4h    != null ? +rsi4h.toFixed(2)    : null,
      ema21Distance: +ind5m.distance.toFixed(3),
      volumeRatio:   +ind5m.volRatio.toFixed(2),
      cvdDir:        ind5m.cvdDir,
      dailyProximity: +dailyProximity.toFixed(3),
      ...outcome,
      // Skor dağılımı (kalibrasyon için)
      scoreBreakdown: breakdown,
    });
  }

  return signals;
}

// ── Gelecek mum simülasyonu ─────────────────────────────────────────────────

/**
 * SHORT sinyali için ileriye dönük TP/SL simülasyonu
 * @returns {{ outcome, tpHit, slHit, mfe, mae, pnlPct, holdingCandles }}
 */
function simulateOutcome(entryPrice, slLevel, tpA, tpB, futureCandles) {
  let mfe = 0;         // max favorable excursion %
  let mae = 0;         // max adverse excursion %
  let tpHit   = null;  // 'TP_A' | 'TP_B' | null
  let slHit   = false;
  let tpHitAt = null;
  let slHitAt = null;

  const MAX_HOLD = 4 * 60 * 60 * 1000; // 4 saat (48 mum × 5m)
  const maxCandles = Math.min(futureCandles.length, 48);

  for (let j = 0; j < maxCandles; j++) {
    const c = futureCandles[j];
    const ts = c.openTime + (j + 1) * 5 * 60 * 1000;

    // SHORT: fiyat düşerse favorable
    const lowChange  = (entryPrice - c.low)  / entryPrice * 100;  // max kazanç
    const highChange = (entryPrice - c.high) / entryPrice * 100;  // max kayıp (negatif)

    if (lowChange  > mfe) mfe = lowChange;
    if (-highChange > mae) mae = -highChange;

    // TP kontrol (worst-case: high önce check et → SL riski)
    if (!slHit && c.high >= slLevel) {
      slHit   = true;
      slHitAt = j;
    }

    if (tpA != null && c.low <= tpA) {
      if (!tpHit) { tpHit = 'TP_A'; tpHitAt = j; }
    }
    if (tpB != null && c.low <= tpB) {
      tpHit   = 'TP_B';
      tpHitAt = j;
    }

    // Erken çözüm: her ikisi de geldiyse kararlaştır
    if (slHit && tpHit) break;
    if (tpHit && !slHit) break;  // TP önce → WIN
    if (slHit && !tpHit) break;  // SL önce → LOSS
  }

  // Outcome belirleme
  let outcome;
  const lastClose = futureCandles[Math.min(maxCandles, futureCandles.length) - 1]?.close ?? entryPrice;
  const pnlPct    = (entryPrice - lastClose) / entryPrice * 100;

  if (slHit && tpHit) {
    outcome = slHitAt < tpHitAt ? 'LOSS_THEN_RECOVER' : 'WIN';
  } else if (tpHit) {
    outcome = 'WIN';
  } else if (slHit) {
    outcome = 'LOSS';
  } else if (futureCandles.length > 0) {
    if (pnlPct > 0.3)       outcome = 'WIN';
    else if (pnlPct < -0.3) outcome = 'LOSS';
    else                     outcome = 'NEUTRAL';
  } else {
    outcome = 'NEUTRAL';
  }

  return {
    outcome,
    tpHit:        tpHit,
    slHit:        slHit ? 1 : 0,
    tpHitCandle:  tpHitAt,
    slHitCandle:  slHitAt,
    mfe:          +mfe.toFixed(4),
    mae:          +mae.toFixed(4),
    pnlPct:       +pnlPct.toFixed(4),
    holdingCandles: Math.min(maxCandles, futureCandles.length),
  };
}

// ── Günlük Seviye Hesabı ────────────────────────────────────────────────────

function calcDailyLevels(klines1d) {
  if (!klines1d.length) return { ema200: null, resistance: null };

  const closes = klines1d.map(k => k.close);

  // EMA200 — günlük
  let ema200 = null;
  if (closes.length >= 30) {
    // Basit yaklaşım: son 30 günün EMA yerine ortalaması (az veri için)
    const period = Math.min(closes.length, 200);
    const slice  = closes.slice(-period);
    ema200 = slice.reduce((s, v) => s + v, 0) / slice.length;
  }

  // Majör direnç — son 30 günün en yüksek 3 kapanış ortalaması
  const highs = klines1d.slice(-30).map(k => k.high).sort((a, b) => b - a);
  const resistance = highs.length >= 3
    ? (highs[0] + highs[1] + highs[2]) / 3
    : highs[0] ?? null;

  return { ema200, resistance };
}

/**
 * Fiyatın günlük seviyeye yakınlık skoru (signalEngine.js'den aynı)
 */
function calcDailyProximity(price, level) {
  if (!level || level === 0) return 0;
  const pct = Math.abs(price - level) / level * 100;
  if (pct <= 0.2) return 1.0;
  if (pct <= 0.5) return 0.9;
  if (pct <= 1.0) return 0.7;
  if (pct <= 1.5) return 0.5;
  if (pct <= 2.5) return 0.2;
  return 0;
}

// ── Veri Yardımcıları ───────────────────────────────────────────────────────

/**
 * REST'ten kline çek ve normalize et
 * @returns {{ openTime, open, high, low, close, volume }[]}
 */
async function fetchKlines(symbol, interval, limit) {
  try {
    const raw = await restClient.getKlines({ symbol, interval, limit });
    return raw.map(k => ({
      openTime: parseInt(k[0], 10),
      open:     parseFloat(k[1]),
      high:     parseFloat(k[2]),
      low:      parseFloat(k[3]),
      close:    parseFloat(k[4]),
      volume:   parseFloat(k[5]),
    }));
  } catch (err) {
    console.error(`  [${symbol}/${interval}] Veri çekme hatası:`, err.message);
    return [];
  }
}

/**
 * Belirli bir zaman damgasına kadar olan mumları slice et
 * OpenTime'a göre sıralı olduğu varsayılır
 */
function getSliceUpToTime(candles, ts, maxLen = 200) {
  // ts: 5m mum açılış zamanı — eşit veya küçük olanları al
  const idx = candles.findLastIndex(c => c.openTime <= ts);
  if (idx < 0) return [];
  return candles.slice(Math.max(0, idx - maxLen + 1), idx + 1);
}

// ── Raporlama ────────────────────────────────────────────────────────────────

function printSymbolSummary(symbol, signals) {
  if (!signals.length) {
    console.log(`  [${symbol}] Sinyal üretilmedi.`);
    return;
  }

  const wins    = signals.filter(s => s.outcome === 'WIN').length;
  const losses  = signals.filter(s => s.outcome === 'LOSS').length;
  const neutral = signals.filter(s => s.outcome === 'NEUTRAL').length;
  const ltr     = signals.filter(s => s.outcome === 'LOSS_THEN_RECOVER').length;
  const total   = signals.length;
  const winRate = ((wins / total) * 100).toFixed(1);

  const avgMFE  = avg(signals.map(s => s.mfe)).toFixed(2);
  const avgMAE  = avg(signals.map(s => s.mae)).toFixed(2);

  console.log(`  [${symbol}] ${total} sinyal → Win: ${wins} (${winRate}%)  Loss: ${losses}  Neutral: ${neutral}  LTR: ${ltr}`);
  console.log(`             Ort MFE: ${avgMFE}%  Ort MAE: ${avgMAE}%`);
}

function printGradeBreakdown(signals) {
  if (!signals.length) { console.log('  Sinyal yok.'); return; }

  console.log('\n📊 Dereceye Göre Win Rate:');
  console.log('  Grade  | Total  | Win%   | Ort MFE | Ort MAE');
  console.log('  -------+--------+--------+---------+--------');

  for (const grade of ['A+', 'A', 'B', 'C']) {
    const grp = signals.filter(s => s.grade === grade);
    if (!grp.length) continue;
    const wr = ((grp.filter(s => s.outcome === 'WIN').length / grp.length) * 100).toFixed(1);
    const mfe = avg(grp.map(s => s.mfe)).toFixed(2);
    const mae = avg(grp.map(s => s.mae)).toFixed(2);
    console.log(`  ${grade.padEnd(6)} | ${String(grp.length).padEnd(6)} | ${wr.padEnd(6)}% | ${mfe}%      | ${mae}%`);
  }
}

function printRegimeBreakdown(signals) {
  console.log('\n🔍 Rejime Göre Win Rate:');
  console.log('  Regime       | Total  | Win%');
  console.log('  -------------+--------+------');

  for (const regime of ['REVERSAL', 'NEUTRAL', 'CONTINUATION']) {
    const grp = signals.filter(s => s.regime === regime);
    if (!grp.length) continue;
    const wr = ((grp.filter(s => s.outcome === 'WIN').length / grp.length) * 100).toFixed(1);
    console.log(`  ${regime.padEnd(13)} | ${String(grp.length).padEnd(6)} | ${wr}%`);
  }
}

function printEMCBreakdown(signals) {
  console.log('\n⚡ EMC Analizi:');
  for (const hasEMC of [1, 0]) {
    const grp = signals.filter(s => s.hasEMC === hasEMC);
    if (!grp.length) continue;
    const label = hasEMC ? 'EMC Var ' : 'EMC Yok ';
    const wr = ((grp.filter(s => s.outcome === 'WIN').length / grp.length) * 100).toFixed(1);
    console.log(`  ${label}: ${grp.length} sinyal → Win: ${wr}%`);
  }
}

/**
 * Skor kalibrasyon tablosu — her 5 puanlık bantda win rate
 * Bu tablo kullanılarak minScoreToSend ayarlanabilir
 */
function printScoreCalibration(signals) {
  console.log('\n📈 Skor Kalibrasyon Tablosu:');
  console.log('  Skor Aralığı | Total  | Win%   | Öneri');
  console.log('  -------------+--------+--------+------');

  for (let lower = 40; lower <= 95; lower += 5) {
    const upper = lower + 4;
    const grp = signals.filter(s => s.score >= lower && s.score <= upper);
    if (!grp.length) continue;
    const wins = grp.filter(s => s.outcome === 'WIN').length;
    const wr   = ((wins / grp.length) * 100).toFixed(1);
    const wrNum = parseFloat(wr);

    let note = '';
    if (wrNum >= 60) note = '✅ Gönder';
    else if (wrNum >= 50) note = '⚠️ Dikkatli';
    else note = '❌ İncele';

    console.log(`  ${String(lower).padEnd(3)}-${String(upper).padEnd(3)}         | ${String(grp.length).padEnd(6)} | ${wr.padEnd(6)}% | ${note}`);
  }

  // Genel toplam
  const total = signals.length;
  const wins  = signals.filter(s => s.outcome === 'WIN').length;
  const wr    = total ? ((wins / total) * 100).toFixed(1) : '—';
  console.log(`  ${'TOPLAM'.padEnd(13)} | ${String(total).padEnd(6)} | ${String(wr).padEnd(6)}%`);
}

// ── Yardımcı ────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + (v ?? 0), 0) / arr.length;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return result;
}

// ── Başlat ───────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n[BACKTEST] Kritik hata:', err.message || err);
  process.exit(1);
});
