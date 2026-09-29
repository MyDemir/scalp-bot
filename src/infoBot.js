'use strict';

/**
 * BİLGİ BOTU — canlı çalışma katmanı.
 *
 *   Evren    : tüm USDT perpetual'lar, 24s hacim ≥ minVolumeM milyon $ (stabil coinler hariç).
 *              Saatte bir yenilenir; yeni coinler eklenir, hacmi eşiğin %80'inin altına düşenler çıkar
 *              (eşiğin hemen altında gidip gelen coin sürekli eklenip çıkarılmasın diye).
 *   Veri     : coin başına TEK WebSocket akışı (1m kline, yalnızca kapanışlar). 3m/5m/15m/1h/4h/1d
 *              src/series.js'te 1m'lerden üretilir. Başlangıçta her TF REST'ten tohumlanır.
 *   Kopukluk : yeniden bağlanınca kaçan 1m mumlar REST'ten çekilip sırayla uygulanır (üst TF'ler de
 *              böylece düzelir); kopukluk 200 dk'dan uzunsa coin baştan tohumlanır.
 *   Karar    : src/infoEngine.js (backtest ile aynı). Kart biçimi: src/infoCard.js
 *   Funding  : premiumIndex 5 dk'da bir (tek istek). OI: yalnızca kart üretilen coin için, 2 dk önbellek.
 *   Hareket  : izlenen coinde 1m kapanış bir önceki kapanışa göre ≥ %moveAlertPct → motor günlük sayaca yazar;
 *              RSI şartı sağlanıyorsa RSI kartına ⚡ satırı olarak girer (ayrı uyarı kartı yok). Evren dışı dinlenmez.
 *   Geçmiş   : her kart/uyarı src/cardStore.js ile /data/cards.db'ye yazılır, sonrası 15/60/240 dk izlenir.
 */

const cfg      = require('./config');
const binance  = require('./binanceClient');
const telegram = require('./telegram');
const { Series, normKline, KEEP, MIN } = require('./series');
const eng      = require('./infoEngine');
const { formatCard } = require('./infoCard');
const { compact } = require('./infoStats');
const { createCardStore } = require('./cardStore');
const chart = require('./chart');
const { createSettings } = require('./infoSettings');
const { installInfoTelegram } = require('./infoTelegram');

// 1m EN SON çekilir: böylece üst TF yarım mumlarıyla çakışan dakika sayısı en aza iner
const SEED_ORDER = ['1d', '4h', '1h', '15m', '5m', '3m', '1m'];
const PREMIUM_EVERY_MS  = 5 * 60_000;
const UNIVERSE_EVERY_MS = 60 * 60_000;
const OI_CACHE_MS       = 2 * 60_000;
const GAP_FILL_MAX_MIN  = 200;
const KEEP_BELOW_RATIO  = 0.8;       // evrenden çıkış: hacim < eşik × 0.8

const settings = createSettings();
const tracker  = eng.createTracker();
let store = null;             // kart geçmişi (main'de açılır)

const series  = new Map();   // sym → Series
const busy    = new Set();   // tohumlanan / boşluğu doldurulan semboller
const pending = new Map();   // sym → WS'ten gelen, iş bitince uygulanacak 1m mumlar
const failed  = new Map();   // sym → deneme sayısı
let premium   = new Map();
const oiCache = new Map();
let vols24    = new Map();   // sym → 24s hacim (USDT) — tüm işlemdeki pariteler

const stats = { closes: 0, cards: 0, cardsToday: 0, day: null, seeded: 0, seedErrors: 0, gapFills: 0 };
let startedAt = 0;
let seedingAll = false;

// ── Değerlendirme bağlamı ─────────────────────────────────────────────────

function btc1h() {
  const b = series.get('BTCUSDT');
  if (!b) return null;
  const c = b.d['1m'].c, n = c.length;
  return n > 60 ? (c[n - 1] / c[n - 61] - 1) * 100 : null;
}

const ctx = {
  funding: sym => premium.get(sym) || null,
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
  const thread = (card.grade === 3 && settings.topic('kart3')) || settings.topic('kart');
  telegram.sendCard({ text, keyboard, silent: card.silent, photo, thread });
  store?.add({ id: card.id, kind: 'card', symbol: card.symbol, t: card.t, seq: card.seq, price: card.price, data: { ...compact(card), bursts: undefined, fwd: undefined } });
  const lv = card.snap.level;
  console.log(`[KART] ${card.symbol} #${card.seq} derece ${card.grade} · RSI ${card.snap.hits}/3 · ${lv ? `${lv.name} ${lv.dist.toFixed(2)}% ${lv.zone}` : 'seviye yok'} · ${card.silent ? 'sessiz' : 'SESLİ'} · ${card.news.join(' | ')}`);
}

// ── Mum işleme ────────────────────────────────────────────────────────────

function toCandle(k) {
  return {
    t: k.startTime, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
    tb: k.takerBuyBase || 0, q: k.quoteVolume || 0, tq: k.takerBuyQuote || 0, closed: true,
  };
}

