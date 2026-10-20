'use strict';

/**
 * BİLGİ BOTU — canlı çalışma katmanı.
 */

const cfg      = require('./config');
const binance  = require('./binanceClient');
const telegram = require('./telegram');
const { Series, normKline, KEEP, MIN } = require('./series');
const eng      = require('./infoEngine');
const { formatCard } = require('./infoCard');
const { compact } = require('./infoStats');
const { createCardStore } = require('./cardStore');
const { createTouchTracker } = require('./levelTouch');
const { createDropLedger, DEFAULTS: DROP_DEFAULTS } = require('./eventLog');
const { peakScore, formatPeakAlert } = require('./peakAlert');
const { createEnricher, createLiqStream } = require('./marketData');
const ta = require('./ta');
const { createWeeklyJob } = require('./weeklyReport');
const path = require('path');
const chart = require('./chart');
const { createSettings } = require('./infoSettings');
const { installInfoTelegram } = require('./infoTelegram');
const { createSpotFlow } = require('./spotFlow');

const SEED_ORDER = ['1d', '4h', '1h', '15m', '5m', '3m', '1m'];
const PREMIUM_EVERY_MS  = 5 * 60_000;
const UNIVERSE_EVERY_MS = 60 * 60_000;
const FLOW_EVERY_MS     = 60_000;
const OI_CACHE_MS       = 2 * 60_000;
const GAP_FILL_MAX_MIN  = 200;
const GAP_FILL_CONCURRENCY = Math.max(1, Math.min(4, Math.floor(Number(process.env.GAP_FILL_CONCURRENCY) || 4)));
// Başlangıç/yeniden tohumlama da sınırlı paralellikle çalışır. Her istek binanceClient'taki
// weight bütçesinden (BINANCE_REST_WEIGHT_PER_MIN) geçtiği için paralellik dakikalık sınırı aşmaz,
// yalnızca ağ gecikmesini örter.
const SEED_CONCURRENCY = Math.max(1, Math.min(8, Math.floor(Number(process.env.SEED_CONCURRENCY) || 4)));
const RECOVERY_EVERY_MS = Math.max(10_000, Number(process.env.WS_RECOVERY_EVERY_MS) || 30_000);
const KEEP_BELOW_RATIO  = 0.8;

const settings = createSettings();
const tracker  = eng.createTracker();
const touches  = createTouchTracker();
// Tepe defteri (kartı etkilemez) — canlıda Binance ek verisi (OI, long/short, emir defteri, spot) ve likidasyon akışı
const enricher = createEnricher({ client: binance });
const liqStream = createLiqStream();
const drops    = createDropLedger({ ...cfg.events, enrich: (sym, o) => enricher.enrich(sym, o), orderBook: sym => enricher.orderBook(sym), onCandidate: (sr, e) => onPeakCandidate(sr, e) });
let store = null;
let flow = null;              // spot/futures akış takibi (src/spotFlow.js) — main'de kurulur
let weekly = null;
let telegramUi = null;        // installInfoTelegram dönüşü — panel salt okunur raporlar için komut tablosunu kullanır

// Panelde gösterilebilen salt okunur komut raporları (hiçbiri ayar/durum değiştirmez).
// takip ve sessiz yalnızca argümansız (liste) çağrılır; argümanlı takip ekle-çıkar yapar.
const PANEL_REPORTS = new Set(['durum', 'istatistik', 'seviye', 'kacan', 'teyit', 'gecmis', 'coin', 'akis', 'sessiz', 'takip']);
async function runReport(name, args = '') {
  if (!PANEL_REPORTS.has(name)) throw new Error('bilinmeyen rapor');
  const fn = telegramUi?.commands?.[name];
  if (typeof fn !== 'function') return { text: 'Bot motoru henüz hazır değil.' };
  const safeArgs = name === 'takip' || name === 'sessiz' || name === 'durum' ? '' : String(args || '').slice(0, 60);
  const out = await fn(safeArgs, { from: {}, chat: {} });
  if (out && typeof out === 'object') return { text: String(out.text || ''), photo: Buffer.isBuffer(out.photo) ? out.photo : null };
  return { text: String(out ?? '') };
}            // haftalık rapor işi (main'de kurulur)

const series  = new Map();
const busy    = new Set();
const pending = new Map();
const failed  = new Map();
const recoveryBlocked = new Set();
const recoveryQueue = new Set();
const recoveryAttempts = new Map();
const recoveryNotBefore = new Map();
let recoveryRunning = false;
let premium   = new Map();
const oiCache = new Map();
let vols24    = new Map();

const stats = { closes: 0, cards: 0, cardsToday: 0, day: null, seeded: 0, seedErrors: 0, gapFills: 0, peakAlerts: 0 };
const gapMetrics = { runs: 0, lastDurationMs: 0, lastSymbols: 0, lastRecoveredCandles: 0, lastFetchMs: 0, lastProcessMs: 0, lastFailures: 0, lastSkippedBusy: 0, lastPeakConcurrency: 0, lastIncomplete: 0, lastStale: 0, lastCoverage: {} };
const seedMetrics = { runs: 0, lastLabel: null, lastSymbols: 0, lastFailures: 0, lastIncomplete: 0, lastPeakConcurrency: 0, lastDurationMs: 0 };
const MAX_COVERAGE_REPORT = 50;   // panelde gösterilen sorunlu coin sayısı
let startedAt = 0;
let seedingAll = false;

const newDiag = () => ({ from: Date.now(), n: 0, lagSum: 0, lagMax: 0, busyMs: 0, queueWaitMs: 0, queueWaitN: 0 });
let diag = newDiag(), lastDiag = null;
const STALE_MS = 3 * 60_000;

