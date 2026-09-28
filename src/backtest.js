'use strict';

/**
 * Backtest Motoru — Scalp Sinyal Motoru
 *
 * Amacı:
 *   1. Binance REST'ten istenen gün sayısı kadar geçmiş kline verisini SAYFALAYARAK çek
 *   2. Her kapanan 5m mumda canlı motorun (signalEngine) kararını, o an BİLİNEN veriyle yeniden üret
 *   3. Sinyal üretildiğinde ileriye dönük mumlarla TP/SL simüle et
 *   4. Grade / Regime / EMC / skor bandı bazında win rate tablosu yaz
 *
 * Canlı bot ile aynı kalması gereken her şey ortak modüllerden gelir:
 *   indicators.js, regime.js, gates.js, scorer.js, levels.js (günlük seviye), tradePlan.js (TP/SL)
 *
 * Look-ahead (geleceği görme) koruması:
 *   Karar anı T = 5m mumun kapanışı. 15m/1h/4h için yalnızca T'den ÖNCE kapanmış mumlar +
 *   T'ye kadarki 5m mumlardan kurulan "devam eden" mum kullanılır — canlıda WebSocket'in
 *   candleStore'a yazdığı yarım mumla aynı. Günlük seviyeler de 4 saatte bir (canlı htfPoller
 *   gibi) o ana kadarki veriyle hesaplanır.
 *
 * Çalıştırma (Binance'e erişimi olan bir yerde: Fly ssh console veya kendi Ubuntu ortamın):
 *   node src/backtest.js
 *   node src/backtest.js --symbol BTCUSDT --days 90
 *   node src/backtest.js --symbol ETHUSDT,SOLUSDT --days 30 --min-score 55
 *
 * Çıktı: backtest-results/ klasörüne JSON + konsol özeti
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const cfg                = require('./config');
const { computeAll }     = require('./indicators');
const { detectRegime }   = require('./regime');
const { checkGates }     = require('./gates');
const { calcScore }      = require('./scorer');
const { calcDailyLevels, nearLevelInfo } = require('./levels');
const { calcTradePlan }  = require('./tradePlan');
const { createTrade, applyBar, toRecord } = require('./outcome');
const { withRetry }      = require('./binanceClient');

// ── Sabitler ────────────────────────────────────────────────────────────────

const MIN = 60 * 1000;
const TF_MS = { '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN };

const BUFFER       = 200;  // canlı candleStore tampon boyu (BUFFER_SIZE) ile aynı
const MIN_CANDLES  = 50;   // canlı candleStore.isReady() eşiği ile aynı
const DAILY_WINDOW = 220;  // canlı htfPoller 1d limit=220 ile aynı
const HOLD_CANDLES = 48;   // sonuç penceresi: 4 saat = 48 × 5m (eventTracker MAX_HOLD ile aynı)

const PAGE_LIMIT   = 1000; // Binance futures klines: limit 500–1000 → weight 5
// ≈ 860 weight/dk — 2400/dk limitinin çok altında (kendi IP'n korunur). Testlerde 0 yapılabilir.
const REQ_DELAY_MS = Number(process.env.BACKTEST_REQ_DELAY_MS ?? 350);

// ── Veri kaynağı (testlerde sahte kaynak enjekte edilebilir) ────────────────

let klineSource = null;
function source() {
  if (!klineSource) klineSource = require('./binanceClient').restClient;
  return klineSource;
}
function setKlineSource(src) { klineSource = src; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeKline(k) {
  return {
    openTime:  Number(k[0]),
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    closeTime: Number(k[6]),
  };
}

/**
 * [startTime, endTime) aralığındaki TÜM KAPANMIŞ mumları sayfalayarak çeker.
 * (Eski sürüm tek istekle en fazla 1000 mum alıyordu → "--days 90" aslında 3.5 gündü.)
 */
