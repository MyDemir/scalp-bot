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
 *   node src/backtest.js --compare --days 90     # A: 5m/15m RSI 90–98 (canlı) · B: 3m/5m RSI 95–98 giriş 5m
 *                                                # · C: 3m/5m RSI 95–98 giriş 3m (planın tamamı) — aynı veride
 *   --fee-pct 0.05  → raporlardaki "net R" komisyon (giriş+çıkış) düşülmüş R
 *
 * Çıktı: backtest-results/ klasörüne JSON + konsol özeti
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const cfg                = require('./config');
const { computeAll, calcRSI } = require('./indicators');
const { detectRegime }   = require('./regime');
const { checkGates, listFailures, gateLabels, getTriggers, primaryRSI, rsiShortfalls, GATE_KEYS } = require('./gates');
const { calcScore }      = require('./scorer');
const { calcDailyLevels, nearLevelInfo } = require('./levels');
const { calcTradePlan }  = require('./tradePlan');
const { createTrade, applyBar, toRecord, HOLD_MS } = require('./outcome');  // sonuç penceresi 4 saat
const { withRetry }      = require('./binanceClient');
const { mertVariants, calcLevelSet, locate, rsiCheck, confidence, separationOk, makePlan } = require('./mert');

// ── Sabitler ────────────────────────────────────────────────────────────────

const MIN = 60 * 1000;
const TF_MS = { '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN };

const BUFFER       = 200;  // canlı candleStore tampon boyu (BUFFER_SIZE) ile aynı
const MIN_CANDLES  = 50;   // canlı candleStore.isReady() eşiği ile aynı
const DAILY_WINDOW = 220;  // canlı htfPoller 1d limit=220 ile aynı

// Son aşama adaylarında tetikleyici RSI dağılımı (max(5m,15m) ya da max(3m,5m))
const RSI_BUCKETS = [
  { max: 70,       label: '<70'   },
  { max: 80,       label: '70–80' },
  { max: 85,       label: '80–85' },
  { max: 90,       label: '85–90' },
  { max: 95,       label: '90–95' },
  { max: 98,       label: '95–98' },
  { max: Infinity, label: '≥98'   },
];

// RSI olay çalışması: aynı coinde bu süreden kısa aralıkla tekrar eden anlar tek olay sayılır
const EVENT_GAP_MS = 30 * MIN;
const HOUR_MS      = 60 * MIN;

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
  return calcDailyLevels(dailyListAt(B, dailyCandles, c5, i));
}

/** B anındaki günlük mum listesi (en fazla DAILY_WINDOW): B'den önce kapanmış günler + bugünkü yarım gün */
function dailyListAt(B, dailyCandles, c5, i) {
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
  return list;
}

// ── Sembol Backtest ─────────────────────────────────────────────────────────

/** Tetikleyicinin karar anları: RSI TF'leri ve giriş TF'inin kapanışları (5m/15m → her 5m; 3m/5m → her 3m ve 5m) */
function decisionTFs(trig) {
  return [...new Set([...trig.rsiTFs, trig.entryTF])];
}

/** 1m mumlardan KAPANMIŞ 3m mumları üretir (REST'ten ayrıca 3m çekmemek için; Binance'in 3m'i ile aynı) */
function aggregateClosed(c1, tfMs, endTime) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); };
  for (const c of c1) {
    const ps = Math.floor(c.openTime / tfMs) * tfMs;
    if (!cur || cur.openTime !== ps) {
      flush();
      cur = { openTime: ps, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closeTime: ps + tfMs - 1, _last: c.closeTime };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low  < cur.low)  cur.low  = c.low;
      cur.close = c.close; cur.volume += c.volume; cur._last = c.closeTime;
    }
  }
  flush();
  // Yalnızca süresi dolmuş periyotlar (son periyot 1m verisinin ötesine taşıyorsa henüz kapanmamıştır)
  const lastEnd = c1.length ? c1[c1.length - 1].closeTime : -Infinity;
  return out.filter(c => c.closeTime <= lastEnd && c.closeTime < endTime).map(({ _last, ...c }) => c);
}

/**
 * Bir sembolü bir ya da birden çok varyantla, AYNI veri üzerinde test eder.
 *
 *   Normal mod  : taban 5m, yalnızca canlı kural — eski davranışın aynısı
 *   --compare   : taban 1m → 3m/5m/15m/1h/4h yarım mumları 1m'den kesin kurulur (look-ahead yok);
 *                 A (canlı kural) + Mert varyantları (src/mert.js) kendi karar anlarında değerlendirilir,
 *                 sonuçlar hepsinde 1m mumlarla ölçülür (aynı çözünürlük → adil karşılaştırma).
 *                 Her sinyal dönemin ilk 2/3'ünde ise "IS" (seçim), sonrasında "OOS" (doğrulama) etiketlenir.
 *
 * @returns {{ signals: object[], stats: object, variants: Object<string,{signals:object[], stats:object}> }}
 *          signals/stats = ilk tetikleyici (geriye uyumluluk)
 */
