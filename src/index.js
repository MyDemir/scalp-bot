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
  // Web sunucusunu ve botu birlikte başlat (DISABLE_WEB=1 ile yalnız konsol botu çalıştırılabilir)
  if (process.env.DISABLE_WEB !== '1') {
    try {
      require('./server').start();
      return Promise.resolve();
    } catch (err) {
      console.warn('[BOOT] Web sunucusu yüklenemedi, salt bilgi botu modunda devam ediliyor:', err.message);
    }
  }
  return require('./infoBot').main();
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(sig, code = 0) {
  console.log(`\n[BOT] ${sig} alındı, kontrollü kapatılıyor (çıkış kodu: ${code})...`);
  try { binance.stopWebSocket(); } catch (err) { console.error('[SHUTDOWN] WebSocket durdurulamadı:', err.message); }
  try { telegram.stop(); } catch (err) { console.error('[SHUTDOWN] Telegram durdurulamadı:', err.message); }
  // Bekleyen G/Ç ve logların boşalması için kısa bekleme, ardından kesin çıkış
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));   // Fly deploy/restart SIGTERM gönderir

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT FATAL]', err);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION FATAL]', reason);
  shutdown('unhandledRejection', 1);
});

main().catch(err => {
  console.error('[FATAL]', err?.message || err);
  shutdown('mainError', 1);
});