async function fetchRange(symbol, interval, startTime, endTime) {
  const tfMs   = TF_MS[interval];
  const byOpen = new Map();
  let from = startTime;

  while (from < endTime) {
    const raw = await withRetry(
      () => source().getKlines({ symbol, interval, startTime: from, endTime: endTime - 1, limit: PAGE_LIMIT }),
      `${symbol} ${interval}`,
    );
    await sleep(REQ_DELAY_MS);
    if (!raw || !raw.length) break;

    for (const k of raw) {
      const c = normalizeKline(k);
      byOpen.set(c.openTime, c);
    }

    const next = Number(raw[raw.length - 1][0]) + tfMs;
    if (next <= from) break;          // ilerleme yoksa sonsuz döngüye girme
    from = next;
    if (raw.length < PAGE_LIMIT) break;
  }

  return [...byOpen.values()]
    .filter(c => c.closeTime < endTime)            // yalnızca kapanmış mumlar
    .sort((a, b) => a.openTime - b.openTime);
}

// ── Look-ahead'siz üst zaman dilimi görünümü ────────────────────────────────

/**
 * Bir üst TF (15m/1h/4h) için, karar anı T'de canlı candleStore'da ne olacağını üretir:
 *   T'den önce kapanmış mumlar + T'ye kadarki 5m mumlardan kurulan devam eden mum.
 *
 * push() her 5m mum için (atlama yapmadan önce) çağrılmalı; slice(T) artan T ile çağrılmalı.
 */
function makeHtfView(closedCandles, tfMs) {
  let ptr  = 0;     // closedCandles[0..ptr) → closeTime < T
  let part = null;  // devam eden mum (5m'lerden)

  return {
    push(c5) {
      const periodStart = Math.floor(c5.openTime / tfMs) * tfMs;
      if (!part || part.openTime !== periodStart) {
        part = { openTime: periodStart, open: c5.open, high: c5.high, low: c5.low, close: c5.close, volume: c5.volume };
      } else {
        if (c5.high > part.high) part.high = c5.high;
        if (c5.low  < part.low)  part.low  = c5.low;
        part.close   = c5.close;
        part.volume += c5.volume;
      }
    },

    slice(T) {
      while (ptr < closedCandles.length && closedCandles[ptr].closeTime < T) ptr++;
      // T periyot sınırındaysa o mum zaten kapanmış (closedCandles içinde) → yarım mum yok
      const withPartial = part !== null && T % tfMs !== 0;
      const nClosed = withPartial ? BUFFER - 1 : BUFFER;
      const out = closedCandles.slice(Math.max(0, ptr - nClosed), ptr);
      if (withPartial) out.push({ ...part });
      return out;
    },
  };
}

/**
 * Canlı htfPoller 4 saatte bir günlük seviyeleri o ana kadarki 1d verisiyle (devam eden gün dahil)
 * hesaplar. Burada da 4 saatlik blok başlangıcı B itibarıyla aynısı yapılır:
 *   B'den önce kapanmış günler + B'ye kadarki 5m mumlardan kurulan bugünkü yarım gün.
 */
function dailyLevelsAt(B, dailyCandles, c5, i) {
  const dayStart = Math.floor(B / TF_MS['1d']) * TF_MS['1d'];
  const closedDays = dailyCandles.filter(d => d.closeTime < B);

  let partDay = null;
  for (let k = i; k >= 0 && c5[k].openTime >= dayStart; k--) {
    if (c5[k].openTime >= B) continue;
    if (!partDay) partDay = { high: c5[k].high, close: c5[k].close };   // en yeni mum → close
    else if (c5[k].high > partDay.high) partDay.high = c5[k].high;
  }

  const list = closedDays.slice(-(partDay ? DAILY_WINDOW - 1 : DAILY_WINDOW));
  if (partDay) list.push(partDay);
  return calcDailyLevels(list);
}

// ── Sembol Backtest ─────────────────────────────────────────────────────────

/**
 * @returns {{ signals: object[], stats: object }}
 */
