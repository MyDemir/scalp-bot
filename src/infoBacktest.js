'use strict';

/**
 * Bilgi botu backtest'i — "geçmişte bot çalışsaydı hangi kartlar gelirdi?"
 *
 *   • Canlı botla AYNI kod: src/series.js (1m'den üst TF üretimi) + src/infoEngine.js (şart, yeni veri,
 *     numaralandırma) + src/infoCard.js (kart metni). Her 1m kapanışı sırayla oynatılır.
 *   • Look-ahead yok: üst TF'ler dönem başından önce KAPANMIŞ mumlarla tohumlanır, sonrası yalnızca
 *     o ana kadarki 1m'lerden üretilir. Dönem başlangıcı UTC gece yarısına hizalanır (yarım mum kalmaz).
 *   • Kazanç/kayıp hesabı YOK. Her kart için yalnızca "sonrasında fiyat ne yaptı" bilgisi (sonraki
 *     15/60 dk'daki en düşük / en yüksek / kapanış) tutulur — kart sınıflarını kıyaslamak için.
 *   • Funding ve OI geçmişi coin başına bir kez çekilir (fundingRate, openInterestHist 5m); t anında yalnız t'ye kadar
 *     bilinen değer verilir (ctx.funding canlı biçimiyle, kart oi ve tepe kaydı oiChg15/oiChg60/oiUsd marketData'daki
 *     ortak hesapla). OI yalnız son 30 gün (Binance sınırı; daha eskisi boş). BTC 1h bağlamı ve ctx.market
 *     (btc5/btc15/btcRsi15) geçmişten hesaplanır; breadth80/pumping null. Eksik bağlam listesi: LIMITS (konsol + JSON params.limits).
 *
 * Çalıştırma (Binance'e erişen yerde — Fly makinesinde):
 *   node src/infoBacktest.js                         # tüm evren (dönem öncesi 24s hacim ≥ ayar), son 30 gün
 *   node src/infoBacktest.js --days 7 --max-coins 50 # hızlı deneme
 *   node src/infoBacktest.js --symbol ETHUSDT,SOLUSDT --days 60 --ornek 5
 *   node src/infoBacktest.js --ayar rsiMin=95,minTFs=3,levelMaxPct=2   # ayar dene
 *   node src/infoBacktest.js --canli-ayar            # /data/info-settings.json'daki (Telegram'dan değiştirilmiş) ayarlarla
 *   node src/infoBacktest.js --kanit --days 1        # KANIT modu: RSI ≥ 70, sıfırlama 60 → çok kart; motorun çalıştığını
 *                                                    # görmek için (yalnızca bu backtest'te; canlı ayarlara dokunmaz)
 *   --telegram → bitince özet + seviye tepkisi tablosu + 2 örnek kart gruba gönderilir
 *   Seviye tepkisi (src/levelTouch.js, canlıdaki /seviye ile aynı ölçü) her backtest'te hesaplanır ve yazdırılır.
 *   --seviye-filtre fib → tabloda yalnız adında "fib" geçen seviyeler
 *   Düşüş defteri (src/eventLog.js, canlıdaki /kacan ile aynı) her backtest'te hesaplanır; JSON'da `drops` (tüm göstergelerle)
 *
 * Çıktı: backtest-results/info-<zaman>.json + konsol özeti
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const cfg = require('./config');
const { Series, normKline, KEEP, MIN } = require('./series');
const eng = require('./infoEngine');
const { formatCard, toPlain, esc } = require('./infoCard');
const { createSettings } = require('./infoSettings');
const { withRetry } = require('./binanceClient');
const { oiFields, oiChange1h } = require('./marketData');
const ta = require('./ta');
const { createTouchTracker } = require('./levelTouch');
const { createDropLedger, dropText, teyitText, DEFAULTS: DROP_DEFAULTS } = require('./eventLog');

const DAY = 86_400_000;
const KANIT = { rsiMin: 70, resetRsi: 60 };   // --kanit
const PAGE = 1000;
const REQ_DELAY_MS = Number(process.env.BACKTEST_REQ_DELAY_MS ?? 350);
const SEED_TFS = ['1d', '4h', '1h', '15m', '5m', '3m'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

let klineSource = null;
const source = () => (klineSource ||= require('./binanceClient').restClient);

/** [from, to) aralığındaki kapanmış 1m mumlar (sayfalı) */
async function fetch1m(symbol, from, to) {
  const out = [];
  let t = from;
  while (t < to) {
    const raw = await withRetry(() => source().getKlines({ symbol, interval: '1m', startTime: t, endTime: to - 1, limit: PAGE }), `${symbol} 1m`);
    await sleep(REQ_DELAY_MS);
    if (!raw || !raw.length) break;
    for (const k of raw) {
      const c = normKline(k, to);
      if (c.t >= t && c.closeTime < to && (!out.length || c.t > out[out.length - 1].t)) out.push(c);
    }
    const next = Number(raw[raw.length - 1][0]) + MIN;
    if (next <= t) break;
    t = next;
    if (raw.length < PAGE) break;
  }
  return out;
}

