'use strict';

/**
 * Spot / futures akış takibi — kartı ETKİLEMEZ, yalnız istatistik (/akis komutu, panel, CSV).
 *
 *   Evren   : botun izlediği coinlerden (hacim filtresi) BAĞIMSIZ — spotta USDT paritesi olan tüm USDT perpetual'lar
 *             (futures exchangeInfo ∩ spot exchangeInfo, 1000PEPEUSDT ↔ PEPEUSDT gibi eşleşmeyle); saatte bir yenilenir.
 *   Veri    : Binance klines (spot /api/v3/klines + futures fapi) 1h / 4h / 1d / 1w / 1M. Her mum toplam quote hacmini (alan 7),
 *             işlem sayısını (8) ve taker alış quote hacmini (10) verir; satış = toplam − alış. Yalnız KAPANMIŞ pencereler.
 *   Kayıt   : <DB_PATH klasörü>/flow.db · flow (pencere başına bir satır) · flow_label (coin+pencere için son etiket) ·
 *             flow_changes (etiket değişiklikleri). Etiketler satırda saklanmaz, okunurken o anki ayarlarla hesaplanır.
 *   Zaman   : ilk açılışta coin başına geçmiş (HISTORY) yüklenir; sonra her pencere kapanışından ~90 sn sonra son 3 mum
 *             (bot kapalı kaldıysa aradaki pencereler de) yeniden çekilir (upsert). Spot istekleri ayrı aralıkla sıralanır; futures istekleri botun ortak REST
 *             kuyruğundan geçer (binanceClient). Spotu olmayan coin hatırlanır, yalnız futures akışı tutulur.
 *   Etiket  : son K pencerede fiyat değişimi ile CVD (net akış / hacim %) birlikte okunur:
 *               fiyat yukarı + CVD artıyor → Trend teyitli (alım)     fiyat aşağı + CVD düşüyor → Trend teyitli (satış)
 *               fiyat yatay/aşağı + CVD artıyor → Toplanıyor          fiyat yatay/yukarı + CVD düşüyor → Dağıtım
 *               CVD yatay → Nötr
 *             Hacim katı (son pencere / önceki N pencere ortalaması) ≥ flowStrongX → "güçlü", < flowWeakX → "zayıf hacim".
 *             Spot ve futures CVD'si ters yöndeyse "spot/futures ayrışması".
 *
 * Taker alış "piyasa emriyle alan" demektir; büyük oyuncunun mal topladığının kanıtı değildir. Etiket yorumdur.
 */

const path = require('path');
const fs = require('fs');
const { spotOf } = require('./marketData');

const HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY, MONDAY0 = 4 * DAY;   // 1970-01-05 Pazartesi
const TFS = ['1h', '4h', '1d', '1w', '1M'];
const HISTORY = { '1h': 168, '4h': 120, '1d': 60, '1w': 30, '1M': 12 };     // ilk yüklemede kaç kapanmış pencere
const AVG_N = { '1h': 24, '4h': 20, '1d': 30, '1w': 12, '1M': 6 };          // hacim katı için önceki pencere sayısı
const KEEP_1H_DAYS = 30, KEEP_4H_DAYS = 180;
const SETTLE_MS = 90_000;                                         // kapanıştan sonra bekleme (Binance mumu kesinleşsin)
const UNIVERSE_MS = HOUR;                                         // evren (eşleşen spot+futures pariteleri) yenileme aralığı

const LABELS = {
  birikim:   'Toplanıyor',
  dagitim:   'Dağıtım',
  trendUp:   'Trend teyitli (alım)',
  trendDown: 'Trend teyitli (satış)',
  notr:      'Nötr',
};
const ICON = { birikim: '🟢', dagitim: '🔴', trendUp: '📈', trendDown: '📉', notr: '⚪' };

const DEFAULTS = { flowK: 6, flowCvdPct: 3, flowPricePct: 2, flowStrongX: 1.5, flowWeakX: 0.7, flowBuyPct: 55, flowSellPct: 45 };

