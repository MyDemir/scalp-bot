'use strict';

require('dotenv').config();

const binance  = require('./binanceClient');
const telegram = require('./telegram');

/**
 * Giriş noktası — bilgi botu (src/infoBot.js).
 *   BOT_PAUSED=1 → makine açık kalır, bot hiçbir bağlantı açmaz (uzun backtest'ler için)
 */

function main() {
  if (process.env.BOT_PAUSED === '1') {
    console.log('[BOT] BOT_PAUSED=1 — canlı bot DURAKLATILDI (WebSocket/Telegram yok). Devam için: fly secrets unset BOT_PAUSED');
    setInterval(() => console.log('[BOT] duraklatıldı (BOT_PAUSED=1)'), 60 * 60 * 1000);
    return Promise.resolve();
  }
  return require('./infoBot').main();
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(sig) {
  console.log(`\n[BOT] ${sig} alındı, kapatılıyor...`);
  binance.stopWebSocket();
  telegram.stop();
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));   // Fly deploy/restart SIGTERM gönderir

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[REJECTION]', reason);
});

main().catch(err => {
  console.error('[FATAL]', err?.message || err);
  process.exit(1);
});