/** start'tan ÖNCE kapanmış son n mum */
async function fetchBefore(symbol, tf, start, n) {
  const raw = await withRetry(() => source().getKlines({ symbol, interval: tf, endTime: start - 1, limit: n }), `${symbol} ${tf}`);
  await sleep(REQ_DELAY_MS);
  return (raw || []).map(k => normKline(k, start)).filter(c => c.closed);
}

// ── BTC piyasa bağlamı (canlıdaki infoBot marketState'in BTC kısmı) ─────────

/** Backtest'te canlıdan eksik kalan bağlam (konsol + JSON params.limits + README) */
const LIMITS = [
  'OI yalnız son 30 gün (daha eskisi boş; Binance openInterestHist sınırı)',
  'funding = son ödenmiş oran; canlıdaki premiumIndex lastFundingRate o dönemin tahmini oranı olduğundan backtest funding\'i canlıya göre bir dönem geriden gelir (look-ahead\'i önlemek için bilinçli)',
  'funding aralığı değişen coinde değişimden sonraki ilk dönemde minToFunding sapabilir',
  'baz (mark − endeks) yok: funding geçmişinde mark/endeks yok → basisPct boş',
  'likidasyon akışı yok',
  'breadth80 ve pumping yok (evrenin aynı andaki durumu gerekir; backtest sembol sembol koşar → null)',
  'breadth20 ve dumping yok (aynı neden → null); q24h hesaplanır',
  'spot / emir defteri / long-short oranları verisi yok',
  'sessize alma ve takip (cooldown, seri akışı) canlıdaki gibi işlemez',
  'evren dönem başından önceki 24s hacme göre seçilir; Binance listeden tamamen çıkmış (DELISTED) coinleri exchangeInfo\'da vermediği için onlar yok (kalan hayatta kalma yanlılığı); dönem başından önceki gün listelenenler dışarıda',
];

/**
 * BTC 1m mumlarından t anındaki {btc5, btc15, btcRsi15} (canlı marketState ile aynı tanım ve yuvarlama).
 * Tek geçişte hesaplanıp zaman indeksli Float64Array'lerde tutulur (365 gün ≈ 13 MB); t için yalnızca
 * t'den ÖNCE kapanmış 1m'ler kullanılmıştır (look-ahead yok). breadth80 / pumping / breadth20 / dumping her zaman null.
 * @returns {(t:number)=>{breadth80:null,pumping:null,btc5:?number,btc15:?number,btcRsi15:?number}}
 */
function createBtcMarket(btc1m) {
  if (!btc1m || !btc1m.length) return () => ({ breadth80: null, pumping: null, breadth20: null, dumping: null, btc5: null, btc15: null, btcRsi15: null });
  const t0 = btc1m[0].t, N = Math.floor((btc1m[btc1m.length - 1].t - t0) / MIN) + 1;
  const b5 = new Float64Array(N).fill(NaN), b15 = new Float64Array(N).fill(NaN), rs = new Float64Array(N).fill(NaN);
  const sr = new Series('BTCUSDT');
  const bc = [];
  for (const c of btc1m) {
    sr.apply1m(c);
    bc.push(c.c);
    const n = bc.length, i = Math.floor((c.t - t0) / MIN);
    const chg = m => (n > m && bc[n - 1 - m] > 0 ? +((bc[n - 1] / bc[n - 1 - m] - 1) * 100).toFixed(2) : NaN);
    b5[i] = chg(5); b15[i] = chg(15);
    const r = ta.rsiLast(sr.col('15m', 'c', true), 14);
    rs[i] = r == null ? NaN : +r.toFixed(1);
    if (n > 300) bc.splice(0, n - 20);                  // yalnızca son ~20 kapanış gerekir
  }
  const g = (a, i) => (i >= 0 && i < N && !Number.isNaN(a[i]) ? a[i] : null);
  return t => {
    const i = Math.floor((t - MIN - t0) / MIN);       // t'den önce kapanan son 1m
    return { breadth80: null, pumping: null, breadth20: null, dumping: null, btc5: g(b5, i), btc15: g(b15, i), btcRsi15: g(rs, i) };
  };
}