async function backtestSymbol(symbol, { startTime, endTime, minScore, compare = false, feePct = 0 }) {
  const trig     = getTriggers();
  const triggers = compare ? [trig.current, ...mertVariants()] : [trig.current];
  const M        = cfg.mert;
  const splitT   = selectionSplit(startTime, endTime);
  const baseTf   = compare ? '1m' : '5m';
  const baseMs   = TF_MS[baseTf];
  const viewTfs  = compare ? ['3m', '5m', '15m', '1h', '4h'] : ['5m', '15m', '1h', '4h'];

  // Isınma: canlı bot 200 mumluk tamponla başlıyor → her TF için başlangıçtan önce 200 mum.
  // Taban TF en az 1 gün geriden başlar (günlük seviyedeki "bugünkü yarım gün" eksiksiz kurulsun).
  const ranges = { [baseTf]: startTime - Math.max(BUFFER * TF_MS[compare ? '3m' : '5m'], TF_MS['1d']) };
  for (const tf of ['5m', '15m', '1h', '4h']) if (!(tf in ranges)) ranges[tf] = startTime - BUFFER * TF_MS[tf];
  // Mert seviyeleri (4h MA/EMA200) için daha uzun 4h geçmişi — 4h görünümü yine son 200 mumu kullanır
  if (compare) ranges['4h'] = startTime - Math.max(BUFFER, M.h4History) * TF_MS['4h'];
  ranges['1d'] = startTime - DAILY_WINDOW * TF_MS['1d'];

  // Sıralı çek (paralel değil) — rate limit koruması
  const data = {};
  for (const tf of Object.keys(ranges)) {
    data[tf] = await fetchRange(symbol, tf, ranges[tf], endTime);
  }
  if (compare) data['3m'] = aggregateClosed(data['1m'], TF_MS['3m'], endTime);

  const base = data[baseTf];
  const candles = Object.fromEntries(Object.entries(data).map(([tf, arr]) => [tf, arr.length]));
  const range   = base.length ? [base[0].openTime, base[base.length - 1].closeTime + 1] : null;

  const runs = triggers.map(t => ({
    trig:  t,
    tfs:   decisionTFs(t),
    need:  [...new Set([...t.rsiTFs, t.entryTF, '15m', '1h'])],   // canlı isReady(): 5m, 15m, 1h (+ Mert: 3m)
    lastSignalT: null,                                              // canlıdaki lastSignalAt ile aynı cooldown kuralı
    openUntil:   null,                                              // Mert: açık işlem bitene kadar yeni işlem yok
    signals: [],
    stats: t.kind === 'mert'
      ? { trigger: t.key, candles, range, decisions: 0, openBlocked: 0, location: 0, rsiOk: 0, separation: 0, planInvalid: 0, signals: 0 }
      : {
        trigger: t.key, candles, range,
        final: { fails: {}, only: {}, rsiDist: {}, rsiLowBy: {} },
        decisions: 0, cooldown: 0, nearLevel: 0, rsi1hOk: 0, rsi4hOk: 0, gatePass: 0,
        planInvalid: 0, belowScore: 0, signals: 0,
      },
  }));
  const rsiEvents = [];   // RSI olay çalışması (yalnızca canlı kural) — aşağıda
  const mertEvents = [];  // Mert olay çalışması (--compare) — aşağıda
  const result = () => ({
    signals: runs[0].signals, stats: runs[0].stats,
    variants: Object.fromEntries(runs.map(r => [r.trig.key, { signals: r.signals, stats: r.stats }])),
    rsiEvents, mertEvents,
  });

  if (base.length < BUFFER) {
    console.warn(`  [${symbol}] Yetersiz ${baseTf} veri (${base.length} mum) — atlandı`);
    return result();
  }

  const views = Object.fromEntries(viewTfs.map(tf => [tf, makeHtfView(tf === baseTf ? base : data[tf], TF_MS[tf])]));
  const holdBars = HOLD_MS / baseMs;

  let dailyKey = null;
  let daily    = null;
  const dailyAt = (T, i) => {   // 4 saatlik blok başına bir kez (canlı htfPoller gibi)
    const block = Math.floor(T / TF_MS['4h']) * TF_MS['4h'];
    if (block !== dailyKey) {
      daily    = dailyLevelsAt(block, data['1d'], base, i);
      dailyKey = block;
    }
    return daily;
  };

  // RSI olayı: aynı coinde EVENT_GAP içinde tekrar eden anlar tek olay (episode) sayılır
  let lastEventT = null, episodeNo = 0;
  let lastMertT = null, mertEpisodeNo = 0;
  const RSI_GATES = ['rsi1h', 'rsi4h', 'rsiLow', 'rsiHigh'];

  // Mert seviyeleri — 4 saatlik blok başına bir kez, o ana kadar KAPANMIŞ 4h mumlar + günlük liste ile
  let mertKey = null, mertLevels = [], p4 = 0;
  const h4 = data['4h'] || [];
  const levelsAt = (T, i) => {
    const B = Math.floor(T / TF_MS['4h']) * TF_MS['4h'];
    if (B !== mertKey) {
      while (p4 < h4.length && h4[p4].closeTime < B) p4++;
      const closes = h4.slice(Math.max(0, p4 - M.h4History), p4).map(c => c.close);
      mertLevels = calcLevelSet(closes, dailyListAt(B, data['1d'], base, i));
      mertKey = B;
    }
    return mertLevels;
  };

  for (let i = 0; i < base.length; i++) {
    const cur = base[i];
    // Yarım mumlar her taban mumla güncellenmeli — aşağıdaki "continue"lardan ÖNCE
    for (const tf of viewTfs) views[tf].push(cur);

    const T = cur.openTime + baseMs;                             // karar anı: taban mum kapanışı
    if (cur.openTime < startTime) continue;                      // ısınma bölgesi
    if (T + HOLD_MS > endTime) break;                            // sonucu ölçecek tam 4 saat yok

    const active = runs.filter(r => r.tfs.some(tf => T % TF_MS[tf] === 0));
    if (!active.length) continue;

    // Bu T için ortak hesaplar (tembel, önbellekli) — iki tetikleyici aynı veriyi görür
    const sliceCache = {}, indCache = {};
    const slice = tf => (sliceCache[tf] ??= views[tf].slice(T));
    const ind   = tf => (indCache[tf]   ??= computeAll(slice(tf)));
    const rsiCache = {};
    const rsiQ  = tf => (rsiCache[tf] ??= (indCache[tf]?.rsi ?? calcRSI(slice(tf).map(c => c.close))));

    // RSI şartı sağlandıysa olayı kaydet: takıldığı diğer kapılar, ileri getiriler, canlı planla varsayımsal sonuç
    const recordRsiEvent = (i, T, price) => {
      // Ucuzdan pahalıya: 1h → 4h → 5m → 15m (çoğu an 1h'de elenir)
      if (!(rsiQ('1h') >= cfg.rsi1hMin)) return;
      const r4h = slice('4h').length >= MIN_CANDLES ? rsiQ('4h') : null;
      if (!(r4h >= cfg.rsi4hMin) || !(rsiQ('5m') >= cfg.rsi5mMin) || !(rsiQ('15m') >= cfg.rsi15mMin)) return;

      const i5 = ind('5m');
      const { nearDailyLevel } = nearLevelInfo(price, dailyAt(T, i));
      const regime = detectRegime({ indicators: i5, oiDeltaPct: null, fundingRate: null, candles: slice('5m') });
      const gp = {
        rsi5m: i5.rsi, rsi15m: ind('15m').rsi, rsi1h: ind('1h').rsi, rsi4h: ind('4h').rsi,
        ema21Distance: i5.distance, ema21Touched: i5.touched, nearDailyLevel, regime,
      };
      // Tanım gates.js'ten: RSI kapılarından hiçbirine takılmamalı (üst sınır dahil)
      const fails = listFailures(gp);
      if (fails.some(k => RSI_GATES.includes(k))) return;

      if (lastEventT == null || T - lastEventT > EVENT_GAP_MS) episodeNo++;
      const first = lastEventT == null || T - lastEventT > EVENT_GAP_MS;
      lastEventT = T;

      // İleri getiriler (SHORT yönünde: + = fiyat düştü) ve 4 saatlik MFE/MAE
      const at = ms => base[i + ms / baseMs]?.close;
      const ret = c => (c != null ? +((price - c) / price * 100).toFixed(3) : null);
      let mfe = 0, mae = 0;
      for (const c of base.slice(i + 1, i + 1 + holdBars)) {
        mfe = Math.max(mfe, (price - c.low) / price * 100);
        mae = Math.max(mae, (c.high - price) / price * 100);
      }
      const plan = calcTradePlan({ entryPrice: price, ema21: i5.ema21, atr: i5.atr, initialRiskPct: cfg.initialRiskPct });
      const oc = plan.valid ? simulateOutcome({
        entryPrice: price, tpA: plan.tpA, tpB: plan.tpB, slLevel: plan.slLevel,
        initialRiskPct: cfg.initialRiskPct, sentAt: T,
      }, base.slice(i + 1, i + 1 + holdBars), baseMs) : null;

      const r2 = x => (x != null && Number.isFinite(x) ? +x.toFixed(2) : null);
      rsiEvents.push({
        symbol, ts: T, date: new Date(T).toISOString(), period: T < splitT ? 'IS' : 'OOS',
        episode: `${symbol}#${episodeNo}`, first,
        price, rsi5m: r2(gp.rsi5m), rsi15m: r2(gp.rsi15m), rsi1h: r2(gp.rsi1h), rsi4h: r2(gp.rsi4h),
        fails,                                  // takıldığı DİĞER kapılar (boş = sinyal olurdu; skor/cooldown hariç)
        regime, nearDailyLevel, ema21Distance: r2(i5.distance),
        ret15m: ret(at(15 * MIN)), ret1h: ret(at(60 * MIN)), ret4h: ret(at(HOLD_MS)),
        mfe4h: +mfe.toFixed(3), mae4h: +mae.toFixed(3),
        planValid: plan.valid,
        outcome: oc?.outcome ?? null, pnlPct: oc?.pnlPct ?? null,
        netR: oc ? netR(oc.pnlPct, feePct) : null,
      });
    };

    // ── Mert olay çalışması: 3m/5m/15m'den en az eventMinTFs tanesi ≥ eventRsiMin olan HER an ──
    //    Yer, güven (1h/4h), ayrışma FİLTRELENMEZ; kaydedilir → hangi değerin sonuç verdiği ölçülür.
    const recordMertEvent = (i, T, price) => {
      if (['3m', '5m', '15m'].some(tf => slice(tf).length < MIN_CANDLES)) return;
      const rs = { '3m': rsiQ('3m'), '5m': rsiQ('5m'), '15m': rsiQ('15m') };
      const hitTFs = M.rsiTFs.filter(tf => rs[tf] >= M.eventRsiMin);
      if (hitTFs.length < M.eventMinTFs) return;

      const first = lastMertT == null || T - lastMertT > EVENT_GAP_MS;
      if (first) mertEpisodeNo++;
      lastMertT = T;

      // Seviyeler: her birine uzaklık (%; − = fiyat seviyenin altında), en yakın seviye, en yakın ÜST seviye
      const levels = levelsAt(T, i);
      const dists = Object.fromEntries(levels.map(l => [l.name, +((price - l.value) / l.value * 100).toFixed(3)]));
      const nearest = levels.map(l => ({ ...l, d: (price - l.value) / l.value * 100 })).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0] || null;
      const above = levels.filter(l => l.value >= price).sort((a, b) => a.value - b.value)[0] || null;

      const r1h = slice('1h').length >= MIN_CANDLES ? rsiQ('1h') : null;
      const r4h = slice('4h').length >= MIN_CANDLES ? rsiQ('4h') : null;
      const i3 = ind('3m'), i5 = ind('5m');
      const back = base[i - HOUR_MS / baseMs];
      const rise1h = back ? +((price - back.close) / back.close * 100).toFixed(3) : null;   // son 1 saatte yükseliş %

      // İleri getiriler (SHORT: + = lehe) ve 4 saatlik MFE/MAE
      const fut = base.slice(i + 1, i + 1 + holdBars);
      const at = ms => base[i + ms / baseMs]?.close;
      const ret = c => (c != null ? +((price - c) / price * 100).toFixed(3) : null);
      let mfe = 0, mae = 0;
      for (const c of fut) { mfe = Math.max(mfe, (price - c.low) / price * 100); mae = Math.max(mae, (c.high - price) / price * 100); }

      // Mert planı (TP-A 3m EMA21, TP-B 5m EMA21) üç stopla: %1, %1.5, en yakın üst seviyenin %0.3 üstü
      const tpA = i3.ema21, tpB = i5.ema21;
      const planOk = Number.isFinite(tpA) && tpA < price;
      const sim = slPx => {
        if (!planOk || !(slPx > price)) return null;
        const riskPct = (slPx - price) / price * 100;
        const oc = simulateOutcome({ entryPrice: price, tpA, tpB: tpB < tpA ? tpB : null, slLevel: slPx, initialRiskPct: riskPct, sentAt: T }, fut, baseMs);
        return { outcome: oc.outcome, netR: netR(oc.pnlPct, feePct, riskPct), pnlPct: oc.pnlPct, riskPct: +riskPct.toFixed(3) };
      };
      const lvlStop = above && (above.value - price) / price * 100 <= M.levelStopMaxPct ? above.value * (1 + M.levelStopPct / 100) : null;

      const r2 = x => (x != null && Number.isFinite(x) ? +x.toFixed(2) : null);
      mertEvents.push({
        symbol, ts: T, date: new Date(T).toISOString(), period: T < splitT ? 'IS' : 'OOS',
        episode: `${symbol}#${mertEpisodeNo}`, first, price,
        rsi3m: r2(rs['3m']), rsi5m: r2(rs['5m']), rsi15m: r2(rs['15m']), hitTFs: hitTFs.length,
        rsi1h: r2(r1h), rsi4h: r2(r4h), confidence: confidence(r1h, r4h),
        separated: separationOk(i3, i5), dist3m: r2(i3.distance), dist5m: r2(i5.distance),
        levelDists: dists,
        nearestLevel: nearest ? nearest.name : null, nearestDistPct: nearest ? +nearest.d.toFixed(3) : null,
        aboveLevel: above ? above.name : null, aboveDistPct: above ? +((above.value - price) / price * 100).toFixed(3) : null,
        rise1h,
        ret15m: ret(at(15 * MIN)), ret1h: ret(at(HOUR_MS)), ret4h: ret(at(HOLD_MS)),
        mfe4h: +mfe.toFixed(3), mae4h: +mae.toFixed(3),
        tpAPct: planOk ? +((price - tpA) / price * 100).toFixed(3) : null,
        sl10: sim(price * 1.01), sl15: sim(price * 1.015), slLvl: lvlStop ? sim(lvlStop) : null,
      });
    };
    if (compare && (T % TF_MS['3m'] === 0 || T % TF_MS['5m'] === 0)) recordMertEvent(i, T, cur.close);

    for (const run of active) {
      const { trig: t, stats } = run;
      stats.decisions++;

      // ── Mert varyantı (src/mert.js) — pahalı hesaplardan önce ucuz filtreler ──
      if (t.kind === 'mert') {
        if (run.openUntil != null && T < run.openUntil) { stats.openBlocked++; continue; }
        const price = cur.close;
        const loc = locate(price, levelsAt(T, i));
        if (!loc) continue;
        stats.location++;
        if (run.need.some(tf => slice(tf).length < MIN_CANDLES)) continue;
        const rs = { rsi3m: ind('3m').rsi, rsi5m: ind('5m').rsi, rsi15m: ind('15m').rsi };
        if (!rsiCheck(t, rs).pass) continue;
        stats.rsiOk++;
        if (!separationOk(ind('3m'), ind('5m'))) continue;
        stats.separation++;
        const plan = makePlan(price, ind('3m').ema21, ind('5m').ema21, t.slPct);
        if (!plan.valid) { stats.planInvalid++; continue; }
        // Güven puanı (zorunlu değil): 1h / 4h RSI ≥ 70
        const r1h = ind('1h').rsi;
        const r4h = slice('4h').length >= MIN_CANDLES ? ind('4h').rsi : null;
        const conf = confidence(r1h, r4h);

        const outcome = simulateOutcome({
          entryPrice: price, tpA: plan.tpA, tpB: plan.tpB, slLevel: plan.slLevel,
          initialRiskPct: t.slPct, sentAt: T,
        }, base.slice(i + 1, i + 1 + holdBars), baseMs);
        run.openUntil = outcome.resolvedAt ?? T + HOLD_MS;   // işlem kapanana kadar bu coinde yeni işlem yok
        stats.signals++;
        const r2 = x => (x != null && Number.isFinite(x) ? +x.toFixed(2) : null);
        run.signals.push({
          symbol, trigger: t.key, period: T < splitT ? 'IS' : 'OOS',
          ts: T, date: new Date(T).toISOString(),
          entryPrice: price, tpA: plan.tpA, tpB: plan.tpB, slLevel: plan.slLevel, slPct: t.slPct,
          level: loc.name, levelValue: loc.value, levelDistPct: +loc.distPct.toFixed(3),
          rsi3m: r2(rs.rsi3m), rsi5m: r2(rs.rsi5m), rsi15m: r2(rs.rsi15m), rsi1h: r2(r1h), rsi4h: r2(r4h),
          confidence: conf,
          dist3m: r2(ind('3m').distance), dist5m: r2(ind('5m').distance),
          tpAPct: +((price - plan.tpA) / price * 100).toFixed(3),     // hedefe uzaklık %
          ...outcome,
          netR: netR(outcome.pnlPct, feePct, t.slPct),
        });
        continue;
      }

      // ── RSI olay çalışması: canlı kuralın RSI şartları (5m/15m/1h/4h + üst sınır) sağlanan HER an ──
      //    Diğer kapılardan ve cooldown'dan BAĞIMSIZ kaydedilir; mevcut sinyal akışını değiştirmez.
      if (t.key === 'current' && run.need.every(tf => slice(tf).length >= MIN_CANDLES)) {
        recordRsiEvent(i, T, cur.close);
      }

      // Cooldown — canlı signalEngine ile aynı kural (cfg.cooldownMs)
      if (run.lastSignalT != null && T - run.lastSignalT < cfg.cooldownMs) { stats.cooldown++; continue; }

      // ── Günlük seviye (4 saatlik blok başına bir kez, canlı htfPoller gibi) ──
      dailyAt(T, i);

      const price = cur.close;
      const { nearDailyLevel, dailyProximity } = nearLevelInfo(price, daily);

      // Aşağıdaki erken "continue"lar yalnızca hız içindir: gates.js'teki tüm kapılar VE ile
      // bağlı olduğundan, bir kapı kalırsa sonuç zaten "reddedildi" olur. Son karar yine
      // checkGates() ile birebir verilir.
      if (!nearDailyLevel) continue;
      stats.nearLevel++;

      if (run.need.some(tf => slice(tf).length < MIN_CANDLES)) continue;   // canlı isReady()

      const ind1h = ind('1h');
      if (!ind1h.rsi || ind1h.rsi < cfg.rsi1hMin) continue;
      stats.rsi1hOk++;

      const ind4h = slice('4h').length >= MIN_CANDLES ? ind('4h') : null;
      if (!ind4h?.rsi || ind4h.rsi < cfg.rsi4hMin) continue;
      stats.rsi4hOk++;

      const indE = ind(t.entryTF);   // giriş TF'i: EMA21 uzaklığı/dokunuşu, ATR, TP, hacim, rejim
      const regime = detectRegime({ indicators: indE, oiDeltaPct: null, fundingRate: null, candles: slice(t.entryTF) });

      const gateParams = {
        rsi15m:        ind('15m').rsi,          // EMC (15m RSI 95+) her iki tetikleyicide de 15m'den
        rsi1h:         ind1h.rsi,
        rsi4h:         ind4h.rsi,
        ema21Distance: indE.distance,
        ema21Touched:  indE.touched,
        nearDailyLevel,
        regime,
      };
      for (const tf of t.rsiTFs) gateParams['rsi' + tf] = ind(tf).rsi;

      // ── Son aşama dökümü (günlük seviye + 1h + 4h'yi geçen adaylar) ──
      //   fails[k]  : bu kapıya takılan aday sayısı (başka kapılara da takılmış olabilir)
      //   only[k]   : YALNIZCA bu kapıya takılan aday → bu kapı olmasaydı sinyal olurdu
      //   rsiDist   : tetikleyici RSI dağılımı → giriş eşiğinin ne kadar seçici olduğu
      const failed = listFailures(gateParams, t);
      for (const k of failed) stats.final.fails[k] = (stats.final.fails[k] || 0) + 1;
      if (failed.length === 1) stats.final.only[failed[0]] = (stats.final.only[failed[0]] || 0) + 1;
      const pr = primaryRSI(gateParams, t);
      const bucket = RSI_BUCKETS.find(b => pr < b.max).label;
      stats.final.rsiDist[bucket] = (stats.final.rsiDist[bucket] || 0) + 1;
      //   rsiLowBy  : RSI eşiğine hangi TF'nin takıldığı (5m / 15m ayrı ayrı; bir aday ikisine de takılabilir)
      for (const [tf] of rsiShortfalls(gateParams, t)) stats.final.rsiLowBy[tf] = (stats.final.rsiLowBy[tf] || 0) + 1;

      const gateResult = checkGates(gateParams, t);
      if (!gateResult.pass) continue;
      stats.gatePass++;

      // ── İşlem planı — canlı ile aynı sıra: kapı → plan → skor ──
      const plan = calcTradePlan({
        entryPrice:     price,
        ema21:          indE.ema21,
        atr:            indE.atr,
        initialRiskPct: cfg.initialRiskPct,
      });
      if (!plan.valid) { stats.planInvalid++; continue; }

      const { score, grade, breakdown } = calcScore({
        rsi:           pr,
        ema21Distance: indE.distance,
        dailyProximity,
        volRatio:      indE.volRatio,
        cvdDir:        indE.cvdDir,
        oiDeltaPct:    null,
        negPeaks:      indE.negPeaks,
        hasEMC:        gateResult.hasEMC,
      });
      if (score < minScore) { stats.belowScore++; continue; }

      const futureCandles = base.slice(i + 1, i + 1 + holdBars);
      const outcome = simulateOutcome({
        entryPrice: price, tpA: plan.tpA, tpB: plan.tpB, slLevel: plan.slLevel,
        initialRiskPct: cfg.initialRiskPct, sentAt: T,
      }, futureCandles, baseMs);

      run.lastSignalT = T;
      stats.signals++;
      const r2 = x => (x != null ? +x.toFixed(2) : null);
      run.signals.push({
        symbol,
        trigger: t.key,
        entryTF: t.entryTF,
        period: T < splitT ? 'IS' : 'OOS',
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
        rsi5m:   r2(ind('5m').rsi),
        rsi15m:  r2(gateParams.rsi15m),
        rsi1h:   r2(ind1h.rsi),
        rsi4h:   r2(ind4h.rsi),
        ema21Distance:  +indE.distance.toFixed(3),
        volumeRatio:    +indE.volRatio.toFixed(2),
        cvdDir:         indE.cvdDir,
        dailyProximity: +dailyProximity.toFixed(3),
        ...outcome,
        netR: netR(outcome.pnlPct, feePct),
        scoreBreakdown: breakdown,
      });
    }
  }

  return result();
}