const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/** Pencerenin açılış zamanı (UTC; hafta Pazartesi 00:00, ay ayın 1'i) */
function windowStart(tf, t) {
  if (tf === '1h') return Math.floor(t / HOUR) * HOUR;
  if (tf === '4h') return Math.floor(t / (4 * HOUR)) * 4 * HOUR;
  if (tf === '1d') return Math.floor(t / DAY) * DAY;
  if (tf === '1w') return Math.floor((t - MONDAY0) / WEEK) * WEEK + MONDAY0;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
/** Son KAPANMIŞ pencerenin açılış zamanı */
function lastClosedStart(tf, t) {
  const cur = windowStart(tf, t);
  return windowStart(tf, cur - 1);
}

/** Ham kline → satır (kapanmamışsa null) */
function rowOf(k, now) {
  if (!Array.isArray(k) || k.length < 11) return null;
  if (!(Number(k[6]) < now)) return null;
  const vol = parseFloat(k[7]), buy = parseFloat(k[10]);
  if (!Number.isFinite(vol) || !Number.isFinite(buy)) return null;
  return { t: Number(k[0]), vol, buy, open: parseFloat(k[1]), close: parseFloat(k[4]), trades: Number(k[8]) || 0 };
}

const dirOf = (v, th) => (v > th ? 1 : v < -th ? -1 : 0);

/**
 * Bir coin + pencere + piyasa satırlarından (eskiden yeniye) etiket.
 * @returns {null | {key, label, enough, priceChg, cvdPct, volX, buyPct, net, vol, strength, t}}
 */
function classify(rows, tf, s = {}) {
  const o = { ...DEFAULTS, ...s };
  if (!rows || !rows.length) return null;
  const K = Math.max(1, Math.floor(o.flowK));
  const last = rows[rows.length - 1];
  const base = {
    t: last.t, vol: last.vol, net: last.buy - (last.vol - last.buy),
    buyPct: last.vol > 0 ? num(last.buy / last.vol * 100, 1) : null,
  };
  const prev = rows.slice(Math.max(0, rows.length - 1 - AVG_N[tf]), rows.length - 1);
  const avg = prev.length ? prev.reduce((a, r) => a + r.vol, 0) / prev.length : null;
  base.volX = avg > 0 ? num(last.vol / avg, 2) : null;
  if (rows.length < K) return { ...base, key: null, label: 'Veri az', enough: false, priceChg: null, cvdPct: null, strength: null };
  const win = rows.slice(-K);
  const vol = win.reduce((a, r) => a + r.vol, 0);
  const net = win.reduce((a, r) => a + (2 * r.buy - r.vol), 0);
  const cvdPct = vol > 0 ? num(net / vol * 100, 2) : 0;
  const priceChg = win[0].open > 0 ? num((last.close / win[0].open - 1) * 100, 2) : 0;
  const p = dirOf(priceChg, o.flowPricePct), c = dirOf(cvdPct, o.flowCvdPct);
  const key = c === 0 ? 'notr'
    : c > 0 ? (p > 0 ? 'trendUp' : 'birikim')
    : (p < 0 ? 'trendDown' : 'dagitim');
  const strength = base.volX == null ? null : base.volX >= o.flowStrongX ? 'güçlü' : base.volX < o.flowWeakX ? 'zayıf hacim' : null;
  return { ...base, key, label: LABELS[key], enough: true, priceChg, cvdPct, strength };
}

/** Spotu olan futures sembolleri (futures sırası korunur) */
function matchPairs(futuresSyms, spotSyms) {
  const spot = new Set(spotSyms);
  return [...futuresSyms].filter(f => spot.has(spotOf(f).spot));
}

function defaultFile() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'signals.db');
  return process.env.FLOW_DB_PATH || path.join(path.dirname(dbPath), 'flow.db');
}

/**
 * @param {object} o
 * @param {Function} o.futuresKlines  (sym, tf, limit) → Promise<ham kline[]> (binanceClient.fetchKlines)
 * @param {Function} [o.getFuturesSymbols]  async () → işlemdeki USDT perpetual'lar (verilirse evren = bunların spotu olanları)
 * @param {Function} [o.getSymbols]   () → sembol listesi (getFuturesSymbols yoksa; testler)
 * @param {Function} [o.getSettings]  () → ayarlar (flow* anahtarları)
 */
