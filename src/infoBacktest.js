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
 *   • Funding ve OI geçmişi kullanılmaz (kartlarda "—"); BTC 1h bağlamı geçmişten hesaplanır.
 *
 * Çalıştırma (Binance'e erişen yerde — Fly makinesinde):
 *   node src/infoBacktest.js                         # tüm evren (24s hacim ≥ ayar), son 30 gün
 *   node src/infoBacktest.js --days 7 --max-coins 50 # hızlı deneme
 *   node src/infoBacktest.js --symbol ETHUSDT,SOLUSDT --days 60 --ornek 5
 *   node src/infoBacktest.js --ayar rsiMin=95,minTFs=3,levelMaxPct=2   # ayar dene
 *   node src/infoBacktest.js --canli-ayar            # /data/info-settings.json'daki (Telegram'dan değiştirilmiş) ayarlarla
 *   --telegram → bitince özet + 2 örnek kart gruba gönderilir
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

const DAY = 86_400_000;
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

// ── Tek coin ───────────────────────────────────────────────────────────────

function forward(m1, i, price) {
  const r = {};
  for (const w of [15, 60]) {
    let lo = Infinity, hi = -Infinity, last = null;
    for (let j = i + 1; j <= i + w && j < m1.length; j++) { if (m1[j].l < lo) lo = m1[j].l; if (m1[j].h > hi) hi = m1[j].h; last = m1[j].c; }
    if (last == null) { r[w] = null; continue; }
    r[w] = { low: (lo - price) / price * 100, high: (hi - price) / price * 100, close: (last - price) / price * 100, full: i + w < m1.length };
  }
  return r;
}

async function runSymbol(symbol, { start, end, s, btcClose, keepCards }) {
  const sr = new Series(symbol);
  for (const tf of SEED_TFS) sr.seed(tf, await fetchBefore(symbol, tf, start, KEEP[tf]));
  const m1 = await fetch1m(symbol, start - KEEP['1m'] * MIN, end);
  const first = m1.findIndex(c => c.t >= start);
  if (first < 0) return { symbol, cards: [], minutes: 0, note: 'dönemde veri yok' };
  sr.seed('1m', m1.slice(0, first));

  const tracker = eng.createTracker();
  const ctx = {
    btc1h: t => {
      const a = btcClose.get(t - MIN), b = btcClose.get(t - 61 * MIN);
      return a && b ? (a / b - 1) * 100 : null;
    },
  };
  const cards = [], moves = [];
  let gaps = 0;
  for (let i = first; i < m1.length; i++) {
    if (i > first && m1[i].t - m1[i - 1].t > MIN) gaps++;
    if (s.moveAlertPct > 0) {                                 // canlıdaki ⚡ hareket uyarısıyla aynı ölçü
      const pv = m1[i - 1];
      const mp = eng.movePct(pv ? pv.c : null, pv ? pv.t : null, m1[i]);
      if (mp != null && Math.abs(mp) >= s.moveAlertPct) moves.push({ symbol, t: m1[i].t + MIN, movePct: +mp.toFixed(3), price: m1[i].c, fwd: forward(m1, i, m1[i].c) });
    }
    const closed = sr.apply1m(m1[i]);
    const card = eng.step(sr, closed, s, tracker, ctx);
    if (!card) continue;
    card.fwd = forward(m1, i, card.price);
    if (keepCards) card.text = formatCard(card, s).text;
    cards.push(card);
  }
  return { symbol, cards, moves, minutes: m1.length - first, gaps };
}

// ── Rapor ──────────────────────────────────────────────────────────────────

const { median, pctS, fmtDate, compact, CLASSES, classTable, load } = require('./infoStats');

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
    console.log(`  ${r.name.padEnd(22)} ${String(r.n).padStart(5)}   ${pctS(r.low15).padStart(13)}   ${pctS(r.low60).padStart(13)}   ${pctS(r.high60).padStart(14)}   ${pctS(r.close60).padStart(10)}`);
  }
  const top = perSym.filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 12);
  if (top.length) console.log(`\nEn çok kart: ${top.map(x => `${x.symbol} ${x.n}`).join(' · ')}`);
  console.log('\nNot: bu bir kazanç/kayıp testi değildir; "sonrasında fiyat" sütunları yalnızca kart sınıflarını kıyaslamak içindir.');
  console.log('     Evren BUGÜNKÜ hacme göre seçildi (dönem içinde listeden çıkan coinler yok). Funding/OI geçmişi kullanılmadı.');
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
  const L = load(moves);
  console.log(`  Yük: en yoğun dakika ${L.maxMin} · en yoğun saat ${L.maxHour} uyarı`);
}