function staleList(now = Date.now()) {
  const out = [];
  for (const [sym, sr] of series) {
    if (busy.has(sym) || !sr.ready()) continue;
    if (binance.isTradfi?.(sym)) continue;            // hisse/emtia: piyasa kapalıyken mum gelmeyebilir — uyarı sayılmaz
    const t = sr.lastT('1m');
    if (t == null || now - (t + 60_000) > STALE_MS) out.push(sym);
  }
  return out;
}

/**
 * Coin başına 1m kapsama kontrolü.
 *   missing — `since` sonrasındaki ardışık mumlar arasında eksik kalan 1m mum sayısı
 *   trailing — son kapanmış dakikaya kadar henüz gelmemiş mum sayısı (WS/REST gecikmesi)
 *   ageMs   — son kapanmış 1m mumun yaşı (kapanışından bu yana)
 * ok: aralıkta delik yok ve son mum STALE_MS'den yeni.
 */
function checkCoverage(sr, { since = null, now = Date.now() } = {}) {
  const t = sr?.d?.['1m']?.t || [];
  const last = t.length ? t[t.length - 1] : null;
  if (last == null) return { ok: false, missing: 0, trailing: null, ageMs: null, lastT: null };
  let missing = 0;
  for (let i = 1; i < t.length; i++) {
    if (since != null && t[i] <= since) continue;
    const gap = Math.round((t[i] - t[i - 1]) / MIN) - 1;
    if (gap > 0) missing += gap;
  }
  const lastClosedStart = Math.floor(now / MIN) * MIN - MIN;
  const trailing = Math.max(0, Math.round((lastClosedStart - last) / MIN));
  const ageMs = Math.max(0, now - (last + MIN));
  return { ok: missing === 0 && ageMs <= STALE_MS, missing, trailing, ageMs, lastT: last };
}

function queueRecovery(sym, reason = 'stale stream') {
  if (!series.has(sym) || binance.isTradfi?.(sym)) return;
  const firstBlock = !recoveryBlocked.has(sym);
  recoveryBlocked.add(sym);
  recoveryQueue.add(sym);
  if (firstBlock) console.warn(`[KURTARMA] ${sym} sinyalleri geçici durduruldu (${reason}); REST kurtarma kuyruğuna alındı`);
}

function isFreshSymbol(sym, now = Date.now()) {
  const sr = series.get(sym);
  const t = sr?.lastT('1m');
  return t != null && now - (t + MIN) <= STALE_MS;
}

function scanStaleRecovery(now = Date.now()) {
  for (const [sym, sr] of series) {
    if (!sr.ready() || binance.isTradfi?.(sym)) continue;
    const t = sr.lastT('1m');
    if (t == null || now - (t + MIN) > STALE_MS) queueRecovery(sym, 'sembol mum akışı 3 dk geride');
  }
}

async function runRecoveryCycle() {
  if (recoveryRunning) return { skipped: true };
  scanStaleRecovery();
  if (!recoveryQueue.size) return { queued: 0, recovered: 0 };
  const now = Date.now();
  const batch = [...recoveryQueue].filter(sym => (recoveryNotBefore.get(sym) || 0) <= now);
  if (!batch.length) return { queued: recoveryQueue.size, recovered: 0, deferred: true };
  recoveryRunning = true;
  for (const sym of batch) recoveryQueue.delete(sym);
  let recovered = 0;
  const toResubscribe = [];
  try {
    const result = await backfillGap(batch, Date.now() - STALE_MS);
    for (const sym of batch) {
      if (!series.has(sym)) {
        recoveryBlocked.delete(sym);
        recoveryQueue.delete(sym);
        recoveryAttempts.delete(sym);
        recoveryNotBefore.delete(sym);
        continue;
      }
      if (result?.outcomes?.[sym] === 'ok' && isFreshSymbol(sym)) {
        recoveryBlocked.delete(sym);
        recoveryAttempts.delete(sym);
        recoveryNotBefore.delete(sym);
        recovered++;
        toResubscribe.push(sym);
        console.log(`[KURTARMA] ${sym}: REST doğrulaması başarılı; sinyaller yeniden açıldı`);
      } else {
        const outcome = result?.outcomes?.[sym] || 'REST sonrası mum hâlâ eski';
        queueRecovery(sym, outcome);
        const attempts = (recoveryAttempts.get(sym) || 0) + 1;
        recoveryAttempts.set(sym, attempts);
        const delay = outcome === 'busy' ? RECOVERY_EVERY_MS : Math.min(5 * 60_000, RECOVERY_EVERY_MS * (2 ** Math.min(attempts - 1, 4)));
        recoveryNotBefore.set(sym, Date.now() + delay);
      }
    }
    if (toResubscribe.length) {
      const resubscribed = binance.resubscribeWsSymbols?.(toResubscribe) || [];
      console.log(`[KURTARMA] ${toResubscribe.length} sembol için WebSocket aboneliği ${resubscribed.length ? 'yenileme kuyruğuna alındı' : 'yenilenemedi (bağlantı kapalı olabilir)'}`);
    }
    return { queued: batch.length, recovered, outcomes: result?.outcomes || {} };
  } catch (err) {
    for (const sym of batch) queueRecovery(sym, 'kurtarma döngüsü hatası');
    throw err;
  } finally {
    recoveryRunning = false;
  }
}

/** Panel için salt okunur akış sağlığı özeti (sayaçları değiştirmez). */
function diagSummary(d, now = Date.now()) {
  if (!d || !d.n) return { candles: 0, lagAvgMs: null, lagMaxMs: null, busyPct: null, windowMs: 0 };
  const win = Math.max(1, (d.to ?? now) - d.from);
  return { candles: d.n, lagAvgMs: Math.round(d.lagSum / d.n), lagMaxMs: Math.round(d.lagMax), busyPct: +(d.busyMs / win * 100).toFixed(1), windowMs: win };
}