/** Komisyon dahil R: giriş + çıkış (2 × feePct) pnl'den düşülür. Yalnızca raporlama içindir. */
function netR(pnlPct, feePct, riskPct = cfg.initialRiskPct) {
  if (pnlPct == null) return null;
  return +((pnlPct - 2 * feePct) / riskPct).toFixed(3);
}

/** Walk-forward sınırı: dönemin ilk selectionFraction'ı seçim (IS), kalanı doğrulama (OOS); 5m'ye hizalı */
function selectionSplit(startTime, endTime) {
  const f = cfg.mert.selectionFraction;
  return startTime + Math.round((endTime - startTime) * f / TF_MS['5m']) * TF_MS['5m'];
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
 * barMs: çubuk boyu (normal mod 5m, --compare 1m). *Candle alanları bu çubuk cinsindendir.
 */
function simulateOutcome(trade, futureCandles, barMs = TF_MS['5m']) {
  const t = createTrade(trade);
  let bars = 0;
  for (const c of futureCandles.slice(0, HOLD_MS / barMs)) {
    applyBar(t, { ts: c.closeTime + 1, high: c.high, low: c.low, close: c.close });
    bars++;
    if (t.finalizedAt != null) break;
  }
  const rec = toRecord(t);
  const barIndex = ts => (ts == null ? null : Math.round((ts - trade.sentAt) / barMs) - 1);
  return {
    ...rec,
    tpHitCandle:  barIndex(rec.tpHitAt),
    tpBHitCandle: barIndex(rec.tpBHitAt),
    slHitCandle:  barIndex(rec.slHitAt),
    holdingCandles: bars,
    barMinutes: barMs / 60000,
  };
}

// ── Ana fonksiyon ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const DAYS      = parseInt(args.days || 90, 10);
  const MIN_SCORE = parseInt(args['min-score'] ?? cfg.minScoreToSend, 10);

  // RSI eşiklerini kodu değiştirmeden denemek için (yalnızca bu backtest çalışmasında geçerli)
  for (const [flag, key] of [['rsi5m', 'rsi5mMin'], ['rsi15m', 'rsi15mMin'], ['rsi1h', 'rsi1hMin'], ['rsi4h', 'rsi4hMin'], ['rsi-max', 'rsiEntryMax']]) {
    if (args[flag] == null) continue;
    const v = Number(args[flag]);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`Geçersiz --${flag}: ${args[flag]} (0–100 olmalı)`);
    cfg[key] = v;
  }
  const COMPARE   = Boolean(args.compare);
  const FEE_PCT   = Number(args['fee-pct'] ?? DEFAULT_FEE_PCT);

  if (!Number.isFinite(DAYS) || DAYS < 1) throw new Error(`Geçersiz --days: ${args.days}`);
  if (!Number.isFinite(FEE_PCT) || FEE_PCT < 0 || FEE_PCT > 1) throw new Error(`Geçersiz --fee-pct: ${args['fee-pct']}`);

  // Sembol listesi: --symbol A,B | --all (hacim filtreli tüm USDT perpetual'lar) | config.testSymbols
  let SYMBOLS;
  let universe = 'config.testSymbols';
  if (args.all) {
    const minVol = Number(args['min-volume'] ?? cfg.autoFilter.minVolume24hUSDT);
    const maxCoins = Number(args['max-coins'] ?? 0);
    const { getLiquidSymbols } = require('./binanceClient');
    SYMBOLS = await getLiquidSymbols({ minVolume24hUSDT: minVol, maxCoins, excludeBaseAssets: cfg.autoFilter.excludeBaseAssets });
    universe = `--all (24s hacim ≥ ${minVol.toLocaleString()} USDT${maxCoins > 0 ? `, en likit ${maxCoins}` : ''})`;
    if (!SYMBOLS.length) throw new Error('--all: filtreye uyan sembol yok (--min-volume düşürülebilir)');
  } else if (args.symbol) {
    SYMBOLS = String(args.symbol).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    universe = '--symbol';
  } else {
    SYMBOLS = cfg.testSymbols;
  }

  // --telegram: bitince tek bir özet rapor mesajı (canlı gönderim yolunu da test eder)
  const SEND_TG = Boolean(args.telegram);
  if (SEND_TG) {
    const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(k => !process.env[k]);
    if (missing.length) throw new Error(`--telegram için eksik ortam değişkeni: ${missing.join(', ')}`);
  }

  // Son kapanmış 5m sınırına hizala
  const endTime   = Math.floor(Date.now() / TF_MS['5m']) * TF_MS['5m'];
  const startTime = endTime - DAYS * TF_MS['1d'];

  const trig     = getTriggers();
  const triggers = COMPARE ? [trig.current, ...mertVariants()] : [trig.current];
  const mertTs   = triggers.filter(t => t.kind === 'mert');
  const splitT   = selectionSplit(startTime, endTime);

  const OUT_DIR = path.join(__dirname, '..', 'backtest-results');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('\n════════════════════════════════════════════');
  console.log(`  Scalp Bot — Backtest Motoru${COMPARE ? ' (canlı kural + Mert varyantları)' : ''}`);
  console.log(`  Semboller  : ${SYMBOLS.length} adet — ${universe}`);
  console.log(`              ${SYMBOLS.slice(0, 12).join(', ')}${SYMBOLS.length > 12 ? ` … (+${SYMBOLS.length - 12})` : ''}`);
  console.log(`  Dönem      : ${fmtDate(startTime)} → ${fmtDate(endTime)} (${DAYS} gün)  |  Min skor: ${MIN_SCORE}`);
  console.log(`  RSI kuralı : ${rsiRuleText()}${COMPARE ? '  (A — canlı kural)' : ''}`);
  if (COMPARE) {
    const g = cfg.mert.grid;
    console.log(`  Mert       : ${mertRuleText()}`);
    console.log(`               ${mertTs.length} kombinasyon: RSI ≥ ${g.rsiMin.join('/')} · ${g.minTFs.join('/')} TF · SL %${g.slPct.join('/')}`);
    console.log(`  Walk-forward: seçim ${fmtDate(startTime)} → ${fmtDate(splitT)} · doğrulama ${fmtDate(splitT)} → ${fmtDate(endTime)}`);
    console.log('  Not        : 1m veri çekilir; sonuçlar 1m mumlarla ölçülür → sembol başına ~3-4 kat uzun sürer');
  }
  console.log(`  Komisyon   : %${FEE_PCT} × 2 (giriş+çıkış) — yalnızca "net R" değerlerine yansır`);
  if (args.all) console.log('  Not        : liste BUGÜNKÜ hacme göre seçildi — dönem içinde listeden çıkan coinler yok (survivorship).');
  console.log('════════════════════════════════════════════\n');

  const results = Object.fromEntries(triggers.map(t => [t.key, []]));
  const stats   = Object.fromEntries(triggers.map(t => [t.key, {}]));
  const rsiEvents = [];
  const mertEvents = [];
  const tStart  = Date.now();

  for (const [idx, symbol] of SYMBOLS.entries()) {
    const done = idx;
    const eta  = done > 0 ? Math.round((Date.now() - tStart) / done * (SYMBOLS.length - done) / 60000) : null;
    console.log(`\n[${idx + 1}/${SYMBOLS.length}] ${symbol} — veri çekiliyor...${eta != null ? ` (tahmini kalan ~${eta} dk)` : ''}`);
    try {
      const res = await backtestSymbol(symbol, { startTime, endTime, minScore: MIN_SCORE, compare: COMPARE, feePct: FEE_PCT });
      printCoverage(symbol, res.stats);
      for (const t of triggers) {
        const v = res.variants[t.key];
        results[t.key].push(...v.signals);
        stats[t.key][symbol] = v.stats;
      }
      printSymbolSummary(COMPARE ? `${symbol} A` : symbol, res.variants.current.signals);
      rsiEvents.push(...res.rsiEvents);
      mertEvents.push(...res.mertEvents);
      if (COMPARE && res.mertEvents.length) console.log(`  [${symbol}] Mert RSI olayı: ${res.mertEvents.length} an, ${res.mertEvents.filter(e => e.first).length} olay`);
      const eps = new Set(res.rsiEvents.map(e => e.episode)).size;
      if (res.rsiEvents.length) console.log(`  [${symbol}] RSI şartı: ${res.rsiEvents.length} an, ${eps} olay`);
      if (COMPARE) {
        const counts = mertTs.map(t => [t.short, res.variants[t.key].signals.length]).filter(([, n]) => n);
        console.log(`  [${symbol}] Mert sinyalleri: ${counts.length ? counts.map(([k, n]) => `${k}: ${n}`).join(' · ') : 'yok'}`);
      }
    } catch (err) {
      console.error(`  [${symbol}] Hata — atlandı:`, err?.message || err?.body || err);
    }
  }

  console.log('\n\n════════════════════════════════════════════');
  console.log(COMPARE ? '  RAPOR A — canlı kural' : '  GENEL RAPOR');
  console.log('════════════════════════════════════════════');
  printFunnel(stats.current, trig.current);
  printGradeBreakdown(results.current);
  printRegimeBreakdown(results.current);
  printEMCBreakdown(results.current);
  printScoreCalibration(results.current);
  printRsiEvents(rsiEvents);
  const selection = COMPARE ? selectMert(mertTs, results) : null;
  if (COMPARE) printMertReport({ triggers, stats, results, selection, startTime, endTime, splitT, feePct: FEE_PCT });
  if (COMPARE) printMertEvents(mertEvents);

  const params    = {
    SYMBOLS, DAYS, MIN_SCORE, startTime, endTime, universe, compare: COMPARE, feePct: FEE_PCT, splitT,
    rsi: { m5: cfg.rsi5mMin, m15: cfg.rsi15mMin, h1: cfg.rsi1hMin, h4: cfg.rsi4hMin, max: cfg.rsiEntryMax },
  };
  const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19);
  const outFile   = path.join(OUT_DIR, `backtest-${COMPARE ? 'compare-' : ''}${timestamp}.json`);
  const payload   = COMPARE
    ? { params, mert: cfg.mert, selection, variants: Object.fromEntries(triggers.map(t => [t.key, { trigger: t, stats: stats[t.key], signals: results[t.key] }])), rsiEvents, mertEvents }
    : { params, stats: stats.current, signals: results.current, rsiEvents };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\n📁 Detaylı sonuçlar: ${outFile}\n`);

  if (SEND_TG) {
    // telegram.js yalnızca burada yüklenir; komut dinleme (polling) BAŞLATILMAZ → canlı botla çakışmaz
    const telegram = require('./telegram');
    const text = COMPARE
      ? buildCompareTelegramReport(params, triggers, stats, results, selection, telegram.esc, rsiEvents)
      : buildTelegramReport(params, stats.current, results.current, telegram.esc, undefined, rsiEvents);
    telegram.sendText(text);
    if (COMPARE) telegram.sendText(buildMertEventsTelegram(params, mertEvents, telegram.esc));   // ikinci mesaj
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

const LETTERS = ['A', 'B', 'C', 'D'];
// Binance USDⓈ-M taker komisyonu (VIP 0, BNB indirimi yok) — --fee-pct ile değiştirilebilir
const DEFAULT_FEE_PCT = 0.05;

/** Karar anı etiketi: diğerinin katı olan TF'ler gösterilmez (5m/15m → "5m", 3m/5m/15m → "3m/5m") */
function decisionLabel(t) {
  const tfs = decisionTFs(t);
  return tfs.filter(tf => !tfs.some(o => o !== tf && TF_MS[tf] % TF_MS[o] === 0)).join('/');
}

function mertRuleText() {
  const m = cfg.mert;
  return `3/5/15m RSI (en az N TF${m.rsiCap != null ? `, 3m-5m ≤ ${m.rsiCap}` : ', üst sınır yok'}) · güven puanı: 1h ≥ ${m.rsi1hMin}, 4h ≥ ${m.rsi4hMin} (zorunlu değil) · ` +
    `4h/1d MA-EMA200 veya günlük direncin dibi (altında ≤ %${m.levelBelowPct}, üstünde ≤ %${m.levelAbovePct}) · ` +
    `3m ve 5m EMA21'den ≥ ${m.separationATR} ATR ayrışma · TP-A 3m EMA21, TP-B 5m EMA21 · açık işlem varken yeni işlem yok`;
}