// ── Funding / OI geçmişi (t anında bilinen son değer; look-ahead yok) ───────

/** fundingRate satırlarında (eskiden yeniye) zamanı ≤ t olan son satırın sırası; yoksa −1 */
function lastAtOrBefore(times, t) {
  let lo = 0, hi = times.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}

/**
 * t anında bilinen funding — canlı ctx.funding biçimi {rate, next, mark, index}.
 * rate: fundingTime ≤ t olan son ÖDENMİŞ oran (canlıdaki premiumIndex lastFundingRate'in geçmişteki en yakın karşılığı).
 * next: son iki ödeme arasındaki aralıkla bir sonraki ödeme zamanı (yalnız t'ye kadarki ödemelerden; tek ödeme varsa null).
 * mark / index: geçmişi yok → null.
 */
function createFundingAt(rows = []) {
  const ft = rows.map(r => Number(r.fundingTime)), fr = rows.map(r => parseFloat(r.fundingRate));
  const mn = x => Math.round(x / MIN) * MIN;
  return t => {
    const i = lastAtOrBefore(ft, t);
    if (i < 0 || !Number.isFinite(fr[i])) return null;
    const step = i > 0 ? mn(ft[i]) - mn(ft[i - 1]) : 0;
    return { rate: fr[i], next: step > 0 ? mn(ft[i]) + step : null, mark: null, index: null };
  };
}

/**
 * t anında bilinen son 13 OI noktası (timestamp ≤ t; canlıdaki limit 13 / endTime t isteğinin karşılığı).
 * 60 dk tam kapsanmıyorsa (30 gün sınırı, veri boşluğu) null — eksik veri uydurulmaz.
 */
function createOiAt(rows = []) {
  const ts = rows.map(r => Number(r.timestamp));
  return t => {
    const i = lastAtOrBefore(ts, t);
    if (i < 12 || ts[i - 12] < t - 65 * MIN) return null;
    return rows.slice(i - 12, i + 1);
  };
}

/** Coin başına bir kez: dönemin funding ve OI geçmişi (hata olursa o alan boş kalır, backtest sürer) */
async function fetchHist(symbol, start, end) {
  const bc = require('./binanceClient');
  const out = { funding: [], oi: [], errors: [] };
  try { out.funding = await bc.fundingRateHistory(symbol, start - 2 * DAY, end - 1, { delayMs: REQ_DELAY_MS }); } catch (err) { out.errors.push(`funding: ${err?.message || err}`); }
  try { out.oi = await bc.openInterestHistRange(symbol, start - 65 * MIN, end - 1, { delayMs: REQ_DELAY_MS }); } catch (err) { out.errors.push(`OI: ${err?.message || err}`); }
  return out;
}

// ── Tek coin ───────────────────────────────────────────────────────────────

function forward(m1, i, price) {
  const r = {};
  for (const w of [5, 15, 30, 60]) {
    let lo = Infinity, hi = -Infinity, last = null;
    for (let j = i + 1; j <= i + w && j < m1.length; j++) { if (m1[j].l < lo) lo = m1[j].l; if (m1[j].h > hi) hi = m1[j].h; last = m1[j].c; }
    if (last == null) { r[w] = null; continue; }
    r[w] = { low: (lo - price) / price * 100, high: (hi - price) / price * 100, close: (last - price) / price * 100, full: i + w < m1.length };
  }
  return r;
}