function processCandle(sr, c, live) {
  stats.closes++;
  const closed = sr.apply1m(c);
  store?.onCandle(sr.symbol, c);
  if (!live) return;
  let card = null;
  try {
    card = eng.step(sr, closed, settings.get(), tracker, ctx);
  } catch (err) {
    console.error(`[DEĞERLENDİRME] ${sr.symbol}:`, err?.stack || err);
  }
  if (card) {
    // Aynı coinin kartları sırayla kuyruğa girsin (OI isteği async — #3, #2'den önce gitmesin)
    const sym = sr.symbol;
    const prev = chains.get(sym) || Promise.resolve();
    const next = prev.then(() => emitCard(card)).catch(err => console.error(`[KART] ${sym} gönderilemedi:`, err?.message || err));
    chains.set(sym, next);
    next.then(() => { if (chains.get(sym) === next) chains.delete(sym); });
  }
}
const chains = new Map();

/** 📋 Detay butonunun metinleri (bellekte, son DETAIL_MAX kart; bot yeniden başlayınca eski kartların detayı yok) */
const DETAIL_MAX = 3000;
const details = {
  map: new Map(),
  set(id, html) { this.map.set(id, html); if (this.map.size > DETAIL_MAX) this.map.delete(this.map.keys().next().value); },
  get(id) { return this.map.get(id) ?? null; },
};

/** Ayarlardaki Ichimoku parametreleri */
function ichiOf(s) {
  return { tenkan: s.ichiTenkan, kijun: s.ichiKijun, chikou: s.ichiChikou, senkouB: s.ichiSenkouB, shift: s.ichiShift };
}

/**
 * Grafik (ayarlardaki zaman dilimi; varsayılan 1h). EMA21 3m/5m çizgileri yalnız 5m grafikte anlamlı.
 * @param {object[]} [candles] verilmezse series'ten alınır
 */
function chartOf(sr, s, level, levels, subtitle, candles = null) {
  const tf = s.chartTf || '1h';
  const cs = candles || chart.candlesFromSeries(sr, tf);
  return chart.renderChart({
    symbol: sr.symbol, candles: cs, tf, level, levels,
    overlays: tf === '5m' && sr ? chart.emaOverlays(sr, cs) : [],
    ichi: ichiOf(s), showIchi: s.chartIchi, fib: s.chartFib, fibLeg: sr?._lv?.leg ?? null, subtitle,
  });
}

function onKline(symbol, tf, k, isFinal) {
  if (!isFinal || tf !== '1m') return;
  const c = toCandle(k);
  const sr = series.get(symbol);
  if (!sr) return;                             // evren dışı (listeden yeni çıkmış) — dinlenmez
  if (busy.has(symbol)) pending.get(symbol)?.push(c);
  else processCandle(sr, c, true);
}

/** WebSocket'te olması gereken semboller: yalnızca izlenen evren */
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
      if (!series.has(sym)) return false;             // bu arada evrenden çıkarıldı
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
    // başarısızsa da kilidi aç — bekleyen mumlar tohum olmadan uygulanmaz (ready() false kalır)
    if (!failed.has(sym)) flushPending(sym);
    else { busy.delete(sym); pending.delete(sym); }
  }
}

async function seedMany(list, label) {
  const t0 = Date.now();
  let done = 0;
  for (const sym of list) {
    await seedSymbol(sym);
    if (++done % 50 === 0) console.log(`[SEED] ${label}: ${done}/${list.length} coin (${Math.round((Date.now() - t0) / 1000)} sn)`);
  }
  console.log(`[SEED] ${label}: ${list.length} coin tamam — ${Math.round((Date.now() - t0) / 1000)} sn`);
}

// ── Kopukluk sonrası doldurma ─────────────────────────────────────────────

async function backfillGap(symbols, downSince) {
  const gapMin = Math.ceil((Date.now() - downSince) / MIN) + 2;
  console.log(`[WS] ${gapMin} dk kopukluk — ${symbols.length} coin dolduruluyor`);
  stats.gapFills++;
  for (const sym of symbols) {
    const sr = series.get(sym);
    if (!sr || busy.has(sym)) continue;
    if (gapMin > GAP_FILL_MAX_MIN || !sr.ready()) { await seedSymbol(sym); continue; }
    busy.add(sym);
    pending.set(sym, pending.get(sym) || []);
    try {
      const raw = await binance.fetchKlines(sym, '1m', Math.min(gapMin + 1, KEEP['1m'] + 1));
      const now = Date.now();
      for (const c of (raw || []).map(k => normKline(k, now)).filter(c => c.closed)) processCandle(sr, c, false);
    } catch (err) {
      console.error(`[BOŞLUK] ${sym}: ${err?.message || err}`);
    } finally {
      flushPending(sym);
    }
  }
  console.log('[WS] Boşluk doldurma tamamlandı');
}