async function backtestSymbol(symbol, { startTime, endTime, minScore }) {
  // Isınma: canlı bot 200 mumluk tamponla başlıyor → her TF için başlangıçtan önce 200 mum
  const ranges = {
    '5m':  startTime - BUFFER * TF_MS['5m'],
    '15m': startTime - BUFFER * TF_MS['15m'],
    '1h':  startTime - BUFFER * TF_MS['1h'],
    '4h':  startTime - BUFFER * TF_MS['4h'],
    '1d':  startTime - DAILY_WINDOW * TF_MS['1d'],
  };

  // Sıralı çek (paralel değil) — rate limit koruması
  const data = {};
  for (const tf of Object.keys(ranges)) {
    data[tf] = await fetchRange(symbol, tf, ranges[tf], endTime);
  }

  const c5 = data['5m'];
  const stats = {
    candles: Object.fromEntries(Object.entries(data).map(([tf, arr]) => [tf, arr.length])),
    range: c5.length ? [c5[0].openTime, c5[c5.length - 1].closeTime + 1] : null,
    decisions: 0, cooldown: 0, nearLevel: 0, rsi1hOk: 0, rsi4hOk: 0, gatePass: 0,
    planInvalid: 0, belowScore: 0, signals: 0,
  };
  let lastSignalT = null;   // canlıdaki lastSignalAt ile aynı cooldown kuralı

  if (c5.length < BUFFER) {
    console.warn(`  [${symbol}] Yetersiz 5m veri (${c5.length} mum) — atlandı`);
    return { signals: [], stats };
  }

  const views = {
    '15m': makeHtfView(data['15m'], TF_MS['15m']),
    '1h':  makeHtfView(data['1h'],  TF_MS['1h']),
    '4h':  makeHtfView(data['4h'],  TF_MS['4h']),
  };

  const signals = [];
  let dailyKey = null;
  let daily    = null;

  for (let i = 0; i < c5.length; i++) {
    const cur = c5[i];
    // Yarım HTF mumları her 5m mumla güncellenmeli — aşağıdaki "continue"lardan ÖNCE
    views['15m'].push(cur);
    views['1h'].push(cur);
    views['4h'].push(cur);

    const T = cur.openTime + TF_MS['5m'];                       // karar anı: 5m mum kapanışı
    if (cur.openTime < startTime) continue;                     // ısınma bölgesi
    if (T + HOLD_CANDLES * TF_MS['5m'] > endTime) break;        // sonucu ölçecek tam 4 saat yok
    if (i + 1 < MIN_CANDLES) continue;
    stats.decisions++;

    // Cooldown — canlı signalEngine ile aynı kural (cfg.cooldownMs)
    if (lastSignalT != null && T - lastSignalT < cfg.cooldownMs) { stats.cooldown++; continue; }

    // ── Günlük seviye (4 saatlik blok başına bir kez, canlı htfPoller gibi) ──
    const block = Math.floor(T / TF_MS['4h']) * TF_MS['4h'];
    if (block !== dailyKey) {
      daily    = dailyLevelsAt(block, data['1d'], c5, i);
      dailyKey = block;
    }

    const price = cur.close;
    const { nearDailyLevel, dailyProximity } = nearLevelInfo(price, daily);

    // Aşağıdaki erken "continue"lar yalnızca hız içindir: gates.js'teki tüm kapılar VE ile
    // bağlı olduğundan, bir kapı kalırsa sonuç zaten "reddedildi" olur. Son karar yine
    // checkGates() ile birebir verilir.
    if (!nearDailyLevel) continue;
    stats.nearLevel++;

    const s15 = views['15m'].slice(T);
    const s1h = views['1h'].slice(T);
    if (s15.length < MIN_CANDLES || s1h.length < MIN_CANDLES) continue;   // canlı isReady()

    const ind1h = computeAll(s1h);
    if (!ind1h.rsi || ind1h.rsi < cfg.rsi1hMin) continue;
    stats.rsi1hOk++;

    const s4h   = views['4h'].slice(T);
    const ind4h = s4h.length >= MIN_CANDLES ? computeAll(s4h) : null;
    if (!ind4h?.rsi || ind4h.rsi < cfg.rsi4hMin) continue;
    stats.rsi4hOk++;

    const s5     = c5.slice(Math.max(0, i - BUFFER + 1), i + 1);
    const ind5m  = computeAll(s5);
    const ind15m = computeAll(s15);

    const regime = detectRegime({ indicators: ind5m, oiDeltaPct: null, fundingRate: null, candles: s5 });

    const gateResult = checkGates({
      rsi5m:         ind5m.rsi,
      rsi15m:        ind15m.rsi,
      rsi1h:         ind1h.rsi,
      rsi4h:         ind4h.rsi,
      ema21Distance: ind5m.distance,
      ema21Touched:  ind5m.touched,
      nearDailyLevel,
      fundingRate:   null,
      regime,
    });
    if (!gateResult.pass) continue;
    stats.gatePass++;

    // ── İşlem planı — canlı ile aynı sıra: kapı → plan → skor ──
    const plan = calcTradePlan({
      entryPrice:     price,
      ema21:          ind5m.ema21,
      atr:            ind5m.atr,
      initialRiskPct: cfg.initialRiskPct,
    });
    if (!plan.valid) { stats.planInvalid++; continue; }

    const primaryRSI = Math.max(ind5m.rsi ?? 0, ind15m.rsi ?? 0);
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
    if (score < minScore) { stats.belowScore++; continue; }

    const futureCandles = c5.slice(i + 1, i + 1 + HOLD_CANDLES);
    const outcome = simulateOutcome({
      entryPrice: price, tpA: plan.tpA, tpB: plan.tpB, slLevel: plan.slLevel,
      initialRiskPct: cfg.initialRiskPct, sentAt: T,
    }, futureCandles);

    lastSignalT = T;
    stats.signals++;
    signals.push({
      symbol,
      ts:     T,
      date:   new Date(T).toISOString(),
      grade,
      score,
      regime,
      hasEMC: gateResult.hasEMC ? 1 : 0,
      entryPrice: price,
      tpA:     plan.tpA,
      tpB:     plan.tpB,
      slLevel: plan.slLevel,
      rsi5m:   ind5m.rsi  != null ? +ind5m.rsi.toFixed(2)  : null,
      rsi15m:  ind15m.rsi != null ? +ind15m.rsi.toFixed(2) : null,
      rsi1h:   +ind1h.rsi.toFixed(2),
      rsi4h:   +ind4h.rsi.toFixed(2),
      ema21Distance:  +ind5m.distance.toFixed(3),
      volumeRatio:    +ind5m.volRatio.toFixed(2),
      cvdDir:         ind5m.cvdDir,
      dailyProximity: +dailyProximity.toFixed(3),
      ...outcome,
      scoreBreakdown: breakdown,
    });
  }

  return { signals, stats };
}