async function runSymbol(symbol, { start, end, s, btcClose, btcMarket, keepCards }) {
  const sr = new Series(symbol);
  for (const tf of SEED_TFS) sr.seed(tf, await fetchBefore(symbol, tf, start, KEEP[tf]));
  const m1 = await fetch1m(symbol, start - KEEP['1m'] * MIN, end);
  const first = m1.findIndex(c => c.t >= start);
  if (first < 0) return { symbol, cards: [], minutes: 0, note: 'dönemde veri yok' };
  sr.seed('1m', m1.slice(0, first));
  sr.seedPartials(m1.slice(0, first), start);                 // start'ta açık üst TF periyotları (canlı tohumdaki kısmi mum gibi); ek istek yok

  const tracker = eng.createTracker();
  const touchTr = createTouchTracker();
  const touches = [];
  const hist = await fetchHist(symbol, start, end);
  const fundingAt = createFundingAt(hist.funding), oiAt = createOiAt(hist.oi);
  hist.funding = hist.oi = null;
  let now = start;                                            // işlenen 1m'nin kapanış anı (ctx.funding canlıdaki gibi yalnız sembol alır)
  // Tepe kaydı OI alanları: canlıdaki enrich'in OI kısmı (aynı hesap, tepe anına hizalı); diğer enrich alanları backtest'te yok
  const dropTr = createDropLedger({ ...cfg.events, enrich: (sym, { t }) => { const r = oiAt(t); return r ? oiFields(r) : null; } });
  const drops = [];
  const ctx = {
    funding: () => fundingAt(now),
    btc1h: t => {
      const a = btcClose.get(t - MIN), b = btcClose.get(t - 61 * MIN);
      return a && b ? (a / b - 1) * 100 : null;
    },
    market: btcMarket || undefined,
  };
  const cards = [], moves = [];
  let gaps = 0;
  for (let i = first; i < m1.length; i++) {
    if (i > first && m1[i].t - m1[i - 1].t > MIN) gaps++;
    if (s.moveAlertPct > 0) {                                 // canlıdaki ⚡ hareket uyarısıyla aynı ölçü
      const pv = m1[i - 1];
      const mp = eng.movePct(pv ? pv.c : null, pv ? pv.t : null, m1[i]);
      if (mp != null && Math.abs(mp) >= s.moveAlertPct) {
        let sum = 0, n = 0;
        for (let j = Math.max(0, i - 20); j < i; j++) { sum += m1[j].v; n++; }
        const volX = n >= 5 && sum > 0 ? m1[i].v / (sum / n) : null;
        const taker = m1[i].v > 0 ? m1[i].tb / m1[i].v * 100 : null;
        moves.push({ symbol, t: m1[i].t + MIN, movePct: +mp.toFixed(3), grade: eng.volGrade(mp, volX, taker, s), price: m1[i].c, fwd: forward(m1, i, m1[i].c) });
      }
    }
    now = m1[i].t + MIN;
    const closed = sr.apply1m(m1[i]);
    if (sr.ready()) touches.push(...touchTr.observe(sr, closed, s));
    let card = eng.step(sr, closed, s, tracker, ctx);
    if (card) { touchTr.noteCard(symbol, card.t); dropTr.noteCard(symbol, card.t, card.grade); }
    if (sr.ready()) drops.push(...dropTr.observe(sr, s, ctx));
    { // ⭐ v3 B kurulum kartı — canlı processCandle0 ile aynı sıra ve aynı fonksiyon (eng.setupCard)
      const setup = dropTr.takeSetup(symbol);
      if (setup) { const had = card; card = eng.setupCard(sr, s, tracker, ctx, setup, card); if (card && !had) { touchTr.noteCard(symbol, card.t); dropTr.noteCard(symbol, card.t, card.grade); } }
    }
    if (!card) continue;
    { const r = oiAt(card.t), oi = r ? oiChange1h(r) : null; if (oi != null) card.oi = { changePct: oi }; }   // canlı emitCard ile aynı
    card.fwd = forward(m1, i, card.price);
    if (keepCards) card.text = formatCard(card, s).text;
    cards.push(card);
  }
  return { symbol, cards, moves, touches, drops, minutes: m1.length - first, gaps, ...(hist.errors.length ? { note: `geçmiş alınamadı (${hist.errors.join('; ')})` } : {}) };
}