/** Bir sinyal grubunun performansı */
function perf(signals) {
  const n = signals.length;
  const cnt = o => signals.filter(s => s.outcome === o).length;
  const holds = signals.map(s => s.holdingTimeMs).filter(v => v != null);
  const wins = signals.filter(s => (s.netR ?? 0) > 0).map(s => s.netR);
  const losses = signals.filter(s => (s.netR ?? 0) <= 0).map(s => s.netR ?? 0);
  // Başabaş isabet: ortalama kazanç ve kayıp (net R) büyüklüğüne göre gereken kazanan oranı
  const aw = wins.length ? avg(wins) : null, al = losses.length ? avg(losses) : null;
  return {
    n, win: cnt('WIN'), loss: cnt('LOSS'), ltr: cnt('LOSS_THEN_RECOVER'), neutral: cnt('NEUTRAL'),
    winRate: n ? cnt('WIN') / n * 100 : null,
    avgR:    n ? avg(signals.map(s => s.rMultiple)) : null,
    avgNetR: n ? avg(signals.map(s => s.netR)) : null,
    sumNetR: n ? signals.reduce((a, s) => a + (s.netR ?? 0), 0) : null,
    tpB:     n ? signals.filter(s => s.tpBHitAt != null).length / n * 100 : null,
    holdMin: holds.length ? avg(holds) / 60000 : null,
    coins:   new Set(signals.map(s => s.symbol)).size,
    breakeven: aw != null && al != null && aw - al > 0 ? -al / (aw - al) * 100 : null,
  };
}
const byPeriod = sigs => ({
  IS:  perf(sigs.filter(s => s.period === 'IS')),
  OOS: perf(sigs.filter(s => s.period === 'OOS')),
  ALL: perf(sigs),
});