// ── Gelecek mum simülasyonu ─────────────────────────────────────────────────

/**
 * SHORT sinyali için ileriye dönük sonuç — canlı tracker ile AYNI kurallar (outcome.js):
 *   TP-A önce → WIN (çıkış TP-A) | SL önce → LOSS (çıkış SL) | aynı mumda ikisi → LOSS
 *   önce SL sonra TP-A → LOSS_THEN_RECOVER | 4 saat → son fiyata göre
 *   Sonuçtan sonra 4 saat dolana kadar TP-B ve MFE/MAE izlenir. pnl/R çıkış fiyatından.
 *
 * Her mum bir fiyat çubuğudur (ts = mumun kapanışı) → mum içi sıra bilinmediğinden
 * aynı mumda hem SL hem TP-A görülürse muhafazakâr olarak LOSS sayılır.
 */
function simulateOutcome(trade, futureCandles) {
  const t = createTrade(trade);
  let bars = 0;
  for (const c of futureCandles.slice(0, HOLD_CANDLES)) {
    applyBar(t, { ts: c.closeTime + 1, high: c.high, low: c.low, close: c.close });
    bars++;
    if (t.finalizedAt != null) break;
  }
  const rec = toRecord(t);
  const barIndex = ts => (ts == null ? null : Math.round((ts - trade.sentAt) / TF_MS['5m']) - 1);
  return {
    ...rec,
    tpHitCandle:  barIndex(rec.tpHitAt),
    tpBHitCandle: barIndex(rec.tpBHitAt),
    slHitCandle:  barIndex(rec.slHitAt),
    holdingCandles: bars,
  };
}