// ── Rapor ──────────────────────────────────────────────────────────────────

const { median, pctS, fmtDate, compact, CLASSES, classTable, nLabel, excluded60, excludedNote, load, touchText } = require('./infoStats');

function printReport(p, cards, perSym) {
  const days = (p.end - p.start) / DAY;
  const serie = cards.filter(c => c.seq === 1).length;
  const silent = cards.filter(c => c.silent).length;
  const L = load(cards);
  console.log('\n════════════════════════════════════════════');
  console.log('  BİLGİ BOTU BACKTEST — ÖZET');
  console.log('════════════════════════════════════════════');
  console.log(`Dönem        : ${fmtDate(p.start)} → ${fmtDate(p.end)} UTC (${days.toFixed(1)} gün) · ${p.symbols.length} coin`);
  console.log(`Kart         : ${cards.length} (günde ~${(cards.length / days).toFixed(1)}) · ${serie} seri (#1) · ${cards.length - silent} sesli / ${silent} sessiz`);
  console.log(`Kart üreten  : ${perSym.filter(x => x.n).length} coin`);
  console.log(`Telegram yükü: en yoğun dakika ${L.maxMin} kart · en yoğun saat ${L.maxHour} kart${L.peakHour ? ` (${L.peakHour.at})` : ''} · 20+/dk olan dakika: ${L.over20}`);
  console.log('\nKart sınıfları ve sonrasında fiyat (medyan, kart anındaki fiyata göre):');
  console.log('  Sınıf                   Kart   15dk en düşük   60dk en düşük   60dk en yüksek   60dk sonra');
  for (const r of classTable(cards)) {
    console.log(`  ${r.name.padEnd(22)} ${nLabel(r).padStart(5)}   ${pctS(r.low15).padStart(13)}   ${pctS(r.low60).padStart(13)}   ${pctS(r.high60).padStart(14)}   ${pctS(r.close60).padStart(10)}`);
  }
  if (excluded60(cards)) console.log(`  60dk sütunları:${excludedNote(excluded60(cards))}`);
  const top = perSym.filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 12);
  if (top.length) console.log(`\nEn çok kart: ${top.map(x => `${x.symbol} ${x.n}`).join(' · ')}`);
  console.log('\nNot: bu bir kazanç/kayıp testi değildir; "sonrasında fiyat" sütunları yalnızca kart sınıflarını kıyaslamak içindir.');
  console.log('     Evren dönem öncesi 24s hacme göre seçildi (listeden tamamen çıkmış coinler yok). Funding geçmişi kullanıldı; OI yalnız son 30 gün.');
}

function moveRows(moves) {
  return [['▲ yükseliş', moves.filter(m => m.movePct > 0)], ['▼ düşüş', moves.filter(m => m.movePct < 0)]].map(([k, a]) => {
    const f = a.filter(m => m.fwd?.[60]);
    return { k, n: a.length, close60: median(f.map(m => m.fwd[60].close)), low60: median(f.map(m => m.fwd[60].low)), high60: median(f.map(m => m.fwd[60].high)) };
  });
}

function printMoves(p, moves, s) {
  const days = (p.end - p.start) / DAY;
  console.log(`\n⚡ 1 dk hareket ≥ %${s.moveAlertPct} (yalnızca backtest listesindeki coinler): ${moves.length} (günde ~${(moves.length / days).toFixed(1)})`);
  for (const r of moveRows(moves)) console.log(`  ${r.k.padEnd(12)} ${String(r.n).padStart(5)} · 60dk sonra medyan ${pctS(r.close60)} (en düşük ${pctS(r.low60)} / en yüksek ${pctS(r.high60)})`);
  console.log(`  Derece: ${[1, 2, 3].map(g => `${'●'.repeat(g)} ${moves.filter(m => m.grade === g).length}`).join(' · ')}`);
  const L = load(moves);
  console.log(`  Yük: en yoğun dakika ${L.maxMin} · en yoğun saat ${L.maxHour} uyarı`);
}