// Seçim için seçim dönemindeki en az sinyal sayısı (daha azıyla "seçim" gürültüden ibaret olur)
const MIN_SELECTION_N = 10;

/** Walk-forward seçimi: SEÇİM dönemindeki toplam net R'si en yüksek Mert kombinasyonu (doğrulama verisine bakılmaz) */
function selectMert(mertTs, results) {
  const cands = mertTs.map(t => ({ t, is: perf(results[t.key].filter(s => s.period === 'IS')) }));
  if (!cands.length) return null;
  const enough = cands.filter(c => c.is.n >= MIN_SELECTION_N);
  const pool = (enough.length ? enough : cands).slice()
    .sort((a, b) => (b.is.sumNetR ?? -Infinity) - (a.is.sumNetR ?? -Infinity) || b.is.n - a.is.n);
  return { key: pool[0].t.key, lowSample: !enough.length };
}

const fmtN = (v, d = 2, suf = '') => (v == null ? '—' : (v > 0 && d === 2 ? '+' : '') + v.toFixed(d) + suf);

function printMertReport({ triggers, stats, results, selection, startTime, endTime, splitT, feePct }) {
  const days = (a, b) => Math.round((b - a) / TF_MS['1d']);
  console.log('\n\n════════════════════════════════════════════');
  console.log('  ⚖️  MERT VARYANTLARI — walk-forward');
  console.log('════════════════════════════════════════════');
  console.log(`  Kurallar : ${mertRuleText()}`);
  console.log(`  Seçim    : ${fmtDate(startTime)} → ${fmtDate(splitT)} (${days(startTime, splitT)} gün) — en iyi kombinasyon YALNIZCA burada seçilir`);
  console.log(`  Doğrulama: ${fmtDate(splitT)} → ${fmtDate(endTime)} (${days(splitT, endTime)} gün) — seçilen kombinasyonun görmediği veri`);
  console.log(`  Net R: komisyon %${feePct} × 2 düşülmüş; R = kâr% / stop%\n`);
  const col = p => `${String(p.n).padStart(4)} ${fmtN(p.winRate, 1, '%').padStart(7)} ${fmtN(p.avgNetR).padStart(7)} ${fmtN(p.sumNetR, 1).padStart(7)}`;
  console.log(`  ${'Varyant'.padEnd(24)} ${'── Seçim ──────────────────'.padEnd(28)} ${'── Doğrulama ──────────────'}`);
  console.log(`  ${''.padEnd(24)} ${'   n    Win%  OrtNet  ΣNet'.padEnd(28)} ${'   n    Win%  OrtNet  ΣNet'}`);
  for (const t of triggers) {
    const bp = byPeriod(results[t.key]);
    const name = t.kind === 'mert' ? t.short + (selection?.key === t.key ? '  ◀' : '') : 'A canlı (SL %0.5)';
    console.log(`  ${name.padEnd(24)} ${col(bp.IS).padEnd(28)} ${col(bp.OOS)}`);
  }
  console.log('  (Mert satırı: RSI eşiği · kaç TF · stop %)');

  if (selection) {
    const t = triggers.find(x => x.key === selection.key);
    const bp = byPeriod(results[t.key]);
    console.log(`\n  ➜ Seçilen: ${t.label}  (seçim döneminde toplam net R ${fmtN(bp.IS.sumNetR, 1)}, ${bp.IS.n} sinyal${selection.lowSample ? ` — UYARI: hiçbir kombinasyon ${MIN_SELECTION_N} sinyale ulaşmadı` : ''})`);
    const o = bp.OOS;
    console.log(`    Doğrulamada: ${o.n} sinyal · win ${fmtN(o.winRate, 1, '%')} · ort net R ${fmtN(o.avgNetR)} · toplam ${fmtN(o.sumNetR, 1)}R · W/L/LTR/N ${o.win}/${o.loss}/${o.ltr}/${o.neutral} · TP-B ${fmtN(o.tpB, 0, '%')} · sonuca ${fmtN(o.holdMin, 0)} dk`);
    const a = bp.ALL;
    if (a.breakeven != null) console.log(`    Tüm dönem: başabaş için gereken isabet ~%${a.breakeven.toFixed(0)}, gerçekleşen %${fmtN(a.winRate, 0)}`);
    if (o.n < MIN_SELECTION_N) console.log(`    ⚠️ Doğrulamada ${o.n} sinyal — kesin sonuç için az; daha uzun dönem (--days) ya da daha çok coin gerekir`);

    // Huni (tüm dönem, seçilen kombinasyon)
    const sum = k => Object.values(stats[t.key]).reduce((x, st) => x + (st[k] || 0), 0);
    console.log(`\n  🔻 Huni (seçilen, tüm dönem): karar ${sum('decisions')} → açık işlem nedeniyle atlanan ${sum('openBlocked')} → ` +
      `seviye dibinde ${sum('location')} → RSI ${sum('rsiOk')} → ayrışma ${sum('separation')} → sinyal ${sum('signals')}`);
    const byConf = [0, 1, 2].map(c => { const q = perf(results[t.key].filter(x => x.confidence === c)); return `${c}: ${q.n} (win ${fmtN(q.winRate, 0, '%')}, net ${fmtN(q.avgNetR)})`; });
    console.log(`  🔒 Güven puanına göre (1h/4h RSI ≥ 70 sayısı): ${byConf.join(' · ')}`);

    // Seviyeye göre
    const byLevel = {};
    for (const s of results[t.key]) (byLevel[s.level] ??= []).push(s);
    const lv = Object.entries(byLevel).map(([k, arr]) => { const p = perf(arr); return `${k}: ${p.n} (win ${fmtN(p.winRate, 0, '%')}, net ${fmtN(p.avgNetR)})`; });
    if (lv.length) console.log(`  📍 Seviyeye göre: ${lv.join(' · ')}`);
  }
  console.log('\n  Okuma: seçim dönemindeki sıralama ayar yapmaktır; asıl kanıt DOĞRULAMA sütunudur.');
}

/**
 * Karşılaştırma modu Telegram raporu (tek mesaj, ≤ 4096 karakter) — telefonda okunur
 */