function createSpotFlow({
  file = defaultFile(), futuresKlines, getFuturesSymbols = null, getSymbols = () => [], getSettings = () => ({}),
  spotBase = process.env.BINANCE_SPOT_BASE_URL || 'https://api.binance.com', fetchFn = globalThis.fetch,
  spotGapMs = 150, now = () => Date.now(), logger = console,
} = {}) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS flow (
        symbol TEXT NOT NULL, market TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
        vol REAL NOT NULL, buy REAL NOT NULL, open REAL, close REAL, trades INTEGER,
        PRIMARY KEY (symbol, market, tf, t)
      );
      CREATE TABLE IF NOT EXISTS flow_label (
        symbol TEXT NOT NULL, tf TEXT NOT NULL, market TEXT, label TEXT, t INTEGER, PRIMARY KEY (symbol, tf)
      );
      CREATE TABLE IF NOT EXISTS flow_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, tf TEXT NOT NULL, market TEXT,
        t INTEGER NOT NULL, at INTEGER NOT NULL, old TEXT, new TEXT
      );
      CREATE INDEX IF NOT EXISTS flow_changes_at ON flow_changes(at);
      CREATE INDEX IF NOT EXISTS flow_changes_sym ON flow_changes(symbol, at);
      CREATE TABLE IF NOT EXISTS flow_big (
        symbol TEXT NOT NULL, t INTEGER NOT NULL, buy_n INTEGER NOT NULL DEFAULT 0, buy_usd REAL NOT NULL DEFAULT 0,
        sell_n INTEGER NOT NULL DEFAULT 0, sell_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (symbol, t)
      );
    `);
  } catch (err) {
    logger.error(`[AKIŞ] ${file} açılamadı (${err.message}) — akış takibi KAPALI, bot çalışmaya devam ediyor`);
    db = null;
  }

  const st = db && {
    upsert: db.prepare(`INSERT INTO flow (symbol, market, tf, t, vol, buy, open, close, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, market, tf, t) DO UPDATE SET vol = excluded.vol, buy = excluded.buy, open = excluded.open, close = excluded.close, trades = excluded.trades`),
    rows: db.prepare('SELECT t, vol, buy, open, close, trades FROM flow WHERE symbol = ? AND market = ? AND tf = ? ORDER BY t DESC LIMIT ?'),
    label: db.prepare('SELECT label, market FROM flow_label WHERE symbol = ? AND tf = ?'),
    setLabel: db.prepare('INSERT INTO flow_label (symbol, tf, market, label, t) VALUES (?, ?, ?, ?, ?) ON CONFLICT(symbol, tf) DO UPDATE SET market = excluded.market, label = excluded.label, t = excluded.t'),
    addChange: db.prepare('INSERT INTO flow_changes (symbol, tf, market, t, at, old, new) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    changesAll: db.prepare('SELECT symbol, tf, market, t, at, old, new FROM flow_changes WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?'),
    changesSym: db.prepare('SELECT symbol, tf, market, t, at, old, new FROM flow_changes WHERE symbol = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?'),
    since: db.prepare('SELECT symbol, market, tf, t, vol, buy, open, close, trades FROM flow WHERE t >= ? ORDER BY symbol, market, tf, t'),
    purge4h: db.prepare("DELETE FROM flow WHERE tf = '4h' AND t < ?"),
    purge1h: db.prepare("DELETE FROM flow WHERE tf = '1h' AND t < ?"),
    purgeBig: db.prepare('DELETE FROM flow_big WHERE t < ?'),
    addBig: db.prepare(`INSERT INTO flow_big (symbol, t, buy_n, buy_usd, sell_n, sell_usd) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, t) DO UPDATE SET buy_n = buy_n + excluded.buy_n, buy_usd = buy_usd + excluded.buy_usd,
      sell_n = sell_n + excluded.sell_n, sell_usd = sell_usd + excluded.sell_usd`),
    bigSum: db.prepare('SELECT COUNT(*) AS hours, SUM(buy_n) AS buyN, SUM(buy_usd) AS buyUsd, SUM(sell_n) AS sellN, SUM(sell_usd) AS sellUsd FROM flow_big WHERE symbol = ? AND t >= ? AND t < ?'),
    bigSince: db.prepare('SELECT symbol, t, buy_n, buy_usd, sell_n, sell_usd FROM flow_big WHERE t >= ?'),
  };

  const noSpot = new Set();
  const seeded = new Set();                       // ilk geçmişi yüklenmiş coinler
  const done = {};                                // tf → en son güncellenen kapanmış pencere
  const stats = { requests: 0, rows: 0, errors: 0, changes: 0, lastRunMs: 0, running: false };
  let spotNext = 0;
  let universe = [], universeAt = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function spotKlines(sym, tf, limit) {
    const { spot } = spotOf(sym);
    if (noSpot.has(spot) || !fetchFn) return null;
    const wait = spotNext - Date.now();
    spotNext = Math.max(Date.now(), spotNext) + spotGapMs;
    if (wait > 0) await sleep(wait);
    stats.requests++;
    const res = await fetchFn(`${spotBase}/api/v3/klines?symbol=${spot}&interval=${tf}&limit=${limit}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 400) { noSpot.add(spot); return null; }
    if (!res.ok) throw new Error(`spot klines ${spot} ${tf}: HTTP ${res.status}`);
    const k = await res.json();
    return Array.isArray(k) ? k : null;
  }

  function save(sym, market, tf, klines) {
    if (!klines) return 0;
    const t = now();
    let n = 0;
    for (const k of klines) {
      const r = rowOf(k, t);
      if (!r) continue;
      st.upsert.run(sym, market, tf, r.t, r.vol, r.buy, r.open, r.close, r.trades);
      n++;
    }
    stats.rows += n;
    return n;
  }

  function rowsOf(sym, market, tf, n = 200) {
    if (!st) return [];
    return st.rows.all(sym, market, tf, n).reverse();
  }

  /** Coin + pencere için spot / futures sınıflandırması ve ayrışma */
  function summaryTf(sym, tf, s = getSettings()) {
    const spot = classify(rowsOf(sym, 'spot', tf), tf, s);
    const futures = classify(rowsOf(sym, 'futures', tf), tf, s);
    const o = { ...DEFAULTS, ...s };
    const diverge = Boolean(spot?.enough && futures?.enough
      && dirOf(spot.cvdPct, o.flowCvdPct) * dirOf(futures.cvdPct, o.flowCvdPct) < 0);
    const t = now();
    return { tf, spot, futures, diverge, main: spot?.enough ? 'spot' : futures?.enough ? 'futures' : null,
      big: bigSum(sym, lastClosedStart(tf, t), windowStart(tf, t)), bigLive: bigSum(sym, windowStart(tf, t), t + 1) };
  }

  function summary(sym) {
    return Object.fromEntries(TFS.map(tf => [tf, summaryTf(sym, tf)]));
  }

  /** Etiketi önceki kayıtla karşılaştır; değiştiyse flow_changes'e yaz */
  function checkLabel(sym, tf) {
    const sm = summaryTf(sym, tf);
    if (!sm.main) return null;
    const cur = sm[sm.main];
    const prev = st.label.get(sym, tf);
    st.setLabel.run(sym, tf, sm.main, cur.key, cur.t);
    if (prev && prev.label && prev.label !== cur.key) {
      st.addChange.run(sym, tf, sm.main, cur.t, now(), prev.label, cur.key);
      stats.changes++;
      return { symbol: sym, tf, old: prev.label, new: cur.key };
    }
    return null;
  }

  /** Spotta işlemdeki USDT pariteleri (exchangeInfo, weight 20) */
  async function spotSymbols() {
    stats.requests++;
    const res = await fetchFn(`${spotBase}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`spot exchangeInfo: HTTP ${res.status}`);
    const j = await res.json();
    return (j.symbols || []).filter(x => x.status === 'TRADING' && x.quoteAsset === 'USDT').map(x => x.symbol);
  }

  /** Takip edilecek semboller: eşleşen spot+futures pariteleri (saatte bir), hata olursa son liste */
  async function symbols() {
    if (!getFuturesSymbols) return [...new Set(getSymbols())];
    if (universe.length && now() - universeAt < UNIVERSE_MS) return universe;
    try {
      const [fut, spot] = await Promise.all([getFuturesSymbols(), spotSymbols()]);
      const next = matchPairs(fut, spot);
      if (next.length) {
        if (universe.length !== next.length) logger.log(`[AKIŞ] evren: ${next.length} eşleşen spot+futures paritesi`);
        universe = next; universeAt = now();
      }
    } catch (err) {
      stats.errors++;
      logger.warn(`[AKIŞ] evren yenilenemedi (${err?.message || err}) — ${universe.length ? 'son liste kullanılıyor' : 'tur atlandı'}`);
      universeAt = now() - UNIVERSE_MS + 5 * 60_000;     // 5 dk sonra yeniden dene
    }
    return universe;
  }

  async function fetchBoth(sym, tf, limit) {
    const out = { spot: 0, futures: 0 };
    try { out.spot = save(sym, 'spot', tf, await spotKlines(sym, tf, limit)); }
    catch (err) { stats.errors++; if (stats.errors <= 5 || stats.errors % 100 === 0) logger.warn(`[AKIŞ] ${err?.message || err}`); }
    try { stats.requests++; out.futures = save(sym, 'futures', tf, await futuresKlines(sym, tf, limit)); }
    catch (err) { stats.errors++; if (stats.errors <= 5 || stats.errors % 100 === 0) logger.warn(`[AKIŞ] futures klines ${sym} ${tf}: ${err?.message || err}`); }
    return out;
  }

  /**
   * Bir tur: yeni coinlerin geçmişini yükle, kapanışı geçmiş pencereleri güncelle, etiket değişimlerini yaz.
   * Aynı anda tek tur çalışır.
   */
  async function tick() {
    if (!st || stats.running) return { skipped: true };
    stats.running = true;
    const t0 = Date.now();
    const changed = [];
    try {
      const t = now();
      const syms = await symbols();
      const live = new Set(syms);
      for (const s of [...seeded]) if (!live.has(s)) seeded.delete(s);
      const due = TFS.filter(tf => {
        const lc = lastClosedStart(tf, t);
        const closeAt = windowStart(tf, t);
        return (done[tf] == null || lc > done[tf]) && t - closeAt >= SETTLE_MS;
      });
      // Kaçan pencere varsa (bot kapalıydı) arayı da çek: son 3 mum veya aradaki pencere sayısı + 2
      const limit = Object.fromEntries(due.map(tf => {
        let n = 0;
        for (let x = lastClosedStart(tf, t); done[tf] != null && x > done[tf] && n < HISTORY[tf]; x = windowStart(tf, x - 1)) n++;
        return [tf, Math.max(3, n + 2)];
      }));
      for (const sym of syms) {
        const fresh = !seeded.has(sym);
        const tfs = fresh ? TFS : due;
        for (const tf of tfs) {
          await fetchBoth(sym, tf, fresh ? HISTORY[tf] + 1 : limit[tf]);
          const c = checkLabel(sym, tf);
          if (c) changed.push(c);
        }
        if (fresh) seeded.add(sym);
      }
      for (const tf of due) done[tf] = lastClosedStart(tf, t);
      if (due.includes('1d')) { st.purge4h.run(t - KEEP_4H_DAYS * DAY); st.purge1h.run(t - KEEP_1H_DAYS * DAY); st.purgeBig.run(t - 400 * DAY); }
      return { symbols: syms.length, due, changed };
    } finally {
      stats.running = false;
      stats.lastRunMs = Date.now() - t0;
    }
  }

  function changes({ symbol = null, since = 0, limit = 25 } = {}) {
    if (!st) return [];
    const n = Math.max(1, Math.min(500, limit));
    return symbol ? st.changesSym.all(symbol, since, n) : st.changesAll.all(since, n);
  }

  /** Panel tablosu: evrendeki her coin için günlük spot özeti + 5 pencerenin etiketi + bugünkü büyük işlemler (60 sn önbellek) */
  let tableCache = null;
  function table() {
    if (!st) return [];
    if (tableCache && now() - tableCache.at < 60_000) return tableCache.rows;
    const s = getSettings();
    const syms = universe.length ? universe : [...seeded];
    const n = Math.max(...Object.values(AVG_N)) + Math.max(1, Math.floor(s.flowK ?? DEFAULTS.flowK)) + 1;
    const rows = syms.map(sym => {
      const t = now();
      const w = Object.fromEntries(TFS.map(tf => {
        const sp = classify(rowsOf(sym, 'spot', tf, n), tf, s), fu = classify(rowsOf(sym, 'futures', tf, n), tf, s);
        const m = sp?.enough ? sp : fu?.enough ? fu : sp || fu;
        return [tf, m ? { key: m.key, strength: m.strength, market: m === sp ? 'spot' : 'futures', cvdPct: m.cvdPct, buyPct: m.buyPct, vol: m.vol, net: m.net } : null];
      }));
      const d = rowsOf(sym, 'spot', '1d', 1)[0] || rowsOf(sym, 'futures', '1d', 1)[0];
      return {
        symbol: sym, vol: d ? d.vol : null, buyPct: d && d.vol > 0 ? num(d.buy / d.vol * 100, 2) : null,
        chg: d && d.open > 0 ? num((d.close / d.open - 1) * 100, 2) : null, windows: w,
        bigToday: bigSum(sym, windowStart('1d', t), t + 1), bigThreshold: num(bigThreshold(sym), 0),
      };
    }).sort((a, b) => (b.vol || 0) - (a.vol || 0));
    tableCache = { at: now(), rows };
    return rows;
  }

  /** Coin başına büyük işlem eşiği ($): max(flowBigMinUsd, son kapanmış günlük spot hacmi × flowBigPct / 100); günde bir hesaplanır */
  const thrCache = new Map();
  function bigThreshold(sym) {
    const s = { flowBigPct: 0.05, flowBigMinUsd: 5000, ...getSettings() };
    const day = windowStart('1d', now());
    let c = thrCache.get(sym);
    if (!c || c.day !== day) {
      const r = st ? st.rows.get(sym, 'spot', '1d', 1) : null;
      c = { day, vol: r ? r.vol : 0 };
      thrCache.set(sym, c);
    }
    return Math.max(s.flowBigMinUsd, c.vol * s.flowBigPct / 100);
  }

  /** Büyük işlem saatlik sayaçlarını ekle (bigTrades) */
  const recordBig = rows => {
    if (!st || !rows.length) return;
    db.transaction(list => { for (const r of list) st.addBig.run(r.symbol, r.t, r.buyN, r.buyUsd, r.sellN, r.sellUsd); })(rows);
  };

  /** [from, to) aralığındaki büyük alım/satım toplamı (saat sayaçlarından); kayıt yoksa null */
  function bigSum(sym, from, to) {
    if (!st) return null;
    const r = st.bigSum.get(sym, from, to);
    if (!r || !r.hours) return null;
    return { buyN: r.buyN || 0, buyUsd: r.buyUsd || 0, sellN: r.sellN || 0, sellUsd: r.sellUsd || 0, hours: r.hours };
  }

  /** CSV dışa aktarma için: pencere satırları + türetilmiş alanlar (spot satırlarına pencerenin büyük işlem sayıları) */
  function rowsSince(since) {
    if (!st) return [];
    const big = new Map();
    for (const b of st.bigSince.all(since)) {
      for (const tf of TFS) {
        const k = `${b.symbol}|${tf}|${windowStart(tf, b.t)}`;
        const a = big.get(k) || { n1: 0, u1: 0, n2: 0, u2: 0 };
        a.n1 += b.buy_n; a.u1 += b.buy_usd; a.n2 += b.sell_n; a.u2 += b.sell_usd;
        big.set(k, a);
      }
    }
    return st.since.all(since).map(r => ({
      symbol: r.symbol, market: r.market, tf: r.tf, time: new Date(r.t).toISOString(),
      vol_usd: num(r.vol, 0), buy_usd: num(r.buy, 0), sell_usd: num(r.vol - r.buy, 0), net_usd: num(2 * r.buy - r.vol, 0),
      buy_pct: r.vol > 0 ? num(r.buy / r.vol * 100, 2) : null, open: r.open, close: r.close,
      chg_pct: r.open > 0 ? num((r.close / r.open - 1) * 100, 2) : null, trades: r.trades,
      ...(() => {
        const b = r.market === 'spot' ? big.get(`${r.symbol}|${r.tf}|${r.t}`) : null;
        return { big_buy_n: b ? b.n1 : null, big_buy_usd: b ? num(b.u1, 0) : null, big_sell_n: b ? b.n2 : null, big_sell_usd: b ? num(b.u2, 0) : null };
      })(),
    }));
  }

  return {
    enabled: () => Boolean(st), tick, universe: () => universe.slice(), summary, summaryTf, changes, rowsSince, rowsOf, stats, recordBig, bigSum, bigThreshold, table,
    pairs: () => universe.map(f => [spotOf(f).spot, f]),
    hasSpot: sym => !noSpot.has(spotOf(sym).spot),
    close: () => { try { db?.close(); } catch { /* yok */ } },
  };
}

// ── Metin ────────────────────────────────────────────────────────────────────

const usd = v => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), sg = v < 0 ? '−' : v > 0 ? '+' : '';
  return sg + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0)) + ' $';
};
const sp = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(1)}`);
const TF_TXT = { '1h': '1s', '4h': '4s', '1d': 'Günlük', '1w': 'Haftalık', '1M': 'Aylık' };
const labelTxt = key => (key ? `${ICON[key]} ${LABELS[key]}` : '—');

function lineOf(c, s = {}) {
  if (!c) return 'veri yok';
  const o = { ...DEFAULTS, ...s };
  const side = c.buyPct == null ? '' : c.buyPct >= o.flowBuyPct ? '🟢' : c.buyPct <= o.flowSellPct ? '🔴' : '⚪';
  const head = c.enough ? `<b>${labelTxt(c.key)}</b>${c.strength ? ` (${c.strength})` : ''}` : 'Veri az';
  const trend = c.enough ? ` · ${o.flowK} pencere: fiyat ${sp(c.priceChg)} / CVD ${sp(c.cvdPct)}` : '';
  return `${head} · alış ${side}%${c.buyPct ?? '—'} · net ${usd(c.net)} · hacim ${usd(c.vol).replace('+', '')}${c.volX != null ? ` (${c.volX}×)` : ''}${trend}`;
}

function bigLine(b, label) {
  if (!b) return `${label}: kayıt yok`;
  const d = b.buyUsd - b.sellUsd;
  return `${label}: alım <b>${b.buyN}</b> (${usd(b.buyUsd).replace('+', '')}) · satım <b>${b.sellN}</b> (${usd(b.sellUsd).replace('+', '')}) · fark ${usd(d)}`;
}

function changeLine(c, withSym = true) {
  const at = new Date(c.at).toISOString().slice(5, 16).replace('T', ' ');
  return `${at} UTC · ${withSym ? `<b>${c.symbol}</b> ` : ''}${TF_TXT[c.tf] || c.tf}: ${LABELS[c.old] || c.old || '—'} → ${labelTxt(c.new)}${c.market === 'futures' ? ' (futures)' : ''}`;
}

/** /akis COIN */
function flowText(sym, sm, changes, s = {}, hasSpot = true) {
  const parts = [`🌊 <b>${sym}</b> — alım/satım akışı (kapanmış pencereler)`];
  for (const tf of TFS) {
    const x = sm[tf];
    parts.push(`\n<b>${TF_TXT[tf]}</b>${x.diverge ? ' · ⚠️ spot/futures ayrışması' : ''}`);
    if (hasSpot) parts.push(`Spot: ${lineOf(x.spot, s)}`);
    parts.push(`Futures: ${lineOf(x.futures, s)}`);
    if (hasSpot && (x.big || x.bigLive)) parts.push(`🐋 ${bigLine(x.big, 'Büyük işlem (son pencere)')}${x.bigLive ? `\n🐋 ${bigLine(x.bigLive, 'Devam eden pencere')}` : ''}`);
  }
  if (!hasSpot) parts.push('\nBu coinin spotu yok; etiket futures akışından.');
  parts.push(`\n<b>Güncellemeler</b>\n${changes.length ? changes.map(c => changeLine(c, false)).join('\n') : 'Henüz etiket değişikliği yok.'}`);
  parts.push(`\n<i>Taker alış = piyasa emriyle alan; mal toplamanın kanıtı değil, yorumdur. 🐋 = spotta tek seferde ≥ günlük spot hacminin %${s.flowBigPct ?? 0.05}'i (en az ${usd(s.flowBigMinUsd ?? 5000).replace('+', '')}) market emri (sayım botun açılışından itibaren).</i>`);
  return parts.join('\n');
}

/** /akis (argümansız) — tüm coinlerde son değişiklikler */
function changesText(rows, hours = 24) {
  if (!rows.length) return `🌊 Son ${hours} saatte akış etiketi değişen coin yok.`;
  return `🌊 <b>Akış güncellemeleri</b> — son ${hours} saat (${rows.length})\n${rows.map(c => changeLine(c)).join('\n')}\n\nCoin ayrıntısı: /akis ETH`;
}

module.exports = { createSpotFlow, matchPairs, classify, windowStart, lastClosedStart, rowOf, flowText, changesText, LABELS, TFS, HISTORY, DEFAULTS };