// ── Ana fonksiyon ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const SYMBOLS   = args.symbol
    ? String(args.symbol).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : cfg.testSymbols;
  const DAYS      = parseInt(args.days || 90, 10);
  const MIN_SCORE = parseInt(args['min-score'] ?? cfg.minScoreToSend, 10);

  if (!Number.isFinite(DAYS) || DAYS < 1) throw new Error(`Geçersiz --days: ${args.days}`);

  // --telegram: bitince tek bir özet rapor mesajı (canlı gönderim yolunu da test eder)
  const SEND_TG = Boolean(args.telegram);
  if (SEND_TG) {
    const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(k => !process.env[k]);
    if (missing.length) throw new Error(`--telegram için eksik ortam değişkeni: ${missing.join(', ')}`);
  }

  // Son kapanmış 5m sınırına hizala
  const endTime   = Math.floor(Date.now() / TF_MS['5m']) * TF_MS['5m'];
  const startTime = endTime - DAYS * TF_MS['1d'];

  const OUT_DIR = path.join(__dirname, '..', 'backtest-results');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('\n════════════════════════════════════════════');
  console.log('  Scalp Bot — Backtest Motoru');
  console.log(`  Semboller  : ${SYMBOLS.join(', ')}`);
  console.log(`  Dönem      : ${fmtDate(startTime)} → ${fmtDate(endTime)} (${DAYS} gün)  |  Min skor: ${MIN_SCORE}`);
  console.log('════════════════════════════════════════════\n');

  const allResults = [];
  const allStats   = {};

  for (const symbol of SYMBOLS) {
    console.log(`\n[${symbol}] Veri çekiliyor...`);
    try {
      const { signals, stats } = await backtestSymbol(symbol, { startTime, endTime, minScore: MIN_SCORE });
      allResults.push(...signals);
      allStats[symbol] = stats;
      printCoverage(symbol, stats);
      printSymbolSummary(symbol, signals);
    } catch (err) {
      console.error(`  [${symbol}] Hata — atlandı:`, err?.message || err?.body || err);
    }
  }

  console.log('\n\n════════════════════════════════════════════');
  console.log('  GENEL RAPOR');
  console.log('════════════════════════════════════════════');

  printFunnel(allStats);
  printGradeBreakdown(allResults);
  printRegimeBreakdown(allResults);
  printEMCBreakdown(allResults);
  printScoreCalibration(allResults);

  const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19);
  const outFile   = path.join(OUT_DIR, `backtest-${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ params: { SYMBOLS, DAYS, MIN_SCORE, startTime, endTime }, stats: allStats, signals: allResults }, null, 2));
  console.log(`\n📁 Detaylı sonuçlar: ${outFile}\n`);

  if (SEND_TG) {
    // telegram.js yalnızca burada yüklenir; komut dinleme (polling) BAŞLATILMAZ → canlı botla çakışmaz
    const telegram = require('./telegram');
    const text = buildTelegramReport({ SYMBOLS, DAYS, MIN_SCORE, startTime, endTime }, allStats, allResults, telegram.esc);
    telegram.sendText(text);
    const flushed = await telegram.flush(90_000);
    const st = telegram.takeStats();
    if (flushed && st.sent > 0 && st.failed === 0) {
      console.log(`📨 Telegram: özet rapor gönderildi (chat ${process.env.TELEGRAM_CHAT_ID}, ${text.length} karakter)`);
    } else {
      console.error(`❌ Telegram: rapor GÖNDERİLEMEDİ (gönderilen ${st.sent}, başarısız ${st.failed}, kuyrukta ${st.queued}) — yukarıdaki [TELEGRAM] loglarına bak`);
      process.exitCode = 2;
    }
  }
}

// ── Raporlama ────────────────────────────────────────────────────────────────

/**
 * Telegram özet raporu (tek mesaj, ≤ 4096 karakter). Başında açıkça "canlı sinyal değil" yazar.
 */
function buildTelegramReport(p, allStats, signals, esc) {
  const sum  = key => Object.values(allStats).reduce((s, st) => s + (st[key] || 0), 0);
  const pct  = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
  const n    = signals.length;
  const cnt  = o => signals.filter(s => s.outcome === o).length;
  const avgR = n ? avg(signals.map(s => s.rMultiple)).toFixed(2) : '—';
  const tpB  = signals.filter(s => s.tpBHitAt != null).length;

  const gradeLines = ['A+', 'A', 'B', 'C'].map(g => {
    const grp = signals.filter(s => s.grade === g);
    if (!grp.length) return null;
    return `  ${g}: ${grp.length} sinyal | win ${pct(grp.filter(s => s.outcome === 'WIN').length, grp.length)} | ort R ${avg(grp.map(s => s.rMultiple)).toFixed(2)}`;
  }).filter(Boolean);

  const bySym = {};
  for (const s of signals) {
    bySym[s.symbol] ??= { n: 0, w: 0 };
    bySym[s.symbol].n++;
    if (s.outcome === 'WIN') bySym[s.symbol].w++;
  }
  const topSyms = Object.entries(bySym).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([sym, v]) => `${esc(sym)} ${v.n} (win ${pct(v.w, v.n)})`).join(', ');

  const lines = [
    '🧪 <b>BACKTEST RAPORU</b>',
    '<i>Geçmiş veri simülasyonu — canlı sinyal DEĞİLDİR</i>',
    '',
    `📅 ${fmtDate(p.startTime)} → ${fmtDate(p.endTime)} UTC (${p.DAYS} gün)`,
    `🪙 ${p.SYMBOLS.length} sembol | min skor ${p.MIN_SCORE}`,
    '',
    '<b>Eleme hunisi</b>',
    `  Değerlendirilen 5m kapanış: ${sum('decisions')}`,
    `  Günlük seviyeye yakın: ${sum('nearLevel')}`,
    `  + 1h RSI ≥ ${cfg.rsi1hMin}: ${sum('rsi1hOk')}`,
    `  + 4h RSI ≥ ${cfg.rsi4hMin}: ${sum('rsi4hOk')}`,
    `  Tüm kapılar: ${sum('gatePass')}`,
    `  − TP-A geçersiz: ${sum('planInvalid')} | − skor altı: ${sum('belowScore')}`,
    `  = <b>Sinyal: ${n}</b>`,
  ];

  if (n) {
    lines.push(
      '',
      '<b>Sonuçlar</b>',
      `  ✅ Win ${cnt('WIN')} | ❌ Loss ${cnt('LOSS')} | ↩️ ${cnt('LOSS_THEN_RECOVER')} | ➖ ${cnt('NEUTRAL')}`,
      `  Win rate: <b>${pct(cnt('WIN'), n)}</b> | Ort R: <b>${avgR}</b> | TP-B: ${pct(tpB, n)}`,
      '',
      '<b>Dereceye göre</b>',
      ...gradeLines,
      '',
      `<b>En çok sinyal</b>: ${topSyms}`,
    );
  } else {
    lines.push('', 'Bu dönemde tüm kapıları geçen sinyal yok — hangi aşamada elendiğini huniden görebilirsin.');
  }

  const text = lines.join('\n');
  return text.length <= 4000 ? text : text.slice(0, 3990) + '\n…';
}

function fmtDate(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function printCoverage(symbol, stats) {
  const c = stats.candles;
  const r = stats.range ? `${fmtDate(stats.range[0])} → ${fmtDate(stats.range[1])}` : '—';
  console.log(`  [${symbol}] Veri: ${r} | 5m:${c['5m']} 15m:${c['15m']} 1h:${c['1h']} 4h:${c['4h']} 1d:${c['1d']} mum`);
}

/**
 * Sinyallerin hangi aşamada elendiğini gösterir — kapı kalibrasyonu için
 */
function printFunnel(allStats) {
  const sum = key => Object.values(allStats).reduce((s, st) => s + (st[key] || 0), 0);
  const steps = [
    ['Değerlendirilen 5m kapanış', 'decisions'],
    ['− Cooldown (elendi)',        'cooldown'],
    ['Günlük seviyeye yakın',      'nearLevel'],
    ['+ 1h RSI ≥ ' + cfg.rsi1hMin, 'rsi1hOk'],
    ['+ 4h RSI ≥ ' + cfg.rsi4hMin, 'rsi4hOk'],
    ['Tüm kapılar geçti',          'gatePass'],
    ['− TP-A geçersiz (elendi)',   'planInvalid'],
    ['− Skor eşik altı (elendi)',  'belowScore'],
    ['= Sinyal',                   'signals'],
  ];
  console.log('\n🔻 Eleme Hunisi (tüm semboller):');
  for (const [label, key] of steps) console.log(`  ${label.padEnd(28)} ${String(sum(key)).padStart(8)}`);
}

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
  const avgR    = avg(signals.map(s => s.rMultiple)).toFixed(2);
  const tpB     = signals.filter(s => s.tpBHitAt != null).length;

  console.log(`  [${symbol}] ${total} sinyal → Win: ${wins} (${winRate}%)  Loss: ${losses}  Neutral: ${neutral}  LTR: ${ltr}`);
  console.log(`             Ort R: ${avgR}  Ort MFE: ${avgMFE}%  Ort MAE: ${avgMAE}%  TP-B'ye ulaşan: ${tpB}`);
}

