'use strict';

require('dotenv').config();
const { MainClient, USDMClient, WebsocketClient } = require('binance');

// REST istemcisi (HTF polling + başlangıç seed verisi)
const restClient = new USDMClient({
  api_key:    process.env.BINANCE_API_KEY,
  api_secret: process.env.BINANCE_API_SECRET,
});

// ── REST Yardımcıları ──────────────────────────────────────────────────────

async function fetchKlines(symbol, interval, limit = 200) {
  const data = await restClient.getKlines({ symbol, interval, limit });
  return data;
}

async function fetch24hTickers() {
  return restClient.get24hrChangeStatistics();
}

async function fetchFundingRate(symbol) {
  const rows = await restClient.getFundingRateHistory({ symbol, limit: 1 });
  return rows.length ? parseFloat(rows[0].fundingRate) : null;
}

async function fetchOpenInterest(symbol) {
  const data = await restClient.getOpenInterest({ symbol });
  return data ? parseFloat(data.openInterest) : null;
}

// ── Likit Coin Filtresi ────────────────────────────────────────────────────

async function getLiquidSymbols(filterCfg) {
  const { minVolume24hUSDT, maxCoins, excludeKeywords } = filterCfg;
  const tickers = await fetch24hTickers();

  return tickers
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      if (excludeKeywords.some(k => t.symbol.includes(k))) return false;
      const vol = parseFloat(t.quoteVolume);
      return vol >= minVolume24hUSDT;
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, maxCoins)
    .map(t => t.symbol);
}

// ── WebSocket Yönetimi ─────────────────────────────────────────────────────

let wsClient = null;

function startWebSocket(symbols, timeframes, onKline, cfg) {
  if (wsClient) stopWebSocket();

  // Binance USDⓈ-M WS Base URL Split (duyuru 2026-03-06, eski URL'ler 2026-04-23'te emekli):
  //   kline / aggTrade / markPrice / ticker → wss://fstream.binance.com/market
  // Eski wss://fstream.binance.com/ws/... adresi BAĞLANIYOR ama kline verisi GÖNDERMİYOR.
  //
  // DİKKAT: 'binance' npm v2.15.x'te 'wsUrlMap' diye bir seçenek YOK (sessizce yok sayılır).
  // Desteklenen tek override 'wsUrl' — kütüphane bunun sonuna '/ws/<stream>' ekler:
  //   wss://fstream.binance.com/market/ws/btcusdt@kline_5m
  // wsUrl TÜM marketler için geçerli; biz sadece USDⓈ-M kline kullandığımız için sorun değil.
  wsClient = new WebsocketClient({
    api_key:    process.env.BINANCE_API_KEY,
    api_secret: process.env.BINANCE_API_SECRET,
    beautify:   true,
    wsUrl:      'wss://fstream.binance.com/market',
  });

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      wsClient.subscribeKlines(symbol, tf, 'usdm');
    }
  }

  wsClient.on('formattedMessage', (data) => {
    if (data.eventType !== 'kline' && data.e !== 'kline') return;
    const symbol  = data.symbol  || data.s;
    const kline   = data.kline   || data.k;
    if (!symbol || !kline) return;
    const tf       = kline.interval    || kline.i;
    const isFinal  = kline.final ?? kline.x ?? false;
    if (tf) onKline(symbol, tf, kline, isFinal);
  });

  // NOT: 'binance' kütüphanesi her tekil bağlantı (wsKey) için ping/pong
  // heartbeat ve otomatik reconnect'i KENDİ İÇİNDE yönetiyor. Aşağıdaki
  // event'ler sadece bilgi amaçlı loglama içindir — manuel restart YAPMIYOR.
  // Önceden buradaki 'close' handler'ı startWebSocket()'i tekrar çağırıp
  // TÜM 45 stream'i sıfırdan kuruyordu; bu, kütüphanenin kendi per-connection
  // reconnect'iyle çakışıp mükerrer bağlantılara yol açabiliyordu.

  wsClient.on('error', (data) => {
    console.error('[WS] Hata:', data?.wsKey ?? '', data?.error?.message || data?.error || data);
  });

  wsClient.on('reconnecting', (data) => {
    console.warn(`[WS] Yeniden bağlanıyor: ${data?.wsKey ?? '?'}`);
  });

  wsClient.on('reconnected', (data) => {
    console.log(`[WS] Yeniden bağlandı: ${data?.wsKey ?? '?'}`);
  });

  // NOT: Manuel ping döngüsü KASITLI olarak yok.
  // 'binance' npm kütüphanesi (WebsocketClient) her bağlantı için ping/pong
  // keepalive'ı kendi içinde otomatik yönetiyor (wsKey bazlı, per-connection).
  // wsClient.sendPing() parametresiz çağrılırsa "No wsKey provided" hatası
  // fırlatıyor ve bu da kütüphanenin kendi pong-timeout mekanizmasını
  // bozarak sürekli reconnect + uncaught exception'a yol açıyordu.
  // Detay: node_modules/binance/lib/websocket-client.js → tryWsPing(wsKey)

  console.log(`[WS] ${symbols.length} sembol × ${timeframes.length} TF = ${symbols.length * timeframes.length} stream başlatıldı`);
}

function stopWebSocket() {
  wsClient?.closeAll?.();
  wsClient = null;
}

module.exports = {
  restClient,
  fetchKlines,
  fetch24hTickers,
  fetchFundingRate,
  fetchOpenInterest,
  getLiquidSymbols,
  startWebSocket,
  stopWebSocket,
};