function telegramSummary(p, cards, perSym, s, moves = []) {
  const days = (p.end - p.start) / DAY;
  const L = load(cards);
  const rows = classTable(cards).map(r => `${esc(r.name.trim())}: <b>${r.n}</b> · 60dk en düşük ${pctS(r.low60)} · en yüksek ${pctS(r.high60)}`);
  const top = perSym.filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 8).map(x => `${esc(x.symbol)} ${x.n}`).join(' · ');
  return `🧪 <b>Bilgi botu backtest</b>
${fmtDate(p.start)} → ${fmtDate(p.end)} UTC (${days.toFixed(0)} gün) · ${p.symbols.length} coin
Şart: RSI ≥ ${s.rsiMin} (${s.minTFs}/3)${s.levelRequired ? ` + seviye ≤ %${s.levelMaxPct}` : ''}

Kart: <b>${cards.length}</b> (günde ~${(cards.length / days).toFixed(1)}) · ${cards.filter(c => c.seq === 1).length} seri · ${cards.filter(c => !c.silent).length} sesli
Yük: en yoğun dakika ${L.maxMin} · en yoğun saat ${L.maxHour} kart

<b>Sınıflar</b> (sonraki 60 dk, medyan)
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

  const settings = createSettings({ persist: Boolean(a['canli-ayar']) });
  settings.load();
  if (a.ayar) {
    for (const pair of String(a.ayar).split(',')) {
      const [k, v] = pair.split('=');
      const r = settings.set(k.trim(), v);
      if (!r.ok) throw new Error(`--ayar ${pair}: ${r.error}`);
    }
  }
  const s = { ...settings.get() };

  let symbols, universe;
  if (a.symbol) {
    symbols = String(a.symbol).split(',').map(x => x.trim().toUpperCase()).filter(Boolean).map(x => (x.endsWith('USDT') ? x : x + 'USDT'));
    universe = '--symbol';
  } else {
    const minVol = Number(a['min-volume'] ?? s.minVolumeM * 1e6);
    const { getLiquidSymbols } = require('./binanceClient');
    symbols = await getLiquidSymbols({ minVolume24hUSDT: minVol, maxCoins: Number(a['max-coins'] ?? 0), excludeBaseAssets: cfg.autoFilter.excludeBaseAssets });
    universe = `24s hacim ≥ ${(minVol / 1e6).toLocaleString()}M $${a['max-coins'] ? `, en likit ${a['max-coins']}` : ''}`;
  }
  if (!symbols.length) throw new Error('Sembol listesi boş');

  const end   = Math.floor(Date.now() / MIN) * MIN;
  const start = Math.floor((end - DAYS * DAY) / DAY) * DAY;
  const p = { start, end, days: DAYS, symbols, universe };

  console.log('\n════════════════════════════════════════════');
  console.log('  Bilgi Botu — Backtest');
  console.log(`  Semboller : ${symbols.length} (${universe}) — ${symbols.slice(0, 10).join(', ')}${symbols.length > 10 ? ' …' : ''}`);
  console.log(`  Dönem     : ${fmtDate(start)} → ${fmtDate(end)} UTC`);
  console.log(`  Şart      : 3m/5m/15m RSI ≥ ${s.rsiMin} (${s.minTFs}/3)${s.levelRequired ? ` + üstte ≤ %${s.levelMaxPct} seviye` : ''}${s.sepRequired ? ' + ayrışma' : ''}${s.confRequired ? ' + destek' : ''}${s.macdRequired ? ' + MACD' : ''}`);
  console.log(`  Hareket   : 1 dk ≥ %${s.moveAlertPct}${s.moveAlertPct > 0 ? '' : ' (kapalı)'}`);
  console.log(`  Patlama   : gövde ≥ %${s.burstPct1}/%${s.burstPct2} · hacim ≥ ${s.volMult}× (${s.volAvgN} mum) · taker >%${s.takerBuyPct} alım / <%${s.takerSellPct} satış`);
  console.log(`  Süre      : coin başına ~${Math.ceil(DAYS * 1.44 * (REQ_DELAY_MS + 150) / 1000)} sn veri çekme (1m, ${Math.ceil(DAYS * 1440 / PAGE)} istek)`);
  console.log('════════════════════════════════════════════\n');

  // BTC 1h bağlamı için BTC 1m kapanışları
  console.log('BTC bağlamı yükleniyor...');
  const btc1m = await fetch1m('BTCUSDT', start - 61 * MIN, end);
  const btcClose = new Map(btc1m.map(c => [c.t, c.c]));

  const ORNEK = Number(a.ornek ?? 0);
  const all = [], perSym = [], allMoves = [];
  const t0 = Date.now();
  for (const [i, sym] of symbols.entries()) {
    const eta = i ? Math.round((Date.now() - t0) / i * (symbols.length - i) / 60000) : null;
    try {
      const r = await runSymbol(sym, { start, end, s, btcClose, keepCards: ORNEK > 0 || Boolean(a.telegram) });
      const cards = r.cards.map(c => ({ ...compact(c), text: c.text }));
      all.push(...cards);
      allMoves.push(...(r.moves || []));
      perSym.push({ symbol: sym, n: cards.length, series: cards.filter(c => c.seq === 1).length, moves: (r.moves || []).length, minutes: r.minutes, gaps: r.gaps });
      console.log(`[${i + 1}/${symbols.length}] ${sym}: ${cards.length} kart (${cards.filter(c => c.seq === 1).length} seri)${s.moveAlertPct > 0 ? ` · ${(r.moves || []).length} hareket ≥%${s.moveAlertPct}` : ''}${r.note ? ` — ${r.note}` : ''}${eta != null ? ` · kalan ~${eta} dk` : ''}`);
    } catch (err) {
      perSym.push({ symbol: sym, n: 0, error: String(err?.message || err) });
      console.error(`[${i + 1}/${symbols.length}] ${sym}: HATA — ${err?.message || err}`);
    }
  }
  all.sort((x, y) => x.t - y.t);

  printReport(p, all, perSym);
  if (s.moveAlertPct > 0) printMoves(p, allMoves, s);

  if (ORNEK > 0) {
    console.log(`\n── Örnek kartlar (son ${ORNEK}) ──`);
    for (const c of all.slice(-ORNEK)) console.log('\n' + toPlain(c.text));
  }

  const OUT = path.join(__dirname, '..', 'backtest-results');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `info-${new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify({ params: { ...p, settings: s }, classes: classTable(all), load: load(all), perSymbol: perSym, cards: all.map(({ text, ...c }) => c), moves: allMoves }, null, 1));
  console.log(`\n📁 Ayrıntılı sonuç: ${file}`);

  if (a.telegram) {
    const telegram = require('./telegram');       // komut dinleme başlatılmaz → canlı botla çakışmaz
    telegram.sendText(telegramSummary(p, all, perSym, s, allMoves));
    for (const c of all.filter(x => x.burst).slice(-1).concat(all.filter(x => !x.burst).slice(-1))) {
      const kb = [[
        { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(c.symbol)}.P` },
        { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(c.symbol)}` },
      ]];
      telegram.sendText(`🧪 <b>BACKTEST ÖRNEĞİ</b> — ${fmtDate(c.t)} UTC\n${c.text}`, kb);
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

module.exports = { runSymbol, fetch1m, setKlineSource: src => { klineSource = src; } };