function buildCompareTelegramReport(p, triggers, stats, results, selection, esc, rsiEvents = []) {
  const days = (a, b) => Math.round((b - a) / TF_MS['1d']);
  const lines = [
    '🧪 <b>BACKTEST — MERT VARYANTLARI</b>',
    '<i>Geçmiş veri simülasyonu — canlı sinyal DEĞİLDİR</i>',
    '',
    `📅 ${fmtDate(p.startTime)} → ${fmtDate(p.endTime)} UTC (${p.DAYS} gün)`,
    `🔀 Seçim: ilk ${days(p.startTime, p.splitT)} gün · Doğrulama: son ${days(p.splitT, p.endTime)} gün`,
    `🪙 ${p.SYMBOLS.length} sembol${p.universe ? ` (${esc(p.universe)})` : ''}`,
    `<i>Sonuçlar 1m mumlarla · R: komisyon %${p.feePct}×2 dahil ortalama net R</i>`,
    '',
    `<b>Mert kuralları:</b> ${esc('3/5/15m RSI (üst sınır yok) · 4h/1d MA-EMA200 ya da günlük direnç dibi · 3m ve 5m EMA21\'den ayrışma · TP 3m EMA21 · açık işlem varken yeni işlem yok · 1h/4h RSI ≥ 70 = güven puanı')}`,
    `<b>A:</b> canlı kural (${esc(rsiRuleText())}, SL %0.5)`,
    '',
  ];
  const col = x => `${String(x.n).padStart(3)} ${fmtN(x.winRate, 0, '%').padStart(4)} ${fmtN(x.avgNetR).padStart(5)}`;
  const rows = [
    `${'Varyant'.padEnd(11)} ${'Seçim'.padEnd(14)} Doğrulama`,
    `${''.padEnd(11)} ${'  n win    R'.padEnd(14)}   n win    R`,
    ...triggers.map(t => {
      const bp = byPeriod(results[t.key]);
      const name = t.kind === 'mert' ? t.short + (selection?.key === t.key ? '*' : '') : 'A canlı';
      return `${name.padEnd(11)} ${col(bp.IS).padEnd(14)} ${col(bp.OOS)}`;
    }),
  ];
  lines.push(`<pre>${esc(rows.join('\n'))}</pre>`, '<i>Satır: RSI eşiği · TF sayısı · stop % — * seçilen</i>');

  if (selection) {
    const t = triggers.find(x => x.key === selection.key);
    const bp = byPeriod(results[t.key]);
    const o = bp.OOS;
    const sum = k => Object.values(stats[t.key]).reduce((x, st) => x + (st[k] || 0), 0);
    lines.push('',
      `➜ <b>Seçilen: ${esc(t.label)}</b> (seçimde toplam ${fmtN(bp.IS.sumNetR, 1)}R, ${bp.IS.n} sinyal)`,
      `<b>Doğrulama:</b> ${o.n} sinyal · win <b>${fmtN(o.winRate, 1, '%')}</b> · ort net R <b>${fmtN(o.avgNetR)}</b> · toplam ${fmtN(o.sumNetR, 1)}R`,
      `  W/L/LTR/N ${o.win}/${o.loss}/${o.ltr}/${o.neutral} · TP-B ${fmtN(o.tpB, 0, '%')} · sonuca ~${fmtN(o.holdMin, 0)} dk`,
    );
    if (bp.ALL.breakeven != null) lines.push(`  Tüm dönem: başabaş için gereken isabet ~%${bp.ALL.breakeven.toFixed(0)}, gerçekleşen %${fmtN(bp.ALL.winRate, 0)}`);
    lines.push(`Huni: karar ${sum('decisions')} → seviye dibi ${sum('location')} → RSI ${sum('rsiOk')} → ayrışma ${sum('separation')} → sinyal ${sum('signals')}`);
    lines.push(`Güven (1h/4h ≥ 70): ${[0, 1, 2].map(c => { const q = perf(results[t.key].filter(x => x.confidence === c)); return `${c}→ ${q.n} (${fmtN(q.winRate, 0, '%')})`; }).join(' · ')}`);
    const byLevel = {};
    for (const s of results[t.key]) (byLevel[s.level] ??= []).push(s);
    const lv = Object.entries(byLevel).map(([k, arr]) => { const q = perf(arr); return `${esc(k)} ${q.n} (${fmtN(q.winRate, 0, '%')})`; });
    if (lv.length) lines.push(`Seviyeler: ${lv.join(' · ')}`);
    if (selection.lowSample) lines.push(`⚠️ Hiçbir kombinasyon seçim döneminde ${MIN_SELECTION_N} sinyale ulaşmadı — seçim zayıf`);
    if (o.n < MIN_SELECTION_N) lines.push(`⚠️ Doğrulamada ${o.n} sinyal — kesin sonuç için az`);
  }
  lines.push(...rsiEventTelegramLines(rsiEvents, esc));
  lines.push('', '<i>Asıl kanıt Doğrulama sütunudur; seçim dönemi sadece ayar içindir.</i>');
  const text = lines.join('\n');
  return text.length <= 4000 ? text : text.slice(0, 3990) + '\n…';
}

/**
 * Telegram özet raporu (tek mesaj, ≤ 4096 karakter). Başında açıkça "canlı sinyal değil" yazar.
 */
function buildTelegramReport(p, allStats, signals, esc, trigger = getTriggers().current, rsiEvents = []) {
  const sum  = key => Object.values(allStats).reduce((s, st) => s + (st[key] || 0), 0);
  const pct  = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
  const n    = signals.length;
  const cnt  = o => signals.filter(s => s.outcome === o).length;
  const avgR = n ? avg(signals.map(s => s.rMultiple)).toFixed(2) : '—';
  const netR = n ? avg(signals.map(s => s.netR)).toFixed(2) : '—';
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
    `🪙 ${p.SYMBOLS.length} sembol${p.universe ? ` (${esc(p.universe)})` : ''} | min skor ${p.MIN_SCORE}`,
    `📐 ${esc(rsiRuleText())}`,
    '',
    '<b>Eleme hunisi</b>',
    `  Değerlendirilen ${decisionLabel(trigger)} kapanış: ${sum('decisions')}`,
    `  Günlük seviyeye yakın: ${sum('nearLevel')}`,
    `  + 1h RSI ≥ ${cfg.rsi1hMin}: ${sum('rsi1hOk')}`,
    `  + 4h RSI ≥ ${cfg.rsi4hMin}: ${sum('rsi4hOk')}`,
    `  Tüm kapılar: ${sum('gatePass')}`,
    `  − TP-A geçersiz: ${sum('planInvalid')} | − skor altı: ${sum('belowScore')}`,
    `  = <b>Sinyal: ${n}</b>`,
  ];

  // Son aşama dökümü — hangi kapı ne kadar eliyor
  const f = mergeFinal(allStats);
  if (f.candidates) {
    const labels = gateLabels(trigger);
    lines.push('', `<b>Son aşama: ${f.candidates} aday</b> (takılan / tek engel)`);
    for (const k of FINAL_GATES) {
      lines.push(`  ${esc(labels[k])}: ${f.fails[k] || 0} (${pct(f.fails[k] || 0, f.candidates)}) / ${f.only[k] || 0}`);
    }
    const by = Object.entries(f.rsiLowBy || {});
    if (by.length) lines.push(`  RSI eşiğine takılan: ${by.map(([tf, n]) => `${esc(tf)} ${n}`).join(' · ')}`);
    lines.push(`  RSI(max ${esc(trigger.rsiTFs.join(','))}): ${RSI_BUCKETS.map(b => `${esc(b.label)} ${f.rsiDist[b.label] || 0}`).join(' · ')}`);
  }

  if (n) {
    lines.push(
      '',
      '<b>Sonuçlar</b>',
      `  ✅ Win ${cnt('WIN')} | ❌ Loss ${cnt('LOSS')} | ↩️ ${cnt('LOSS_THEN_RECOVER')} | ➖ ${cnt('NEUTRAL')}`,
      `  Win rate: <b>${pct(cnt('WIN'), n)}</b> | Ort R: <b>${avgR}</b> | TP-B: ${pct(tpB, n)}`,
      `  Komisyon dahil ort R: <b>${netR}</b> (%${p.feePct ?? DEFAULT_FEE_PCT} × 2)`,
      '',
      '<b>Dereceye göre</b>',
      ...gradeLines,
      '',
      `<b>En çok sinyal</b>: ${topSyms}`,
    );
  } else {
    lines.push('', 'Bu dönemde tüm kapıları geçen sinyal yok — hangi aşamada elendiğini huniden görebilirsin.');
  }
  lines.push(...rsiEventTelegramLines(rsiEvents, esc));

  const text = lines.join('\n');
  return text.length <= 4000 ? text : text.slice(0, 3990) + '\n…';
}

/** Geçerli RSI eşikleri (bayraklarla değiştirilmiş olabilir) — rapora yazılır */
function rsiRuleText() {
  return `5m RSI ≥ ${cfg.rsi5mMin} · 15m ≥ ${cfg.rsi15mMin} · 1h ≥ ${cfg.rsi1hMin} · 4h ≥ ${cfg.rsi4hMin} · üst sınır ≤ ${cfg.rsiEntryMax}`;
}

// ── RSI olay çalışması raporu ─────────────────────────────────────────────────

// Diğer kapılar (RSI kapıları olay tanımında zaten sağlanmış)
const EVENT_GATES = [
  ['regime',     'Rejim: Momentum Continuation'],
  ['dailyLevel', 'Günlük EMA200/dirence uzak'],
  ['emaDist',    'EMA21 uzaklığı < 0.5 ATR'],
  ['emaTouch',   'Son 3 mumda EMA21 dokunuşu'],
];

/** Bir olay grubunun (her olayın İLK anı) özeti — + getiri = SHORT lehine */
function eventStats(evs) {
  const n = evs.length;
  const m = k => { const v = evs.map(e => e[k]).filter(x => x != null); return v.length ? avg(v) : null; };
  const pos = k => { const v = evs.map(e => e[k]).filter(x => x != null); return v.length ? v.filter(x => x > 0).length / v.length * 100 : null; };
  const planned = evs.filter(e => e.outcome);
  return {
    n, ret15m: m('ret15m'), ret1h: m('ret1h'), ret4h: m('ret4h'), pos1h: pos('ret1h'), pos4h: pos('ret4h'),
    mfe: m('mfe4h'), mae: m('mae4h'),
    planned: planned.length,
    win: planned.filter(e => e.outcome === 'WIN').length,
    loss: planned.filter(e => e.outcome === 'LOSS').length,
    ltr: planned.filter(e => e.outcome === 'LOSS_THEN_RECOVER').length,
    neutral: planned.filter(e => e.outcome === 'NEUTRAL').length,
    netR: planned.length ? avg(planned.map(e => e.netR)) : null,
  };
}