function health(now = Date.now()) {
  const stale = staleList(now);
  return {
    coins: series.size,
    ready: readyCount(),
    loading: busy.size,
    seedFailed: failed.size,
    stale: { count: stale.length, sample: stale.slice(0, 12) },
    recovery: { blocked: recoveryBlocked.size, queued: recoveryQueue.size, sample: [...recoveryBlocked].slice(0, 12) },
    latency: { current: diagSummary(diag, now), last5m: diagSummary(lastDiag, now) },
    gapFill: { ...gapMetrics },
    seed: { ...seedMetrics },
  };
}

function diagText(d, now = Date.now()) {
  if (!d || !d.n) return 'veri yok';
  const win = Math.max(1, (d.to ?? now) - d.from);
  return `${d.n} mum · WS gecikme ort ${(d.lagSum / d.n / 1000).toFixed(1)} sn, en fazla ${(d.lagMax / 1000).toFixed(1)} sn · kuyruk ort ${(d.queueWaitN ? d.queueWaitMs / d.queueWaitN / 1000 : 0).toFixed(2)} sn · işlem yükü %${(d.busyMs / win * 100).toFixed(1)}`;
}

// ── Değerlendirme bağlamı ─────────────────────────────────────────────────

function btc1h() {
  const b = series.get('BTCUSDT');
  if (!b) return null;
  const c = b.d['1m'].c, n = c.length;
  return n > 60 ? (c[n - 1] / c[n - 61] - 1) * 100 : null;
}

// Piyasa geneli (dakikada bir hesaplanır): 15m RSI ≥ 80 coin %, 60 dk'da ≥ %3 yükselen coin sayısı, BTC 5/15 dk ve 15m RSI
let marketCache = { t: 0, v: null };
function marketState(t) {
  const minute = Math.floor((t || Date.now()) / 60_000);
  if (marketCache.t === minute) return marketCache.v;
  let n = 0, hot = 0, pumping = 0;
  for (const sr of series.values()) {
    if (!sr.ready()) continue;
    n++;
    const r = ta.rsiLast(sr.col('15m', 'c', true), 14);
    if (r >= 80) hot++;
    const c = sr.d['1m'].c, k = c.length;
    if (k > 60 && c[k - 61] > 0 && c[k - 1] / c[k - 61] - 1 >= 0.03) pumping++;
  }
  const b = series.get('BTCUSDT'), bc = b ? b.d['1m'].c : [], bn = bc.length;
  const chg = m => (bn > m && bc[bn - 1 - m] > 0 ? +((bc[bn - 1] / bc[bn - 1 - m] - 1) * 100).toFixed(2) : null);
  const v = { breadth80: n ? +(hot / n * 100).toFixed(1) : null, pumping, btc5: chg(5), btc15: chg(15),
    btcRsi15: b ? +(ta.rsiLast(b.col('15m', 'c', true), 14) ?? 0).toFixed(1) : null };
  marketCache = { t: minute, v };
  return v;
}

const ctx = {
  funding: sym => premium.get(sym) || null,
  market: marketState,
  liq: (sym, t, q15) => liqStream.liq(sym, t, q15),
  btc1h,
  isMuted: sym => settings.isMuted(sym),
  isFollowed: sym => settings.isFollowed(sym),
};

// ── Kart gönderimi ────────────────────────────────────────────────────────

async function oiChange(sym) {
  const hit = oiCache.get(sym);
  if (hit && hit.until > Date.now()) return hit.v;
  let v = null;
  try {
    v = await Promise.race([binance.fetchOIChange1h(sym), new Promise(r => setTimeout(() => r(null), 4000))]);
  } catch { v = null; }
  oiCache.set(sym, { v, until: Date.now() + OI_CACHE_MS });
  return v;
}

function rollDay() {
  const day = new Date().toISOString().slice(0, 10);
  if (stats.day !== day) { stats.day = day; stats.cardsToday = 0; }
}

async function emitCard(card) {
  stats.cards++;
  rollDay();
  stats.cardsToday++;
  const oi = await oiChange(card.symbol);
  if (oi != null) card.oi = { changePct: oi };
  const s = settings.get();
  const { text, keyboard, details: det } = formatCard(card, s, { now: Date.now() });
  details.set(card.id, det);
  const sr = series.get(card.symbol);
  let photo = null;
  if (s.chart && sr) photo = chartOf(sr, s, card.snap.level, card.snap.levels || [], `Kart ${card.seq}`);
  
  // DÜZELTME: Derece 3 ve 4 kartları kart3 konusuna yönlendir
  const thread = (card.grade >= 3 && settings.topic('kart3')) || settings.topic('kart');
  
  telegram.sendCard({ text, keyboard, silent: card.silent, photo, thread });
  store?.add({ id: card.id, kind: 'card', symbol: card.symbol, t: card.t, seq: card.seq, price: card.price, data: { ...compact(card), bursts: undefined, fwd: undefined } });
  const lv = card.snap.level;
  console.log(`[KART] ${card.symbol} #${card.seq} derece ${card.grade} · RSI ${card.snap.hits}/3 · ${lv ? `${lv.name} ${lv.dist.toFixed(2)}\%${lv.zone}` : 'seviye yok'} · ${card.silent ? 'sessiz' : 'SESLİ'} · ${card.news.join(' | ')}`);
}

