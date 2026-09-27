'use strict';

require('dotenv').config();

const cfg           = require('./config');
const candleStore   = require('./candleStore');
const binance       = require('./binanceClient');
const htfPoller     = require('./htfPoller');
const signalEngine  = require('./signalEngine');
const tracker       = require('./eventTracker');
const { bot }       = require('./telegram'); // polling başlar

// ── Başlangıç ─────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   SCALP SİNYAL MOTORU  v1.0          ║');
  console.log('║   Mert Stratejisi — RSI+MTF+Rejim     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`\nMod: ${cfg.mode.toUpperCase()}`);

  // ── 1. Coin listesi ─────────────────────────────────
  let symbols;
  if (cfg.mode === 'production') {
    console.log('Likit coinler filtreleniyor...');
    symbols = await binance.getLiquidSymbols(cfg.autoFilter);
    console.log(`${symbols.length} coin seçildi:`, symbols.slice(0, 5).join(', '), '...');
  } else {
    symbols = cfg.testSymbols;
    console.log('Test modu — semboller:', symbols.join(', '));
  }

  // ── 2. Candle store init ─────────────────────────────
  const allTFs = [...cfg.wsTimeframes, ...cfg.restTimeframes];
  candleStore.init(symbols, allTFs);

  // ── 3. Bekleyen sinyalleri yükle ─────────────────────
  tracker.loadPending();

  // ── 4. Başlangıç seed verisi (WebSocket TF'leri için) ─
  console.log('Başlangıç kline verisi çekiliyor...');
  for (const symbol of symbols) {
    for (const tf of cfg.wsTimeframes) {
      try {
        const klines = await binance.fetchKlines(symbol, tf, 200);
        candleStore.seed(symbol, tf, klines);
        await _sleep(100);
      } catch (err) {
        console.error(`[SEED] ${symbol} ${tf}:`, err.message);
      }
    }
  }
  console.log('Seed tamamlandı.');

  // ── 5. HTF polling başlat ─────────────────────────────
  htfPoller.startPolling(symbols);

  // ── 6. WebSocket başlat ───────────────────────────────
  binance.startWebSocket(
    symbols,
    cfg.wsTimeframes,
    onKline,
    cfg,
  );

  console.log('\n✅ Bot çalışıyor. Telegram mesajları bekleniyor...\n');
}

// ── WebSocket Kline Handler ────────────────────────────────────────────────

async function onKline(symbol, tf, kline, isFinal) {
  // Mumu store'a ekle (kapanmış veya devam eden)
  candleStore.update(symbol, tf, kline);

  const price = parseFloat(kline.close || kline.c);
  const now   = Date.now();

  // Event tracker için her fiyat güncellemesi
  tracker.onPrice(symbol, price, now);

  // Sinyal değerlendirmesi sadece 5m kapanan mumda
  if (tf === '5m' && isFinal) {
    const oiDelta   = htfPoller.getOIDelta(symbol);
    const funding   = htfPoller.getFundingRate(symbol);

    await signalEngine.evaluate(symbol, oiDelta, funding);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n[BOT] Kapatılıyor...');
  binance.stopWebSocket();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[REJECTION]', reason);
});

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Başlat ────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
