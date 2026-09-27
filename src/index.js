'use strict';

require('dotenv').config();

const cfg           = require('./config');
const candleStore   = require('./candleStore');
const binance       = require('./binanceClient');
const htfPoller     = require('./htfPoller');
const signalEngine  = require('./signalEngine');
const tracker       = require('./eventTracker');
const telegram      = require('./telegram');

const TF_MS = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 60 * 60e3, '4h': 240 * 60e3, '1d': 1440 * 60e3 };
const SEED_LIMIT = 200;   // candleStore tampon boyu

// Kopma sonrası REST ile doldurulan semboller — dolum bitene kadar değerlendirilmez (boşluklu veri)
const backfilling = new Set();
let closes5m = 0;

// ── Başlangıç ─────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   SCALP SİNYAL MOTORU  v1.1          ║');
  console.log('║   Mert Stratejisi — RSI+MTF+Rejim     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`\nMod: ${cfg.mode.toUpperCase()}`);

  // ── 1. Telegram (env doğrulama dahil — eksikse burada açık hatayla durur) ──
  await telegram.start();

  // ── 2. Sembol listesi ────────────────────────────────
  const symbols = await resolveSymbols();

  // ── 3. Candle store + bekleyen sinyaller ─────────────
  candleStore.init(symbols, [...cfg.wsTimeframes, ...cfg.restTimeframes]);
  tracker.loadPending();

  // ── 4. WebSocket ÖNCE: seed sürerken kapanan mumlar kaçmasın (seed birleştirerek yazar) ──
  binance.startWebSocket(symbols, cfg.wsTimeframes, onKline, {
    onGap:   backfillGap,
    options: cfg.ws,
  });

  // ── 5. Tarihsel seed (weight bütçeli kuyruk üzerinden) ──
  await seedAll(symbols);

  // ── 6. HTF polling (1D seviyeler, OI, funding) ──
  htfPoller.startPolling(symbols);

  // ── 7. Heartbeat ──
  setInterval(heartbeat, cfg.heartbeatMs);

  console.log('\n✅ Bot çalışıyor.\n');
}

async function resolveSymbols() {
  if (cfg.mode === 'production') {
    console.log('Likit perpetual coinler filtreleniyor...');
    const list = await binance.getLiquidSymbols(cfg.autoFilter);
    const lim = cfg.autoFilter.maxCoins > 0 ? `en likit ${cfg.autoFilter.maxCoins}` : 'tümü';
    console.log(`${list.length} coin seçildi (${lim}, 24s hacim ≥ ${cfg.autoFilter.minVolume24hUSDT.toLocaleString()} USDT): ${list.slice(0, 8).join(', ')}${list.length > 8 ? ' ...' : ''}`);
    return list;
  }

  // Test modu: listedeki sembolleri Binance'te doğrula (ör. MATIC→POL gibi değişenler)
  let tradable = null;
  try {
    tradable = await binance.getTradableSymbols();
  } catch (err) {
    console.warn('[SEMBOL] exchangeInfo alınamadı, liste doğrulanmadan kullanılıyor:', err?.message || err);
    return cfg.testSymbols;
  }
  const ok      = cfg.testSymbols.filter(s => tradable.has(s));
  const missing = cfg.testSymbols.filter(s => !tradable.has(s));
  if (missing.length) console.warn(`[SEMBOL] Binance'te işlemde olmayan, listeden çıkarıldı: ${missing.join(', ')}`);
  console.log('Test modu — semboller:', ok.join(', '));
  return ok;
}

async function seedAll(symbols) {
  const t0 = Date.now();
  console.log(`Başlangıç kline verisi çekiliyor (${symbols.length} sembol × ${cfg.wsTimeframes.length} TF)...`);
  let done = 0, errors = 0;
  for (const symbol of symbols) {
    for (const tf of cfg.wsTimeframes) {
      try {
        candleStore.seed(symbol, tf, await binance.fetchKlines(symbol, tf, SEED_LIMIT));
      } catch (err) {
        errors++;
        console.error(`[SEED] ${symbol} ${tf}:`, err?.message || err);
      }
    }
    if (++done % 50 === 0) console.log(`[SEED] ${done}/${symbols.length} sembol`);
  }
  console.log(`Seed tamamlandı — ${Math.round((Date.now() - t0) / 1000)} sn, ${errors} hata.`);
}