// ── 🔻 Tepe reddi (src/peakAlert.js) ─────────────────────────────────────
// Tepe defterinin her yeni adayında skor bakılır; kart biçimine dokunmaz, ayrı mesaj gider.
const peakLast = new Map();          // sym → son bildirim zamanı
function onPeakCandidate(sr, e) {
  const s = settings.get();
  if (!s.peakAlert || !e?.feat) return;
  const sym = sr.symbol;
  const sc = peakScore(e.feat);
  if (sc.score < (s.peakAlertMin ?? 4) || !(e.feat.pumpPct >= (s.peakAlertPumpPct ?? 5))) return;
  if (s.peakAlertRsiOnly && !e.feat.rsiOk) return;          // yalnız RSI kart şartı (rsiMin, minTFs) sağlanan coinler
  if (settings.isMuted(sym)) return;
  const last = peakLast.get(sym);
  if (last != null && e.t - last < (s.peakAlertGapMin ?? 30) * MIN) return;
  peakLast.set(sym, e.t);
  if (peakLast.size > 2000) peakLast.delete(peakLast.keys().next().value);
  stats.peakAlerts++;
  const id = `${sym}-${e.t}-tepe`;
  let level = null, levels = [];
  try { levels = eng.levelsOf(sr, s); level = eng.pickLevel(e.feat.price ?? e.price, levels, s).level; } catch { /* grafik seviyesiz */ }
  const followed = settings.isFollowed(sym);
  const { text, keyboard, details: det } = formatPeakAlert({ sym, e, sc, level, followed, id });
  details.set(id, det);
  let photo = null;
  try { if (s.chart) photo = chartOf(sr, s, level, levels, `Tepe reddi ${sc.score}/4`); } catch { /* grafiksiz */ }
  const thread = settings.topic('tepe') || settings.topic('kart');
  telegram.sendCard({ text, keyboard, silent: !s.cardSound && !followed, photo, thread });
  store?.add({ id, kind: 'tepe', symbol: sym, t: e.t, seq: sc.score, price: e.feat.price ?? e.price,
    data: { score: sc.score, R: sc.R, K: sc.K, V: sc.V, SE: sc.SE, peak: e.price, pumpPct: e.feat.pumpPct, wick_5m: e.feat.wick_5m, clv_1m: e.feat.clv_1m,
      body_1m: e.feat.body_1m, volx_3m: e.feat.volx_3m, session: e.feat.session, ema21_3m: e.feat.ema21_3m, ema21_5m: e.feat.ema21_5m, ema21_15m: e.feat.ema21_15m } });
  console.log(`[TEPE] ${sym} skor ${sc.score}/4 · pompa %${e.feat.pumpPct} · tepe ${e.price}`);
}

// ── Mum işleme ────────────────────────────────────────────────────────────

function toCandle(k) {
  return {
    t: k.startTime, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
    tb: k.takerBuyBase || 0, q: k.quoteVolume || 0, tq: k.takerBuyQuote || 0, closed: true,
  };
}

function processCandle(sr, c, live) {
  if (c._receivedAt) { diag.queueWaitMs += Math.max(0, Date.now() - c._receivedAt); diag.queueWaitN++; }
  const t0 = process.hrtime.bigint();
  try { processCandle0(sr, c, live); } finally { diag.busyMs += Number(process.hrtime.bigint() - t0) / 1e6; }
}

function processCandle0(sr, c, live) {
  const lastT = sr.lastT('1m');
  // Tekrar / eski mum kontrolü: bu mum zaten seride varsa veya daha eskiyse işlem yapma (kopukluk tamamlama ve çift sinyal koruması)
  if (lastT != null && c.t <= lastT) return;

  stats.closes++;
  const closed = sr.apply1m(c);
  store?.onCandle(sr.symbol, c);
  if (!live || recoveryBlocked.has(sr.symbol)) return;
  if (sr.ready()) {
    try {
      for (const e of touches.observe(sr, closed, settings.get())) store?.addTouch(e);
    } catch (err) {
      console.error(`[SEVİYE] ${sr.symbol}:`, err?.message || err);
    }
  }
  let card = null;
  try {
    card = eng.step(sr, closed, settings.get(), tracker, ctx);
  } catch (err) {
    console.error(`[DEĞERLENDİRME] ${sr.symbol}:`, err?.stack || err);
  }
  if (card) {
    touches.noteCard(sr.symbol, card.t);
    drops.noteCard(sr.symbol, card.t, card.grade);
    const sym = sr.symbol;
    const prev = chains.get(sym) || Promise.resolve();
    const next = prev.then(() => emitCard(card)).catch(err => console.error(`[KART] ${sym} gönderilemedi:`, err?.message || err));
    chains.set(sym, next);
    next.then(() => { if (chains.get(sym) === next) chains.delete(sym); });
  }
  try {
    for (const e of drops.observe(sr, settings.get(), ctx)) store?.addEvent(e);
  } catch (err) {
    console.error(`[DÜŞÜŞ] ${sr.symbol}:`, err?.message || err);
  }
}
const chains = new Map();

const DETAIL_MAX = 3000;
const details = {
  map: new Map(),
  set(id, html) { this.map.set(id, html); if (this.map.size > DETAIL_MAX) this.map.delete(this.map.keys().next().value); },
  get(id) { return this.map.get(id) ?? null; },
};

function ichiOf(s) {
  return { tenkan: s.ichiTenkan, kijun: s.ichiKijun, chikou: s.ichiChikou, senkouB: s.ichiSenkouB, shift: s.ichiShift };
}

function chartOf(sr, s, level, levels, subtitle, candles = null) {
  const tf = s.chartTf || '1h';
  const cs = candles || chart.candlesFromSeries(sr, tf);
  return chart.renderChart({
    symbol: sr.symbol, candles: cs, tf, level, levels,
    overlays: tf === '5m' && sr ? chart.emaOverlays(sr, cs) : [],
    ichi: ichiOf(s), showIchi: s.chartIchi, fib: s.chartFib, fibLeg: sr?._lv?.leg ?? null, subtitle, minTouches: s.chartMinTouches ?? 4,
  });
}

function onKline(symbol, tf, k, isFinal) {
  if (!isFinal || tf !== '1m') return;
  const c = toCandle(k);
  c._receivedAt = Date.now();
  const sr = series.get(symbol);
  if (!sr) return;
  if (recoveryBlocked.has(symbol)) {
    if (!pending.has(symbol)) pending.set(symbol, []);
    pending.get(symbol).push(c);
    return;
  }
  const lag = Math.max(0, Date.now() - (c.t + 60_000));
  diag.n++; diag.lagSum += lag; if (lag > diag.lagMax) diag.lagMax = lag;
  if (busy.has(symbol)) pending.get(symbol)?.push(c);
  else processCandle(sr, c, true);
}

