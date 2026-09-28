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
 */

const cfg      = require('./config');
const binance  = require('./binanceClient');
const telegram = require('./telegram');
const { Series, normKline, KEEP, MIN } = require('./series');
const eng      = require('./infoEngine');
const { formatCard } = require('./infoCard');
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

const series  = new Map();   // sym → Series
const busy    = new Set();   // tohumlanan / boşluğu doldurulan semboller
const pending = new Map();   // sym → WS'ten gelen, iş bitince uygulanacak 1m mumlar
const failed  = new Map();   // sym → deneme sayısı
let premium   = new Map();
const oiCache = new Map();

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

async function emitCard(card) {
  stats.cards++;
  const day = new Date().toISOString().slice(0, 10);
  if (stats.day !== day) { stats.day = day; stats.cardsToday = 0; }
  stats.cardsToday++;
  const oi = await oiChange(card.symbol);
  if (oi != null) card.oi = { changePct: oi };
  const { text, keyboard } = formatCard(card, settings.get(), { now: Date.now() });
  telegram.sendCard({ text, keyboard, silent: card.silent });
  const lv = card.snap.level;
  console.log(`[KART] ${card.symbol} #${card.seq} RSI ${card.snap.hits}/3 · ${lv ? `${lv.name} ${lv.dist.toFixed(2)}% ${lv.zone}` : 'seviye yok'} · ${card.silent ? 'sessiz' : 'SESLİ'} · ${card.news.join(' | ')}`);
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

function onKline(symbol, tf, k, isFinal) {
  if (!isFinal || tf !== '1m') return;
  const sr = series.get(symbol);
  if (!sr) return;
  const c = toCandle(k);
  if (busy.has(symbol)) { pending.get(symbol)?.push(c); return; }
  processCandle(sr, c, true);
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
  if (added.length || removed.length) {
    binance.setWsSymbols([...series.keys()]);
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
  console.log(
    `[HEARTBEAT] WS ${ws?.open ?? 0}/${ws?.connections ?? 0} bağlı (${ws?.streams ?? 0} stream)` +
    ` | son ${mins}dk: ${closes} 1m kapanış, ${ws?.skipped ?? 0} ara güncelleme atlandı, ${cards} kart` +
    ` | coin: ${readyCount()}/${series.size} hazır${busy.size ? `, ${busy.size} yükleniyor` : ''}` +
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

  await telegram.start();
  installInfoTelegram({ telegram, settings, tracker, getSeries: sym => series.get(sym), ctx: () => ctx, status: statusText });

  console.log('Evren belirleniyor...');
  const { list } = await refreshUniverse(true);
  console.log(`${list.length} coin izlenecek (24s hacim ≥ ${s.minVolumeM}M $): ${list.slice(0, 10).join(', ')}${list.length > 10 ? ' …' : ''}`);
  for (const sym of list) { busy.add(sym); pending.set(sym, []); }

  // WebSocket ÖNCE: tohumlama sürerken kapanan mumlar kaçmasın (pending'e yazılır)
  binance.startWebSocket(list, ['1m'], onKline, { onGap: backfillGap, options: { ...cfg.ws, finalOnly: true } });

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

  telegram.sendText(`🟢 <b>Bilgi botu hazır</b> — ${readyCount()}/${series.size} coin izleniyor (24s hacim ≥ ${s.minVolumeM}M $). Komutlar: /yardim · Ayarlar: /ayarlar`);
  console.log('\n✅ Bilgi botu çalışıyor.\n');
}

module.exports = { main, _internal: { series, settings, tracker, processCandle, onKline, seedSymbol, refreshUniverse, backfillGap, statusText, stats, busy, pending } };