const pctS = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const numS = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);

function printRsiEvents(events) {
  console.log('\n\n════════════════════════════════════════════');
  console.log('  🎯 RSI OLAY ÇALIŞMASI — canlı RSI şartı sağlanan anlar');
  console.log('════════════════════════════════════════════');
  console.log(`  Şart   : ${rsiRuleText()}`);
  console.log('  Diğer kapılardan (seviye, rejim, EMA21) ve cooldown\'dan BAĞIMSIZ kaydedilir.');
  const firsts = events.filter(e => e.first);
  if (!firsts.length) { console.log('\n  Bu dönemde RSI şartı hiç sağlanmadı.'); return; }
  const coins = new Set(events.map(e => e.symbol)).size;
  console.log(`  An: ${events.length} · Olay: ${firsts.length} (aynı coinde 30 dk içinde tekrar edenler tek olay) · Coin: ${coins}`);
  const a = eventStats(firsts);
  console.log('\n  Olayın ilk anında SHORT açılsaydı (+ = short lehine):');
  console.log(`    15 dk sonra: ${pctS(a.ret15m)} · 1 saat: ${pctS(a.ret1h)} (lehe: %${a.pos1h?.toFixed(0)}) · 4 saat: ${pctS(a.ret4h)} (lehe: %${a.pos4h?.toFixed(0)})`);
  console.log(`    4 saatte en iyi / en kötü hareket (ort): MFE ${a.mfe?.toFixed(2)}% / MAE ${a.mae?.toFixed(2)}%`);
  console.log(`    Canlı planla (TP-A EMA21, SL %${cfg.initialRiskPct}): ${a.planned} işlem · W/L/LTR/N ${a.win}/${a.loss}/${a.ltr}/${a.neutral} · ort net R ${numS(a.netR)}` +
    (a.planned < a.n ? ` (${a.n - a.planned} olayda TP-A girişin üstündeydi)` : ''));

  console.log('\n  Diğer kapılar bu olayları nasıl ayırıyor? (olayların ilk anı)');
  console.log(`  ${'Kapı'.padEnd(30)} ${'── Takılan ──────────────'.padEnd(26)} ${'── Geçen ────────────────'}`);
  console.log(`  ${''.padEnd(30)} ${'   n   1s getiri  net R'.padEnd(26)} ${'   n   1s getiri  net R'}`);
  const col = x => `${String(x.n).padStart(4)} ${pctS(x.ret1h).padStart(10)} ${numS(x.netR).padStart(7)}`;
  for (const [k, label] of EVENT_GATES) {
    const f = eventStats(firsts.filter(e => e.fails.includes(k)));
    const p = eventStats(firsts.filter(e => !e.fails.includes(k)));
    console.log(`  ${label.padEnd(30)} ${col(f).padEnd(26)} ${col(p)}`);
  }
  const sig = eventStats(firsts.filter(e => !e.fails.length));
  console.log(`  ${'Hiçbirine takılmayan (=sinyal)'.padEnd(30)} ${col(sig)}`);

  const bySym = {};
  for (const e of firsts) bySym[e.symbol] = (bySym[e.symbol] || 0) + 1;
  console.log(`\n  En çok olay: ${Object.entries(bySym).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log('  Okuma: bir kapıda "Geçen" grup "Takılan"dan belirgin iyiyse kapı işe yarıyor;');
  console.log('         benzer ya da kötüyse iyi fırsatları boşuna eliyor olabilir. Olay sayısı azsa kesin hüküm verme.');
}

function rsiEventTelegramLines(events, esc) {
  const firsts = events.filter(e => e.first);
  const out = ['', `🎯 <b>RSI şartı sağlanan anlar</b> (diğer kapılardan bağımsız)`];
  if (!firsts.length) return [...out, '  Bu dönemde RSI şartı hiç sağlanmadı.'];
  const a = eventStats(firsts);
  out.push(
    `  ${events.length} an · <b>${firsts.length} olay</b> · ${new Set(events.map(e => e.symbol)).size} coin`,
    `  İlk anda short: 15dk ${pctS(a.ret15m)} · 1s ${pctS(a.ret1h)} (lehe: %${a.pos1h?.toFixed(0)}) · 4s ${pctS(a.ret4h)}`,
    `  Canlı planla: W/L/LTR/N ${a.win}/${a.loss}/${a.ltr}/${a.neutral} · ort net R ${numS(a.netR)}`,
  );
  const rows = [`${'Kapı'.padEnd(10)}${'Takılan'.padEnd(14)}Geçen`, `${''.padEnd(10)}${'  n  1s get.'.padEnd(14)}  n  1s get.`];
  const short = { regime: 'Rejim', dailyLevel: 'Seviye', emaDist: 'EMA uzak', emaTouch: 'EMA dokun' };
  const col = x => `${String(x.n).padStart(3)} ${pctS(x.ret1h).padStart(7)}`;
  for (const [k] of EVENT_GATES) {
    const f = eventStats(firsts.filter(e => e.fails.includes(k)));
    const p = eventStats(firsts.filter(e => !e.fails.includes(k)));
    rows.push(`${short[k].padEnd(10)}${col(f).padEnd(14)}${col(p)}`);
  }
  const sig = eventStats(firsts.filter(e => !e.fails.length));
  rows.push(`${'Sinyal'.padEnd(10)}${col(sig)}`);
  out.push(`<pre>${esc(rows.join('\n'))}</pre>`, '<i>1s get.: olayın ilk anında short açılsa 1 saat sonraki ort. getiri (+ = lehe)</i>');
  return out;
}

// ── Mert olay çalışması raporu ────────────────────────────────────────────────

/** Olay grubunun özeti (her olayın İLK anı) — + getiri = SHORT lehine; üç stopla net R */
function mertEvStats(evs) {
  const m = (arr) => (arr.length ? avg(arr) : null);
  const vals = k => evs.map(e => e[k]).filter(x => x != null);
  const sims = k => evs.map(e => e[k]).filter(Boolean);
  const s15 = sims('sl15'), s10 = sims('sl10'), sl = sims('slLvl');
  return {
    n: evs.length,
    ret1h: m(vals('ret1h')), ret4h: m(vals('ret4h')),
    win15: s15.length ? s15.filter(x => x.outcome === 'WIN').length / s15.length * 100 : null,
    r10: m(s10.map(x => x.netR)), r15: m(s15.map(x => x.netR)),
    rLvl: m(sl.map(x => x.netR)), nLvl: sl.length,
  };
}

const MERT_DIST_BUCKETS = [
  ['%4+ altında',     d => d < -4],
  ['%2–4 altında',    d => d >= -4 && d < -2],
  ['%1–2 altında',    d => d >= -2 && d < -1],
  ['%0.5–1 altında',  d => d >= -1 && d < -0.5],
  ['%0–0.5 altında',  d => d >= -0.5 && d < 0],
  ['%0–0.5 üstünde',  d => d >= 0 && d <= 0.5],
  ['%0.5+ üstünde',   d => d > 0.5],
];
const RISE_BUCKETS = [
  ['< %1', r => r < 1], ['%1–2', r => r >= 1 && r < 2], ['%2–4', r => r >= 2 && r < 4], ['≥ %4', r => r >= 4],
];

/** Tabloların satır tanımları: [başlık, [[etiket, filtre], ...]] */
function mertEventTables(firsts) {
  const levelNames = [...new Set(firsts.map(e => e.nearestLevel).filter(Boolean))];
  return [
    ['En yakın seviyeye uzaklık', [
      ...MERT_DIST_BUCKETS.map(([l, f]) => [l, e => e.nearestDistPct != null && f(e.nearestDistPct)]),
      ['Seviye hesaplanamadı', e => e.nearestDistPct == null],
    ]],
    ['Seviye türü (en yakın seviyeye %1\'den yakın)', levelNames.map(n => [n, e => e.nearestLevel === n && Math.abs(e.nearestDistPct) <= 1])],
    ['Güven puanı (1h/4h RSI ≥ 70 sayısı)', [0, 1, 2].map(c => [`${c}`, e => e.confidence === c])],
    ['RSI ≥ 90 olan TF sayısı', [['2 TF', e => e.hitTFs === 2], ['3 TF', e => e.hitTFs === 3]]],
    ['3m ve 5m EMA21 ayrışması', [['var', e => e.separated], ['yok', e => !e.separated]]],
    ['Son 1 saatteki yükseliş', RISE_BUCKETS.map(([l, f]) => [l, e => e.rise1h != null && f(e.rise1h)])],
  ];
}

function printMertEvents(events) {
  const M = cfg.mert;
  console.log('\n\n════════════════════════════════════════════');
  console.log('  🎯 MERT OLAY ÇALIŞMASI — filtre uygulanmadan');
  console.log('════════════════════════════════════════════');
  console.log(`  Tanım : 3m/5m/15m RSI'lardan en az ${M.eventMinTFs} tanesi ≥ ${M.eventRsiMin} (üst sınır yok), her 3m/5m kapanışı`);
  console.log('  Yer, güven (1h/4h), ayrışma FİLTRELENMEDİ — aşağıdaki tablolar hangisinin sonucu iyileştirdiğini gösterir.');
  const firsts = events.filter(e => e.first);
  if (!firsts.length) { console.log('\n  Bu dönemde tanımı sağlayan an yok.'); return; }
  console.log(`  An: ${events.length} · Olay: ${firsts.length} (aynı coinde 30 dk içinde tekrar edenler tek) · Coin: ${new Set(events.map(e => e.symbol)).size}`);
  console.log(`  Plan: TP-A 3m EMA21, TP-B 5m EMA21 · stoplar: %1 · %1.5 · en yakın üst seviyenin %${M.levelStopPct} üstü (seviye ≤ %${M.levelStopMaxPct} uzaktaysa)`);
  console.log('  Sütunlar: 1s/4s = olayın ilk anında short açılsa ortalama getiri (+ lehe) · Win = %1.5 stopla TP-A isabeti · R = ort. net R\n');
  const head = `  ${''.padEnd(26)} ${'n'.padStart(5)} ${'1s get'.padStart(8)} ${'4s get'.padStart(8)} ${'Win'.padStart(6)} ${'R %1'.padStart(7)} ${'R %1.5'.padStart(7)} ${'R seviye'.padStart(9)}`;
  const row = (label, x) => `  ${label.padEnd(26)} ${String(x.n).padStart(5)} ${pctS(x.ret1h).padStart(8)} ${pctS(x.ret4h).padStart(8)} ${fmtN(x.win15, 0, '%').padStart(6)} ${numS(x.r10).padStart(7)} ${numS(x.r15).padStart(7)} ${(numS(x.rLvl) + (x.nLvl ? ` (${x.nLvl})` : '')).padStart(9)}`;
  console.log(head);
  console.log(row('TÜM OLAYLAR', mertEvStats(firsts)));
  for (const [title, rows] of mertEventTables(firsts)) {
    console.log(`\n  ${title}`);
    for (const [label, f] of rows) { const x = mertEvStats(firsts.filter(f)); if (x.n) console.log(row('  ' + label, x)); }
  }
  console.log('\n  Okuma: bir satır diğerlerinden belirgin iyiyse o değer kurala aday. Olay sayısı (n) azsa kesin hüküm verme;');
  console.log('         sonra seçilen kural ilk 2/3 dönemde kurulup son 1/3 dönemde doğrulanmalı.');
}

function buildMertEventsTelegram(p, events, esc) {
  const M = cfg.mert;
  const firsts = events.filter(e => e.first);
  const lines = [
    '🎯 <b>MERT OLAY ÇALIŞMASI</b> (filtre uygulanmadan)',
    '<i>Geçmiş veri simülasyonu — canlı sinyal DEĞİLDİR</i>',
    `3m/5m/15m'den en az ${M.eventMinTFs}'si RSI ≥ ${M.eventRsiMin} olan anlar · ${p.DAYS} gün · ${p.SYMBOLS.length} sembol`,
  ];
  if (!firsts.length) return [...lines, '', 'Bu dönemde tanımı sağlayan an yok.'].join('\n');
  const all = mertEvStats(firsts);
  lines.push(`${events.length} an · <b>${firsts.length} olay</b> · ${new Set(events.map(e => e.symbol)).size} coin`,
    `Tümü: 1s ${pctS(all.ret1h)} · 4s ${pctS(all.ret4h)} · win ${fmtN(all.win15, 0, '%')} · R(%1.5) ${numS(all.r15)}`, '');
  const pick = new Set(['En yakın seviyeye uzaklık', 'Güven puanı (1h/4h RSI ≥ 70 sayısı)', 'RSI ≥ 90 olan TF sayısı', '3m ve 5m EMA21 ayrışması', 'Son 1 saatteki yükseliş']);
  for (const [title, rows] of mertEventTables(firsts)) {
    if (!pick.has(title)) continue;
    const body = [`${''.padEnd(15)}${'n'.padStart(4)}${'1s'.padStart(8)}${'win'.padStart(5)}${'R%1.5'.padStart(7)}`];
    for (const [label, f] of rows) {
      const x = mertEvStats(firsts.filter(f)); if (!x.n) continue;
      body.push(`${label.slice(0, 14).padEnd(15)}${String(x.n).padStart(4)}${pctS(x.ret1h, 1).padStart(8)}${fmtN(x.win15, 0, '%').padStart(5)}${numS(x.r15).padStart(7)}`);
    }
    lines.push(`<b>${esc(title)}</b>`, `<pre>${esc(body.join('\n'))}</pre>`);
  }
  lines.push('<i>1s: ilk anda short açılsa 1 saat sonraki ort. getiri (+ lehe) · win/R: %1.5 stop, TP-A 3m EMA21, komisyon dahil</i>');
  const text = lines.join('\n');
  return text.length <= 4000 ? text : text.slice(0, 3990) + '\n…';
}

function fmtDate(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function printCoverage(symbol, stats) {
  const c = stats.candles;
  const r = stats.range ? `${fmtDate(stats.range[0])} → ${fmtDate(stats.range[1])}` : '—';
  console.log(`  [${symbol}] Veri: ${r} | ${Object.entries(c).map(([tf, n]) => `${tf}:${n}`).join(' ')} mum`);
}

// Son aşamada anlamlı olan kapılar (günlük seviye / 1h / 4h zaten geçilmiş)
const FINAL_GATES = GATE_KEYS.filter(k => !['dailyLevel', 'rsi1h', 'rsi4h'].includes(k));

/** Sembollerin son aşama dökümlerini birleştirir */
function mergeFinal(allStats) {
  const out = { candidates: 0, fails: {}, only: {}, rsiDist: {}, rsiLowBy: {} };
  for (const st of Object.values(allStats)) {
    out.candidates += st.rsi4hOk || 0;
    for (const part of ['fails', 'only', 'rsiDist', 'rsiLowBy']) {
      for (const [k, v] of Object.entries(st.final?.[part] || {})) out[part][k] = (out[part][k] || 0) + v;
    }
  }
  return out;
}

function printFinalBreakdown(allStats, trigger = getTriggers().current) {
  const f = mergeFinal(allStats);
  if (!f.candidates) return;
  const labels = gateLabels(trigger);
  const pct = v => `${(v / f.candidates * 100).toFixed(1)}%`;
  console.log(`\n🔍 Son aşama: ${f.candidates} aday (seviye + 1h + 4h geçti) — kalan kapılar:`);
  console.log(`  ${'Kapı'.padEnd(34)} ${'Takılan'.padStart(9)} ${''.padStart(7)} ${'Tek engel'.padStart(10)}`);
  for (const k of FINAL_GATES) {
    const v = f.fails[k] || 0;
    console.log(`  ${labels[k].padEnd(34)} ${String(v).padStart(9)} ${pct(v).padStart(7)} ${String(f.only[k] || 0).padStart(10)}`);
  }
  console.log('  ("Tek engel": yalnızca bu kapıya takılan aday — bu kapı olmasaydı kapıları geçerdi; TP-A ve skor ayrıca kontrol edilir)');
  const by = Object.entries(f.rsiLowBy);
  if (by.length) console.log(`  RSI eşiğine takılan (TF bazında): ${by.map(([tf, n]) => `${tf} ${n} (${pct(n)})`).join(' · ')}`);
  const dist = RSI_BUCKETS.map(b => `${b.label}: ${f.rsiDist[b.label] || 0}`).join(' | ');
  console.log(`\n📊 Adaylarda max(${trigger.rsiTFs.join(',')}) RSI dağılımı: ${dist}`);
  console.log(`   (giriş kuralı: ${trigger.label})`);
}

/**
 * Sinyallerin hangi aşamada elendiğini gösterir — kapı kalibrasyonu için
 */
function printFunnel(allStats, trigger = getTriggers().current) {
  const sum = key => Object.values(allStats).reduce((s, st) => s + (st[key] || 0), 0);
  const steps = [
    [`Değerlendirilen ${decisionLabel(trigger)} kapanış`, 'decisions'],
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
  for (const [label, key] of steps) console.log(`  ${label.padEnd(30)} ${String(sum(key)).padStart(8)}`);
  printFinalBreakdown(allStats, trigger);
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
  const netR    = avg(signals.map(s => s.netR)).toFixed(2);
  const tpB     = signals.filter(s => s.tpBHitAt != null).length;

  console.log(`  [${symbol}] ${total} sinyal → Win: ${wins} (${winRate}%)  Loss: ${losses}  Neutral: ${neutral}  LTR: ${ltr}`);
  console.log(`             Ort R: ${avgR} (net ${netR})  Ort MFE: ${avgMFE}%  Ort MAE: ${avgMAE}%  TP-B'ye ulaşan: ${tpB}`);
}

function printGradeBreakdown(signals) {
  if (!signals.length) { console.log('\n  Sinyal yok.'); return; }

  console.log('\n📊 Dereceye Göre Win Rate:');
  console.log('  Grade  | Total  | Win%   | Ort R  | Net R  | TP-B%  | Ort MFE | Ort MAE');
  console.log('  -------+--------+--------+--------+--------+--------+---------+--------');

  for (const grade of ['A+', 'A', 'B', 'C']) {
    const grp = signals.filter(s => s.grade === grade);
    if (!grp.length) continue;
    const wr  = ((grp.filter(s => s.outcome === 'WIN').length / grp.length) * 100).toFixed(1);
    const r   = avg(grp.map(s => s.rMultiple)).toFixed(2);
    const nr  = avg(grp.map(s => s.netR)).toFixed(2);
    const tpb = ((grp.filter(s => s.tpBHitAt != null).length / grp.length) * 100).toFixed(0);
    const mfe = avg(grp.map(s => s.mfe)).toFixed(2);
    const mae = avg(grp.map(s => s.mae)).toFixed(2);
    console.log(`  ${grade.padEnd(6)} | ${String(grp.length).padEnd(6)} | ${wr.padEnd(6)}% | ${r.padEnd(6)} | ${nr.padEnd(6)} | ${tpb.padEnd(5)}% | ${mfe}%   | ${mae}%`);
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
  aggregateClosed,
  buildTelegramReport,
  buildCompareTelegramReport,
  perf,
  eventStats,
  mertEvStats,
  buildMertEventsTelegram,
  selectMert,
  selectionSplit,
  setKlineSource,
  TF_MS,
};