// ── Evren ─────────────────────────────────────────────────────────────────

async function refreshUniverse(initial = false) {
  let vols;
  try {
    vols = await binance.getSymbolVolumes(cfg.autoFilter.excludeBaseAssets);
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

  for (const s of removed) { series.delete(s); tracker.forget(s); pending.delete(s); busy.delete(s); }
  for (const s of added) { series.set(s, new Series(s)); if (!initial) { busy.add(s); pending.set(s, []); } }
  // Başarısız tohumlar yeniden denensin
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
Coin: ${series.size} izleniyor · ${readyCount()} hazır${busy.size ? ` · ${busy.size} yükleniyor` : ''}${failed.size ? ` · ${failed.size} hata` : ''}
Evren: 24s hacim ≥ ${s.minVolumeM}M $
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
  const cards = stats.cards;
  stats.cards = 0;
  store?.sweep();
  console.log(
    `[HEARTBEAT] WS ${ws?.open ?? 0}/${ws?.connections ?? 0} bağlı (${ws?.streams ?? 0} stream)` +
    ` | son ${mins}dk: ${closes} 1m kapanış, ${ws?.skipped ?? 0} ara güncelleme atlandı, ${cards} kart` +
    ` | coin: ${readyCount()}/${series.size} hazır${busy.size ? `, ${busy.size} yükleniyor` : ''}` +
    ` | takipte ${store?.openCount() ?? 0} kart` +
    ` | telegram: ${tg.sent} gönderildi, ${tg.queued} kuyrukta${tg.failed ? `, ${tg.failed} BAŞARISIZ` : ''}` +
    ` | bellek: ${mem} MB`,
  );
  if (ws && ws.open > 0 && closes === 0 && !seedingAll) {
    console.warn(`[UYARI] Son ${mins} dakikada hiç 1m kapanışı işlenmedi — veri akışı kontrol edilmeli`);
  }
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
  await telegram.start();
  installInfoTelegram({ telegram, settings, tracker, store, details, getSeries: sym => series.get(sym), ctx: () => ctx, status: statusText, chartFor: (sym, level, levels = []) => {
    const sr = series.get(sym), s0 = settings.get();
    if (!sr || !s0.chart) return null;
    return chartOf(sr, s0, level, levels, 'Anlık');
  } });
  console.log(`[GRAFİK] ${chart.available() ? `açık (${settings.get().chartTf} · Ichimoku bulutu · Fibonacci)` : 'KAPALI — @napi-rs/canvas yüklenemedi, kartlar grafiksiz gider'}`);

  console.log('Evren belirleniyor...');
  const { list } = await refreshUniverse(true);
  console.log(`${list.length} coin izlenecek (24s hacim ≥ ${s.minVolumeM}M $): ${list.slice(0, 10).join(', ')}${list.length > 10 ? ' …' : ''}`);
  for (const sym of list) { busy.add(sym); pending.set(sym, []); }

  // WebSocket ÖNCE: tohumlama sürerken kapanan mumlar kaçmasın (pending'e yazılır)
  const wsList = wsSymbols();
  console.log(`WebSocket: ${wsList.length} parite (izlenen)`);
  binance.startWebSocket(wsList, ['1m'], onKline, { onGap: backfillGap, options: { ...cfg.ws, finalOnly: true } });

  await pollPremium();
  setInterval(pollPremium, PREMIUM_EVERY_MS);
  setInterval(heartbeat, cfg.heartbeatMs);

  seedingAll = true;
  console.log(`Geçmiş veri yükleniyor (${list.length} coin × ${SEED_ORDER.length} zaman dilimi) — REST limitine göre birkaç dakika sürer; hazır olan coinler hemen değerlendirilir.`);
  await seedMany(list, 'başlangıç');
  seedingAll = false;

  setInterval(() => refreshUniverse().catch(err => console.error('[EVREN]', err?.message || err)), UNIVERSE_EVERY_MS);
  settings.onChange((key) => {
    if (key === 'minVolumeM') refreshUniverse().catch(err => console.error('[EVREN]', err?.message || err));
  });

  const s2 = settings.get();
  telegram.sendText(`🟢 <b>Bilgi botu hazır</b> — ${readyCount()}/${series.size} coin izleniyor (24s hacim ≥ ${s2.minVolumeM}M $)` +
    ` · kart şartı RSI ≥ ${s2.rsiMin} (${s2.minTFs}/3)` +
    (s2.moveAlertPct > 0 ? ` · 1 dk ≥ %${s2.moveAlertPct} hareket RSI kartına eklenir` : '') +
    `. Komutlar: /yardim · Ayarlar: /ayarlar`, null, settings.topic('sistem'));
  console.log('\n✅ Bilgi botu çalışıyor.\n');
}

module.exports = { main, _internal: { series, settings, tracker, processCandle, onKline, seedSymbol, refreshUniverse, backfillGap, statusText, stats, busy, pending, details, getStore: () => store } };