/**
 * Bir WS bağlantısı koptuktan sonra veri geri geldiğinde çağrılır.
 * Kopukluk sırasında kapanan mumları REST ile tamamlar (yalnızca etkilenen TF'ler, az sayıda mum).
 */
async function backfillGap(symbols, downSince) {
  const now = Date.now();
  const tfs = cfg.wsTimeframes.filter(tf => Math.floor(downSince / TF_MS[tf]) !== Math.floor(now / TF_MS[tf]));
  if (!tfs.length) return;

  console.log(`[WS] ${Math.round((now - downSince) / 1000)} sn kopukluk — ${symbols.length} sembol için ${tfs.join('/')} dolduruluyor`);
  symbols.forEach(s => backfilling.add(s));
  for (const symbol of symbols) {
    for (const tf of tfs) {
      const limit = Math.min(SEED_LIMIT, Math.ceil((now - downSince) / TF_MS[tf]) + 2);
      try {
        candleStore.seed(symbol, tf, await binance.fetchKlines(symbol, tf, limit));
      } catch (err) {
        console.error(`[BACKFILL] ${symbol} ${tf}:`, err?.message || err);
      }
    }
    backfilling.delete(symbol);
  }
  console.log('[WS] Boşluk doldurma tamamlandı');
}

// ── WebSocket Kline Handler ────────────────────────────────────────────────

function onKline(symbol, tf, kline, isFinal) {
  candleStore.update(symbol, tf, kline);
  if (tf !== '5m') return;

  // Açık sinyallerin takibi — 5m akışı yeterli (diğer TF'ler aynı fiyatı tekrar ederdi)
  tracker.onPrice(symbol, {
    price:       kline.close,
    high:        kline.high,
    low:         kline.low,
    candleStart: kline.startTime,
  }, Date.now());

  // Sinyal değerlendirmesi sadece kapanan 5m mumda
  if (isFinal) {
    closes5m++;
    if (backfilling.has(symbol)) return;
    signalEngine
      .evaluate(symbol, htfPoller.getOIDelta(symbol), htfPoller.getFundingRate(symbol))
      .catch(err => console.error(`[EVAL] ${symbol}:`, err?.stack || err));
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

/**
 * Tek satırlık sağlık özeti. "Bağlı ama veri yok" gibi sessiz arızaları görünür kılar.
 */
function heartbeat() {
  const ws  = binance.takeWsStats();
  const ev  = signalEngine.takeCounters();
  const tg  = telegram.takeStats();
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const mins = Math.round(cfg.heartbeatMs / 60000);
  const c5 = closes5m;
  closes5m = 0;

  const topRejects = Object.entries(ev.rejects)
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, n]) => `${k}: ${n}`).join(', ') || '—';

  console.log(
    `[HEARTBEAT] WS ${ws?.open ?? 0}/${ws?.connections ?? 0} bağlı (${ws?.streams ?? 0} stream)` +
    ` | son ${mins}dk: ${ws?.messages ?? 0} mesaj, ${c5} kapanış(5m) → ${ev.evaluated} değerlendirme` +
    ` (${ev.notReady} veri hazır değil), ${ev.signals} sinyal` +
    ` | red: ${topRejects}` +
    ` | açık sinyal: ${tracker.openCount()}` +
    ` | telegram: ${tg.sent} gönderildi, ${tg.queued} kuyrukta${tg.failed ? `, ${tg.failed} BAŞARISIZ` : ''}` +
    ` | bellek: ${mem} MB`,
  );

  if (ws && ws.open > 0 && c5 === 0) {
    console.warn(`[UYARI] Son ${mins} dakikada hiç 5m mum kapanışı gelmedi — veri akışı kontrol edilmeli`);
  }
  if (ws && ws.reconnects > 0) {
    console.warn(`[UYARI] Son ${mins} dakikada ${ws.reconnects} WebSocket yeniden bağlanması`);
  }
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

// ── Başlat ────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[FATAL]', err?.message || err);
  process.exit(1);
});
