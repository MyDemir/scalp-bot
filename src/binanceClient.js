'use strict';

require('dotenv').config();
const { USDMClient } = require('binance');
const { createStreamClient } = require('./streamClient');

// REST istemcisi — kullanılan uç noktaların hepsi public (key gerektirmez)
const restClient = new USDMClient({
  api_key:    process.env.BINANCE_API_KEY,
  api_secret: process.env.BINANCE_API_SECRET,
  // Yalnızca test için (yerel sahte sunucu). Üretimde tanımlanmaz → Binance'in varsayılan adresi.
  ...(process.env.BINANCE_REST_BASE_URL ? { baseUrl: process.env.BINANCE_REST_BASE_URL } : {}),
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── REST hız sınırlayıcı ───────────────────────────────────────────────────
// Binance USDⓈ-M: IP başına 2400 weight/dk. Canlı bot yarısını kullanır; backtest vb. için pay kalır.
// Tüm istekler sıraya girer, her biri weight'i kadar "süre" tüketir.

const WEIGHT_PER_MIN = Number(process.env.BINANCE_REST_WEIGHT_PER_MIN || 1200);
let nextSlotAt = 0;

async function limited(weight, fn) {
  const now   = Date.now();
  const start = Math.max(now, nextSlotAt);
  nextSlotAt  = start + weight * (60_000 / WEIGHT_PER_MIN);
  if (start > now) await sleep(start - now);
  return fn();
}

/**
 * Rate limit (Binance kodu -1003 / Retry-After başlığı) gelirse bekleyip tekrar dener.
 * Diğer hatalar olduğu gibi fırlatılır.
 */
/**
 * Geçici ağ/sunucu hatası mı? (bağlantı koptu, zaman aşımı, 5xx) — kısa beklemeyle tekrar denenir.
 * 418 (IP ban) ve diğer 4xx istemci hataları tekrar DENENMEZ.
 */
function isTransient(err) {
  const code = err?.code;
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|UND_ERR)/.test(code)) return true;
  if (/socket hang up|network|timeout|ECONNRESET/i.test(String(err?.message ?? err))) return true;
  const status = Number(err?.status ?? err?.response?.status ?? code);
  return status >= 500 && status < 600;
}