function wsSymbols() {
  return [...series.keys()];
}

function flushPending(sym) {
  const sr = series.get(sym);
  const list = pending.get(sym) || [];
  pending.delete(sym);
  busy.delete(sym);
  if (!sr) return;
  list.sort((a, b) => a.t - b.t);
  for (const c of list) processCandle(sr, c, true);
}

// ── Tohumlama ─────────────────────────────────────────────────────────────

async function seedSymbol(sym) {
  const sr = series.get(sym);
  if (!sr) return false;
  busy.add(sym);
  if (!pending.has(sym)) pending.set(sym, []);
  try {
    for (const tf of SEED_ORDER) {
      const raw = await binance.fetchKlines(sym, tf, KEEP[tf] + 1);
      if (!series.has(sym)) return false;
      const now = Date.now();
      sr.seed(tf, (raw || []).map(k => normKline(k, now)));
    }
    stats.seeded++;
    failed.delete(sym);
    return true;
  } catch (err) {
    stats.seedErrors++;
    const n = (failed.get(sym) || 0) + 1;
    failed.set(sym, n);
    console.error(`[SEED] ${sym}: ${err?.message || err}${n < 3 ? ' — 2 dk sonra tekrar denenecek' : ' — 3 deneme başarısız, bir sonraki evren yenilemesinde tekrar'}`);
    if (n < 3) setTimeout(() => { if (series.has(sym)) seedSymbol(sym).then(ok => ok && flushPending(sym)); }, 2 * 60_000);
    return false;
  } finally {
    if (!failed.has(sym)) flushPending(sym);
    else { busy.delete(sym); pending.delete(sym); }
  }
}