function printGradeBreakdown(signals) {
  if (!signals.length) { console.log('\n  Sinyal yok.'); return; }

  console.log('\n📊 Dereceye Göre Win Rate:');
  console.log('  Grade  | Total  | Win%   | Ort R  | TP-B%  | Ort MFE | Ort MAE');
  console.log('  -------+--------+--------+--------+--------+---------+--------');

  for (const grade of ['A+', 'A', 'B', 'C']) {
    const grp = signals.filter(s => s.grade === grade);
    if (!grp.length) continue;
    const wr  = ((grp.filter(s => s.outcome === 'WIN').length / grp.length) * 100).toFixed(1);
    const r   = avg(grp.map(s => s.rMultiple)).toFixed(2);
    const tpb = ((grp.filter(s => s.tpBHitAt != null).length / grp.length) * 100).toFixed(0);
    const mfe = avg(grp.map(s => s.mfe)).toFixed(2);
    const mae = avg(grp.map(s => s.mae)).toFixed(2);
    console.log(`  ${grade.padEnd(6)} | ${String(grp.length).padEnd(6)} | ${wr.padEnd(6)}% | ${r.padEnd(6)} | ${tpb.padEnd(5)}% | ${mfe}%   | ${mae}%`);
  }
}

function printRegimeBreakdown(signals) {
  if (!signals.length) return;
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
  if (!signals.length) return;
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
 * Skor kalibrasyon tablosu — her 5 puanlık bantta win rate
 * Bu tablo kullanılarak minScoreToSend ayarlanabilir
 */
function printScoreCalibration(signals) {
  if (!signals.length) return;
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

// ── Başlat (yalnızca doğrudan çalıştırıldığında; testler require edebilir) ──

if (require.main === module) {
  main().catch(err => {
    console.error('\n[BACKTEST] Kritik hata:', err?.message || err);
    process.exit(1);
  });
}

module.exports = {
  backtestSymbol,
  fetchRange,
  makeHtfView,
  dailyLevelsAt,
  simulateOutcome,
  buildTelegramReport,
  setKlineSource,
  TF_MS,
};