function telegramSummary(p, cards, perSym, s, moves = []) {
  const days = (p.end - p.start) / DAY;
  const L = load(cards);
  const rows = classTable(cards).map(r => `${esc(r.name.trim())}: <b>${nLabel(r)}</b> · 60dk en düşük ${pctS(r.low60)} · en yüksek ${pctS(r.high60)}`);
  const exclNote = excludedNote(excluded60(cards));
  const top = perSym.filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 8).map(x => `${esc(x.symbol)} ${x.n}`).join(' · ');
  return `🧪 <b>Bilgi botu backtest</b>
${fmtDate(p.start)} → ${fmtDate(p.end)} UTC (${days.toFixed(0)} gün) · ${p.symbols.length} coin
Şart: RSI ≥ ${s.rsiMin} (${s.minTFs}/3)${s.levelRequired ? ` + seviye ≤ %${s.levelMaxPct}` : ''} · 🔴🔴 RSI ≥ ${s.rsiMin2} · RSI(${s.rsiPeriod})

Kart: <b>${cards.length}</b> (günde ~${(cards.length / days).toFixed(1)}) · ${cards.filter(c => c.seq === 1).length} seri · ${cards.filter(c => !c.silent).length} sesli
Yük: en yoğun dakika ${L.maxMin} · en yoğun saat ${L.maxHour} kart

<b>Sınıflar</b> (sonraki 60 dk, medyan)${exclNote}
${rows.join('\n')}
${top ? `\nEn çok kart: ${top}` : ''}
${s.moveAlertPct > 0 ? `\n<b>⚡ 1 dk ≥ %${s.moveAlertPct}</b>: ${moves.length}\n${moveRows(moves).map(r => `${r.k}: ${r.n} · 60dk sonra ${pctS(r.close60)}`).join('\n')}\n` : ''}<i>Kazanç/kayıp testi değildir.</i>`.slice(0, 4000);
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const r = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    r[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return r;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const DAYS = Number(a.days ?? 30);
  if (!(DAYS >= 1 && DAYS <= 365)) throw new Error(`Geçersiz --days: ${a.days}`);

  // --canli-ayar: canlı ayar dosyasını yalnızca OKU; backtest'teki --kanit / --ayar değişiklikleri
  // o dosyaya YAZILMAZ (canlı bot etkilenmez)
  let base = cfg.info;
  if (a['canli-ayar']) { const live = createSettings(); live.load(); base = { ...live.get() }; }
  const settings = createSettings({ persist: false, defaults: base });
  // Kanıt modu: yalnızca bu backtest çalışmasında eşikleri düşür (canlı bot / dosya etkilenmez)
  if (a.kanit) {
    for (const [k, v] of Object.entries(KANIT)) settings.set(k, v);
  }
  if (a.ayar) {
    for (const pair of String(a.ayar).split(',')) {
      const [k, v] = pair.split('=');
      const r = settings.set(k.trim(), v);
      if (!r.ok) throw new Error(`--ayar ${pair}: ${r.error}`);
    }
  }
  const s = { ...settings.get() };

  const end   = Math.floor(Date.now() / MIN) * MIN;
  const start = Math.floor((end - DAYS * DAY) / DAY) * DAY;
  let symbols, universe;
  if (a.symbol) {
    symbols = String(a.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean).map(x => (x.endsWith('USDT') ? x : x + 'USDT'));
    universe = '--symbol';
  } else {
    const minVol = Number(a['min-volume'] ?? s.minVolumeM * 1e6);
    const { getPeriodLiquidSymbols } = require('./binanceClient');
    // dönem başından önceki 24 saatin hacmi (bugünkü değil): aday başına 1 istek (weight 1)
    const r = await getPeriodLiquidSymbols({ minVolume24hUSDT: minVol, maxCoins: Number(a['max-coins'] ?? 0), excludeBaseAssets: cfg.autoFilter.excludeBaseAssets, tradfi: Boolean(s.tradfi), start });
    symbols = r.symbols;
    universe = `dönem öncesi 24s hacim ≥ ${(minVol / 1e6).toLocaleString()}M $${a['max-coins'] ? `, en likit ${a['max-coins']}` : ''}`;
    console.log(`Evren seçimi: ${r.stats.candidates} aday, ${r.stats.eligible} uygun (dönem başında listeli), ${r.stats.requests} REST isteği${r.stats.failed ? `, ${r.stats.failed} coin hacim alınamadığı için dışarıda` : ''}`);
  }
  if (!symbols.length) throw new Error('Sembol listesi boş');

  const p = { start, end, days: DAYS, symbols, universe, limits: LIMITS };

  console.log('\n════════════════════════════════════════════');
  console.log(`  Bilgi Botu — Backtest${a.kanit ? '  [KANIT MODU: RSI ≥ 70, sıfırlama 60]' : ''}`);
  console.log(`  Semboller : ${symbols.length} (${universe}) — ${symbols.slice(0, 10).join(', ')}${symbols.length > 10 ? ' …' : ''}`);
  console.log(`  Dönem     : ${fmtDate(start)} → ${fmtDate(end)} UTC`);
  console.log(`  Derece    : kontrol listesi skoru (8 madde) — 🔴 < ${s.grade2Min} · 🔴🔴 ≥ ${s.grade2Min} · 🔴🔴🔴 ≥ ${s.grade3Min} · RSI(${s.rsiPeriod})`);
  console.log(`  Şart      : 3m/5m/15m RSI ≥ ${s.rsiMin} (${s.minTFs}/3)${s.levelRequired ? ` + üstte ≤ %${s.levelMaxPct} seviye` : ''}${s.sepRequired ? ' + ayrışma' : ''}${s.confRequired ? ' + destek' : ''}${s.macdRequired ? ' + MACD' : ''}`);
  console.log(`  Hareket   : 1 dk ≥ %${s.moveAlertPct}${s.moveAlertPct > 0 ? '' : ' (kapalı)'}`);
  console.log(`  Patlama   : gövde ≥ %${s.burstPct1}/%${s.burstPct2} · hacim ≥ ${s.volMult}× (${s.volAvgN} mum) · taker >%${s.takerBuyPct} alım / <%${s.takerSellPct} satış`);
  console.log(`  Canlıdan eksik bağlam: ${LIMITS.join(' · ')}`);
  console.log(`  Süre      : coin başına ~${Math.ceil(DAYS * 1.44 * (REQ_DELAY_MS + 150) / 1000)} sn veri çekme (1m, ${Math.ceil(DAYS * 1440 / PAGE)} istek; funding ${Math.ceil((DAYS + 2) * 3 / 1000)}+ (8 saatlik) + OI ${Math.ceil((Math.min(DAYS, 30) * 288 + 13) / 500)} istek)`);
  console.log('════════════════════════════════════════════\n');

  // BTC 1h bağlamı için BTC 1m kapanışları
  console.log('BTC bağlamı yükleniyor...');
  const btc1m = await fetch1m('BTCUSDT', start - 61 * MIN, end);
  const btcClose = new Map(btc1m.map(c => [c.t, c.c]));
  const btcMarket = createBtcMarket(btc1m);

  const ORNEK = Number(a.ornek ?? 0);
  const all = [], perSym = [], allMoves = [], allTouches = [], allDrops = [];
  const t0 = Date.now();
  for (const [i, sym] of symbols.entries()) {
    const eta = i ? Math.round((Date.now() - t0) / i * (symbols.length - i) / 60000) : null;
    try {
      const r = await runSymbol(sym, { start, end, s, btcClose, btcMarket, keepCards: ORNEK > 0 || Boolean(a.telegram) });
      const cards = r.cards.map(c => ({ ...compact(c), text: c.text, setup: c.trig?.setup ? 1 : 0, setupS: c.setup?.S ?? null, setupPump: c.setup?.pumpPct ?? null, v3S: c.v3?.v3S ?? null }));
      all.push(...cards);
      allMoves.push(...(r.moves || []));
      allTouches.push(...(r.touches || []));
      allDrops.push(...(r.drops || []));
      perSym.push({ symbol: sym, n: cards.length, series: cards.filter(c => c.seq === 1).length, moves: (r.moves || []).length, minutes: r.minutes, gaps: r.gaps });
      console.log(`[${i + 1}/${symbols.length}] ${sym}: ${cards.length} kart (${cards.filter(c => c.seq === 1).length} seri)${s.moveAlertPct > 0 ? ` · ${(r.moves || []).length} hareket ≥%${s.moveAlertPct}` : ''}${r.touches ? ` · ${r.touches.length} seviye teması` : ''}${r.drops ? ` · ${r.drops.length} tepe adayı (${r.drops.filter(x => x.outcome === 'düştü').length} düştü)` : ''}${r.note ? ` — ${r.note}` : ''}${eta != null ? ` · kalan ~${eta} dk` : ''}`);
    } catch (err) {
      perSym.push({ symbol: sym, n: 0, error: String(err?.message || err) });
      console.error(`[${i + 1}/${symbols.length}] ${sym}: HATA — ${err?.message || err}`);
    }
  }
  all.sort((x, y) => x.t - y.t);

  printReport(p, all, perSym);
  if (s.moveAlertPct > 0) printMoves(p, allMoves, s);
  const touchMsg = touchText(allTouches, { title: `${DAYS} gün · ${symbols.length} coin · ${allTouches.length} temas (backtest)`, filter: typeof a['seviye-filtre'] === 'string' ? a['seviye-filtre'] : '', s });
  console.log('\n' + toPlain(touchMsg));
  const nDrop = allDrops.filter(r => r.outcome === 'düştü').length;
  const dropMsg = dropText(allDrops, { title: `${DAYS} gün · ${symbols.length} coin · ${nDrop} düşüş (backtest)`, s, E: { ...DROP_DEFAULTS, ...(cfg.events || {}) } });
  console.log('\n' + toPlain(dropMsg));
  const teyitMsg = teyitText(allDrops, { title: `${DAYS} gün · ${symbols.length} coin · ${allDrops.length} tepe adayı (backtest)`, E: { ...DROP_DEFAULTS, ...(cfg.events || {}) } });
  console.log('\n' + toPlain(teyitMsg));

  if (ORNEK > 0) {
    console.log(`\n── Örnek kartlar (son ${ORNEK}) ──`);
    for (const c of all.slice(-ORNEK)) console.log('\n' + toPlain(c.text));
  }

  const OUT = path.join(__dirname, '..', 'backtest-results');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `info-${new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify({ params: { ...p, settings: s }, classes: classTable(all), load: load(all), perSymbol: perSym, cards: all.map(({ text, ...c }) => c), moves: allMoves, touches: allTouches, drops: allDrops }, null, 1));
  console.log(`\n📁 Ayrıntılı sonuç: ${file}`);
  { const { toCsv, flatDrop, dropCols } = require('./eventLog');
    const csvFile = file.replace(/info-([^/]+)\.json$/, 'tepeler-$1.csv');
    fs.writeFileSync(csvFile, toCsv(allDrops.map(r => flatDrop(r)), dropCols()));
    console.log(`📁 Tepe defteri (CSV, ${allDrops.length} tepe adayı, ${nDrop} düştü): ${csvFile}`); }

  if (a.telegram) {
    const telegram = require('./telegram');       // komut dinleme başlatılmaz → canlı botla çakışmaz
    const live = createSettings(); live.load();    // canlı ayar dosyası yalnız okunur (backtest konusu)
    const thread = live.topic('backtest');
    telegram.sendText(telegramSummary(p, all, perSym, s, allMoves), null, thread);
    telegram.sendText(touchMsg, null, thread);
    telegram.sendText(dropMsg, null, thread);
    telegram.sendText(teyitMsg, null, thread);
    for (const c of all.filter(x => x.burst).slice(-1).concat(all.filter(x => !x.burst).slice(-1))) {
      const kb = [[
        { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(c.symbol)}.P` },
        { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(c.symbol)}` },
      ]];
      telegram.sendText(`🧪 <b>BACKTEST ÖRNEĞİ</b> (geçmiş veri)\n${c.text}`, kb, thread);
    }
    const ok = await telegram.flush(90_000);
    const st = telegram.takeStats();
    if (ok && st.failed === 0) console.log(`📨 Telegram: özet + örnekler gönderildi (${st.sent} mesaj)`);
    else { console.error(`❌ Telegram: gönderilemedi (gönderilen ${st.sent}, başarısız ${st.failed}, kuyrukta ${st.queued})`); process.exitCode = 2; }
  }
}

if (require.main === module) {
  main().catch(err => { console.error('[BACKTEST]', err?.stack || err); process.exit(1); });
}

module.exports = { runSymbol, createBtcMarket, createFundingAt, createOiAt, LIMITS, fetch1m, setKlineSource: src => { klineSource = src; } };