async function seedMany(list, label) {
  const t0 = Date.now();
  let done = 0, failures = 0, incomplete = 0, active = 0, peak = 0, next = 0;
  async function worker() {
    while (next < list.length) {
      const sym = list[next++];
      active++;
      peak = Math.max(peak, active);
      let ok = false;
      try { ok = await seedSymbol(sym); } finally { active--; }
      if (!ok) failures++;
      else if (!binance.isTradfi?.(sym)) {
        // Tohum sonrası son mum yaşı: REST eski veri döndürdüyse coin kurtarma kuyruğuna alınır.
        const cov = checkCoverage(series.get(sym));
        if (!cov.ok) { incomplete++; queueRecovery(sym, `tohum sonrası son 1m mum ${Math.round((cov.ageMs ?? 0) / 1000)} sn eski`); }
      }
      if (++done % 50 === 0) console.log(`[SEED] ${label}: ${done}/${list.length} coin (${Math.round((Date.now() - t0) / 1000)} sn)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEED_CONCURRENCY, list.length) }, () => worker()));
  Object.assign(seedMetrics, { runs: seedMetrics.runs + 1, lastLabel: label, lastSymbols: list.length, lastFailures: failures, lastIncomplete: incomplete, lastPeakConcurrency: peak, lastDurationMs: Date.now() - t0 });
  console.log(`[SEED] ${label}: ${list.length} coin tamam — ${Math.round((Date.now() - t0) / 1000)} sn · ${peak} max paralellik${failures ? ` · ${failures} hata` : ''}${incomplete ? ` · ${incomplete} eski veri` : ''}`);
}

// ── Kopukluk sonrası doldurma ─────────────────────────────────────────────

async function backfillGap(symbols, downSince) {
  const started = Date.now();
  const gapMin = Math.ceil((Date.now() - downSince) / MIN) + 2;
  const metrics = { fetchMs: 0, processMs: 0, recoveredCandles: 0, failures: 0, skippedBusy: 0, active: 0, peakConcurrency: 0, incomplete: 0, stale: 0, outcomes: {}, coverage: {} };
  gapMetrics.runs++;
  gapMetrics.lastSymbols = symbols.length;
  console.log(`[WS] ${gapMin} dk kopukluk — ${symbols.length} coin dolduruluyor (eşzamanlılık ${GAP_FILL_CONCURRENCY})`);
  stats.gapFills++;

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < symbols.length) {
      const sym = symbols[nextIndex++];
      const sr = series.get(sym);
      if (!sr) { metrics.outcomes[sym] = 'removed'; continue; }
      if (busy.has(sym)) {
        metrics.skippedBusy++;
        metrics.outcomes[sym] = 'busy';
        queueRecovery(sym, 'başka işlem meşgul');
        continue;
      }

      // Uzun boşluk veya hazır olmayan seri için tam seed gerekir; yine aynı worker
      // havuzunda çalıştırılır, böylece REST istekleri sınırsız paralelleşmez.
      // Eksik aralık coin'in kendi son mumundan ölçülür (kopukluk başlangıcından değil),
      // böylece daha önce geride kalmış bir coin'de de delik kalmaz.
      const ownLast = sr.lastT('1m');
      const needMin = ownLast == null ? gapMin : Math.max(gapMin, Math.ceil((Date.now() - ownLast) / MIN) + 2);
      if (needMin > GAP_FILL_MAX_MIN || !sr.ready()) {
        try {
          const seeded = await seedSymbol(sym);
          metrics.outcomes[sym] = seeded ? 'ok' : 'seed failed';
          if (!seeded) { metrics.failures++; queueRecovery(sym, 'seed başarısız'); }
        } catch (err) {
          metrics.failures++;
          metrics.outcomes[sym] = 'seed failed';
          queueRecovery(sym, 'seed hatası');
          console.error(`[BOŞLUK] ${sym} seed: ${err?.message || err}`);
        }
        continue;
      }

      busy.add(sym);
      pending.set(sym, pending.get(sym) || []);
      try {
        const lastT = sr.lastT('1m') ?? downSince;
        metrics.active++;
        metrics.peakConcurrency = Math.max(metrics.peakConcurrency, metrics.active);
        const fetchStarted = Date.now();
        let raw;
        try {
          raw = await binance.fetchKlines(sym, '1m', Math.min(needMin + 2, KEEP['1m'] + 1));
        } finally {
          metrics.fetchMs += Date.now() - fetchStarted;
          metrics.active--;
        }

        const now = Date.now();
        const candles = (raw || [])
          .map(k => normKline(k, now))
          .filter(c => c.closed && (lastT == null || c.t > lastT))
          .sort((a, b) => a.t - b.t);
        const processStarted = Date.now();
        for (const c of candles) {
          const before = sr.lastT('1m');
          processCandle(sr, c, false);
          if (sr.lastT('1m') !== before) metrics.recoveredCandles++;
        }
        metrics.processMs += Date.now() - processStarted;

        // Doldurulan aralıkta eksik mum ve son mum yaşı kontrolü: delik kaldıysa ya da
        // REST hâlâ eski veri döndürüyorsa coin "ok" sayılmaz, kurtarma kuyruğuna alınır.
        const cov = checkCoverage(sr, { since: lastT, now: Date.now() });
        if (cov.missing > 0) {
          metrics.incomplete++;
          metrics.outcomes[sym] = 'incomplete';
          metrics.coverage[sym] = cov;
          queueRecovery(sym, `${cov.missing} eksik 1m mum`);
        } else if (!cov.ok && !binance.isTradfi?.(sym)) {
          metrics.stale++;
          metrics.outcomes[sym] = 'stale';
          metrics.coverage[sym] = cov;
          queueRecovery(sym, `son 1m mum ${Math.round(cov.ageMs / 1000)} sn eski`);
        } else {
          metrics.outcomes[sym] = 'ok';
        }
      } catch (err) {
        metrics.failures++;
        metrics.outcomes[sym] = 'REST failed';
        queueRecovery(sym, 'REST doldurma hatası');
        console.error(`[BOŞLUK] ${sym}: ${err?.message || err}`);
      } finally {
        flushPending(sym);
      }
    }
  }

  const workerCount = Math.min(GAP_FILL_CONCURRENCY, symbols.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  gapMetrics.lastDurationMs = Date.now() - started;
  gapMetrics.lastRecoveredCandles = metrics.recoveredCandles;
  gapMetrics.lastFetchMs = metrics.fetchMs;
  gapMetrics.lastProcessMs = metrics.processMs;
  gapMetrics.lastFailures = metrics.failures;
  gapMetrics.lastSkippedBusy = metrics.skippedBusy;
  gapMetrics.lastPeakConcurrency = metrics.peakConcurrency;
  gapMetrics.lastIncomplete = metrics.incomplete;
  gapMetrics.lastStale = metrics.stale;
  gapMetrics.lastCoverage = Object.fromEntries(Object.entries(metrics.coverage).slice(0, MAX_COVERAGE_REPORT));
  console.log(`[WS] Boşluk doldurma tamamlandı: ${metrics.recoveredCandles} mum, ${metrics.failures} hata, ${metrics.incomplete} eksik mumlu, ${metrics.stale} eski veri, ${metrics.skippedBusy} meşgul coin atlandı, ${metrics.peakConcurrency} max paralellik, ${Math.round(metrics.fetchMs)} ms REST / ${Math.round(metrics.processMs)} ms işleme / ${gapMetrics.lastDurationMs} ms toplam`);
  return { outcomes: metrics.outcomes, coverage: metrics.coverage };
}

// ── Evren ─────────────────────────────────────────────────────────────────

async function refreshUniverse(initial = false) {
  let vols;
  try {
    vols = await binance.getSymbolVolumes(cfg.autoFilter.excludeBaseAssets, { tradfi: Boolean(settings.get().tradfi) });
  } catch (err) {
    console.error(`[EVREN] hacim listesi alınamadı: ${err?.message || err}`);
    if (initial) throw err;
    return;
  }
  vols24 = vols;
  const min = settings.get().minVolumeM * 1e6;
  const want = [...vols.entries()].filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const keep = [...series.keys()].filter(s => (vols.get(s) ?? 0) >= min * KEEP_BELOW_RATIO || s === 'BTCUSDT');
  const next = [...new Set(['BTCUSDT', ...keep, ...want])].filter(s => vols.has(s));
  const added = next.filter(s => !series.has(s));
  const removed = [...series.keys()].filter(s => !next.includes(s));

  for (const s of removed) { series.delete(s); tracker.forget(s); pending.delete(s); busy.delete(s); recoveryBlocked.delete(s); recoveryQueue.delete(s); recoveryAttempts.delete(s); recoveryNotBefore.delete(s); }
  for (const s of added) { series.set(s, new Series(s)); if (!initial) { busy.add(s); pending.set(s, []); } }
  const retry = [...failed.keys()].filter(s => series.has(s) && !added.includes(s));
  failed.clear();

  if (initial) return { list: next, added, removed };
  binance.setWsSymbols(wsSymbols());
  if (added.length || removed.length) {
    console.log(`[EVREN] ${series.size} coin (+${added.length}${added.length ? `: ${added.slice(0, 10).join(', ')}${added.length > 10 ? '…' : ''}` : ''} / −${removed.length}${removed.length ? `: ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? '…' : ''}` : ''})`);
  }
  const toSeed = [...added, ...retry];
  if (toSeed.length) await seedMany(toSeed, 'yeni/yeniden');
  return { list: next, added, removed };
}

async function pollPremium() {
  try { premium = await binance.fetchPremium(); }
  catch (err) { console.warn(`[FUNDING] alınamadı: ${err?.message || err}`); }
}

// ── Durum / heartbeat ─────────────────────────────────────────────────────

function tradfiCount() {
  let n = 0;
  for (const sym of series.keys()) if (binance.isTradfi?.(sym)) n++;
  return n;
}

function readyCount() {
  let n = 0;
  for (const sr of series.values()) if (sr.ready()) n++;
  return n;
}

function statusText() {
  const s = settings.get();
  const up = Math.round((Date.now() - startedAt) / 60000);
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  return `🟢 <b>Bilgi botu</b> · ${Math.floor(up / 60)}s ${up % 60}dk çalışıyor
Coin: ${series.size} izleniyor · ${readyCount()} hazır${busy.size ? ` · ${busy.size} yükleniyor` : ''}${failed.size ? ` · ${failed.size} hata` : ''}${recoveryBlocked.size ? ` · ${recoveryBlocked.size} kurtarma/sinyal kilidi` : ''}
${(() => { const st = staleList(); return st.length ? `⚠️ Geride (son 3 dk mum yok): ${st.length} coin — ${st.slice(0, 8).join(', ')}${st.length > 8 ? '…' : ''}` : '✅ Tüm hazır coinlerde son 3 dk mumu var'; })()}
Son 5 dk: ${diagText(lastDiag && lastDiag.n ? lastDiag : diag)}
Evren: 24s hacim ≥ ${s.minVolumeM}M $${s.tradfi ? ` · hisse/emtia açık (${tradfiCount()} izleniyor)` : ''}
Bugün: ${stats.cardsToday} kart · Telegram kuyruğu: ${telegram.queueLength()}
Hareket: ${s.moveAlertPct > 0 ? `1 dk ≥ %${s.moveAlertPct} → RSI kartına eklenir (RSI şartı varsa)` : 'kapalı'}
Şart: RSI ≥ ${s.rsiMin} (${s.minTFs}/3)${s.levelRequired ? ` + seviye ≤ %${s.levelMaxPct}` : ''}${s.sepRequired ? ' + ayrışma' : ''}${s.confRequired ? ' + destek' : ''}${s.macdRequired ? ' + MACD' : ''}
Bellek: ${mem} MB`;
}

let lastCloses = 0;
function heartbeat() {
  const ws  = binance.takeWsStats();
  const tg  = telegram.takeStats();
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const mins = Math.round(cfg.heartbeatMs / 60000);
  const closes = stats.closes - lastCloses;
  lastCloses = stats.closes;
  const cards = stats.cards, peaks = stats.peakAlerts;
  stats.cards = 0; stats.peakAlerts = 0;
  store?.sweep();
  touches.sweep();
  drops.sweep();
  lastDiag = { ...diag, to: Date.now() };
  const dTxt = diagText(diag), stale = staleList();
  diag = newDiag();
  console.log(
    `[HEARTBEAT] WS ${ws?.open ?? 0}/${ws?.connections ?? 0} bağlı (${ws?.streams ?? 0} stream)` +
    ` | son ${mins}dk: ${closes} 1m kapanış, ${ws?.skipped ?? 0} ara güncelleme atlandı, ${cards} kart, ${peaks} tepe reddi` +
    ` | coin: ${readyCount()}/${series.size} hazır${busy.size ? `, ${busy.size} yükleniyor` : ''}${stale.length ? `, ${stale.length} GERİDE` : ''}` +
    ` | ${dTxt}` +
    ` | takipte ${store?.openCount() ?? 0} kart, ${touches.openCount()} seviye teması, ${drops.openCount()} tepe adayı · ek veri ${enricher.stats.ok} (atlanan ${enricher.stats.skipped}) · likidasyon mesajı ${liqStream.stats().messages}${flow?.enabled() ? ` · akış ${flow.stats.rows} satır/${flow.stats.changes} değişim` : ''}` +
    ` | telegram: ${tg.sent} gönderildi, ${tg.queued} kuyrukta${tg.failed ? `, ${tg.failed} BAŞARISIZ` : ''}` +
    ` | bellek: ${mem} MB`,
  );
  if (ws && ws.open > 0 && closes === 0 && !seedingAll) {
    console.warn(`[UYARI] Son ${mins} dakikada hiç 1m kapanışı işlenmedi — veri akışı kontrol edilmeli`);
  }
  if (stale.length) console.warn(`[UYARI] ${stale.length} coinde son 3 dk'da 1m mumu yok: ${stale.slice(0, 15).join(', ')}${stale.length > 15 ? '…' : ''}`);
  if (lastDiag.n && lastDiag.lagMax > 20_000) console.warn(`[UYARI] 1m mum gecikmesi ${Math.round(lastDiag.lagMax / 1000)} sn'ye çıktı — bot yetişemiyor olabilir`);
  if (ws && ws.reconnects > 0) console.warn(`[UYARI] Son ${mins} dakikada ${ws.reconnects} WebSocket yeniden bağlanması`);
}

// ── Başlangıç ─────────────────────────────────────────────────────────────

async function main() {
  startedAt = Date.now();
  console.log('╔══════════════════════════════════════╗');
  console.log('║   BİLGİ BOTU — sınıflandırma kartları ║');
  console.log('╚══════════════════════════════════════╝');

  settings.load();
  const s = settings.get();
  console.log(`[AYAR] RSI ≥ ${s.rsiMin} (${s.minTFs}/3) · seviye ≤ %${s.levelMaxPct}${s.levelRequired ? ' (zorunlu)' : ''} · patlama %${s.burstPct1}/%${s.burstPct2} × hacim ${s.volMult} · evren ≥ ${s.minVolumeM}M $`);

  store = createCardStore();
  if (process.env.SPOT_FLOW !== '0') {
    // Evren botun hacim filtresinden bağımsız: spotu olan tüm USDT perpetual'lar (stabil coinler hariç)
    flow = createSpotFlow({ futuresKlines: (sym, tf, limit) => binance.fetchKlines(sym, tf, limit),
      getFuturesSymbols: () => binance.getTradableSymbols(cfg.autoFilter.excludeBaseAssets, { tradfi: false }), getSettings: () => settings.get() });
  }
  await telegram.start();
  telegramUi = installInfoTelegram({ telegram, settings, tracker, store, details, flow: () => flow, getSeries: sym => series.get(sym), ctx: () => ctx, status: statusText, chartFor: (sym, level, levels = []) => {
    const sr = series.get(sym), s0 = settings.get();
    if (!sr || !s0.chart) return null;
    return chartOf(sr, s0, level, levels, 'Anlık');
  } });
  console.log(`[GRAFİK] ${chart.available() ? `açık (${settings.get().chartTf} · Ichimoku bulutu · Fibonacci)` : 'KAPALI — @napi-rs/canvas yüklenemedi, kartlar grafiksiz gider'}`);

  console.log('Evren belirleniyor...');
  const { list } = await refreshUniverse(true);
  console.log(`${list.length} coin izlenecek (24s hacim ≥ ${s.minVolumeM}M $): ${list.slice(0, 10).join(', ')}${list.length > 10 ? ' …' : ''}`);
  for (const sym of list) { busy.add(sym); pending.set(sym, []); }

  const wsList = wsSymbols();
  console.log(`WebSocket: ${wsList.length} parite (izlenen)`);
  binance.startWebSocket(wsList, ['1m'], onKline, { onGap: backfillGap, options: { ...cfg.ws, finalOnly: true } });
  if (process.env.LIQ_STREAM !== '0') liqStream.start();                // tüm piyasa likidasyon akışı (istatistik)

  await pollPremium();
  setInterval(pollPremium, PREMIUM_EVERY_MS);
  setInterval(heartbeat, cfg.heartbeatMs);
  // Haftalık istatistik dosyası (Pazartesi 03:01 TSİ) → gruba, sonra veritabanından sil
  if (store?.enabled()) {
    const dataDir = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'signals.db'));
    weekly = createWeeklyJob({
      store, file: path.join(dataDir, 'weekly-state.json'), getSettings: () => settings.get(), E: { ...DROP_DEFAULTS, ...(cfg.events || {}) },
      send: async (files, caption) => {
        const thread = settings.topic('rapor') || settings.topic('sistem') || null;
        for (const [k, f] of files.entries()) {
          if (!(await telegram.sendDocument(f.name, f.buf, { caption: k === 0 ? caption : null, thread, type: f.type }))) return false;
        }
        return true;
      },
      purge: cutoff => store.purgeBefore(cutoff),
    });
    setInterval(() => { weekly.tick().catch(err => console.error('[HAFTALIK]', err?.message || err)); }, 30_000);
  }

  seedingAll = true;
  console.log(`Geçmiş veri yükleniyor (${list.length} coin × ${SEED_ORDER.length} zaman dilimi) — REST limitine göre birkaç dakika sürer; hazır olan coinler hemen değerlendirilir.`);
  await seedMany(list, 'başlangıç');
  seedingAll = false;

  setInterval(() => runRecoveryCycle().catch(err => console.error('[KURTARMA]', err?.stack || err)), RECOVERY_EVERY_MS);
  // Akış takibi mum tohumlamasından SONRA başlar (ilk tur coin başına geçmişi yükler; REST kuyruğunu tohumlamayla paylaşmasın)
  if (flow?.enabled()) {
    const runFlow = () => flow.tick().then(r => { if (r?.changed?.length) console.log(`[AKIŞ] ${r.changed.length} etiket değişti`); })
      .catch(err => console.error('[AKIŞ]', err?.message || err));
    setInterval(runFlow, FLOW_EVERY_MS).unref?.();
    runFlow();
  }
  runRecoveryCycle().catch(err => console.error('[KURTARMA]', err?.stack || err));
  setInterval(() => refreshUniverse().catch(err => console.error('[EVREN]', err?.message || err)), UNIVERSE_EVERY_MS);
  settings.onChange((key) => {
    if (key === 'minVolumeM' || key === 'tradfi') refreshUniverse().catch(err => console.error('[EVREN]', err?.message || err));
  });

  const s2 = settings.get();
  const { notifyWebPanelToAdmins } = require('./webUrl');
  telegram.sendText(`🟢 <b>Bilgi botu hazır</b> — ${readyCount()}/${series.size} coin izleniyor (24s hacim ≥ ${s2.minVolumeM}M $)` +
    ` · kart şartı RSI ≥ ${s2.rsiMin} (${s2.minTFs}/3)` +
    (s2.moveAlertPct > 0 ? ` · 1 dk ≥ %${s2.moveAlertPct} hareket RSI kartına eklenir` : '') +
    `. Komutlar: /yardim · Ayarlar: /ayarlar`, null, settings.topic('sistem'));

  notifyWebPanelToAdmins(telegram, { note: 'Dağıtım Başarılı & Motor Hazır', thread: settings.topic('sistem') }).catch(err => console.warn('[PANEL-BILDIRIM]', err?.message || err));
  console.log('\n✅ Bilgi botu çalışıyor.\n');
}

module.exports = { main, _internal: { onPeakCandidate, series, settings, tracker, touches, drops, enricher, liqStream, marketState, processCandle, onKline, seedSymbol, refreshUniverse, backfillGap, seedMany, checkCoverage, seedMetrics, health, runReport, PANEL_REPORTS, runRecoveryCycle, scanStaleRecovery, queueRecovery, isFreshSymbol, recoveryBlocked, recoveryQueue, recoveryAttempts, recoveryNotBefore, gapMetrics, statusText, stats, busy, pending, details, getStore: () => store, getFlow: () => flow, getWeekly: () => weekly } };