async function withRetry(fn, label, maxRetries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter  = Number(err?.headers?.['retry-after']);
      const rateLimited = err?.code === -1003 || Number.isFinite(retryAfter);
      if (!rateLimited && isTransient(err) && attempt < maxRetries) {
        const waitMs = 2000 * 2 ** attempt;   // 2 sn, 4 sn, 8 sn
        console.warn(`[REST] ${label}: geçici hata (${err?.code ?? ''} ${err?.message ?? err}) — ${waitMs / 1000} sn sonra tekrar (${attempt + 1}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }
      if (!rateLimited || attempt >= maxRetries) throw err;
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      console.warn(`[REST] ${label}: rate limit — ${waitSec} sn bekleniyor (tekrar ${attempt + 1}/${maxRetries})`);
      nextSlotAt = Math.max(nextSlotAt, Date.now() + waitSec * 1000);   // diğer istekler de beklesin
      await sleep(waitSec * 1000);
    }
  }
}

const call = (weight, label, fn) => withRetry(() => limited(weight, fn), label);
/** REST kuyruğunda bekleyen süre (ms) — istatistik zenginleştirmesi kuyruk doluysa atlanır */
const restBacklogMs = () => Math.max(0, nextSlotAt - Date.now());

// Binance futures klines weight: limit <100 → 1, <500 → 2, ≤1000 → 5, >1000 → 10
function klineWeight(limit) {
  return limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
}

// ── REST Yardımcıları ──────────────────────────────────────────────────────

/** @returns ham Binance kline dizisi: [[openTime, o, h, l, c, v, closeTime, ...], ...] */
function fetchKlines(symbol, interval, limit = 200) {
  return call(klineWeight(limit), `klines ${symbol} ${interval}`,
    () => restClient.getKlines({ symbol, interval, limit }));
}

function fetchExchangeInfo() {
  return call(1, 'exchangeInfo', () => restClient.getExchangeInfo());
}

function fetch24hTickers() {
  return call(40, 'ticker/24hr', () => restClient.get24hrChangeStatistics());
}

/**
 * Tüm sembollerin funding oranı + bir sonraki funding zamanı (premiumIndex, tek istek, weight 10)
 * @returns {Map<string, {rate:number, next:number|null}>}
 */
async function fetchPremium() {
  const rows = await call(10, 'premiumIndex', () => restClient.getMarkPrice());
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    const fr = parseFloat(r.lastFundingRate);
    const mark = parseFloat(r.markPrice), index = parseFloat(r.indexPrice);
    if (r.symbol && Number.isFinite(fr)) out.set(r.symbol, { rate: fr, next: Number(r.nextFundingTime) || null, mark: Number.isFinite(mark) ? mark : null, index: Number.isFinite(index) ? index : null });
  }
  return out;
}

/** Son 1 saatteki açık pozisyon değişimi (%) — openInterestHist 5m × 13 */
async function fetchOIChange1h(symbol) {
  const rows = await call(1, `openInterestHist ${symbol}`, () => restClient.getOpenInterestStatistics({ symbol, period: '5m', limit: 13 }));
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const a = parseFloat(rows[0].sumOpenInterest), b = parseFloat(rows[rows.length - 1].sumOpenInterest);
  return a > 0 && Number.isFinite(b) ? (b - a) / a * 100 : null;
}

// ── Sembol listesi ─────────────────────────────────────────────────────────

/** İşlem gören USDT-margined perpetual sözleşmeler (exchangeInfo) */
async function getTradableSymbols(excludeBaseAssets = []) {
  const info = await fetchExchangeInfo();
  const exclude = new Set(excludeBaseAssets.map(s => s.toUpperCase()));
  return new Set(
    info.symbols
      .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .filter(s => !exclude.has(String(s.baseAsset).toUpperCase()))
      .map(s => s.symbol),
  );
}

/**
 * Production: hacme göre en likit perpetual'lar.
 * Eski sürüm 'UP' gibi kelimeleri alt dize olarak arıyordu → JUPUSDT, SUPERUSDT yanlışlıkla eleniyordu.
 * Artık exchangeInfo'dan PERPETUAL + TRADING + USDT filtreleniyor, hariç tutma baz varlıkta TAM eşleşme.
 * @param {{minVolume24hUSDT:number, maxCoins:number, excludeBaseAssets:string[]}} filterCfg  maxCoins 0 = sınırsız
 */
async function getLiquidSymbols(filterCfg) {
  const { minVolume24hUSDT, maxCoins, excludeBaseAssets = [] } = filterCfg;
  const tradable = await getTradableSymbols(excludeBaseAssets);
  const tickers  = await fetch24hTickers();

  const list = tickers
    .filter(t => tradable.has(t.symbol) && parseFloat(t.quoteVolume) >= minVolume24hUSDT)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => t.symbol);

  return maxCoins > 0 ? list.slice(0, maxCoins) : list;
}

/**
 * İşlemdeki USDT perpetual'ların 24s hacmi (USDT).
 * @returns {Map<string, number>}
 */
async function getSymbolVolumes(excludeBaseAssets = []) {
  const tradable = await getTradableSymbols(excludeBaseAssets);
  const tickers  = await fetch24hTickers();
  const out = new Map();
  for (const t of tickers) if (tradable.has(t.symbol)) out.set(t.symbol, parseFloat(t.quoteVolume) || 0);
  return out;
}

// ── WebSocket ──────────────────────────────────────────────────────────────

let stream = null;

/**
 * @param {string[]} symbols
 * @param {string[]} timeframes
 * @param {function} onKline  (symbol, tf, kline, isFinal)
 * @param {object}   [opts]   { onGap, options }
 */
function startWebSocket(symbols, timeframes, onKline, opts = {}) {
  if (stream) stream.stop();
  stream = createStreamClient({ symbols, timeframes, onKline, onGap: opts.onGap, options: opts.options });
  stream.start();
  return stream;
}

/** Çalışan WebSocket'in sembol listesini değiştirir (bağlantıyı koparmadan) */
function setWsSymbols(symbols) {
  return stream ? stream.setSymbols(symbols) : { added: [], removed: [] };
}

function stopWebSocket() {
  stream?.stop();
  stream = null;
}

function takeWsStats() {
  return stream ? stream.takeStats() : null;
}

module.exports = {
  restClient,
  call,
  restBacklogMs,
  withRetry,
  fetchKlines,
  fetchExchangeInfo,
  fetch24hTickers,
  fetchPremium,
  fetchOIChange1h,
  getTradableSymbols,
  getLiquidSymbols,
  getSymbolVolumes,
  startWebSocket,
  setWsSymbols,
  stopWebSocket,
  takeWsStats,
};
