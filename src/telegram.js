'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db          = require('./db');
const { gradeEmoji } = require('./scorer');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Alert Gönderimi ────────────────────────────────────────────────────────

function bar(filled, total, maxWidth = 10) {
  const f = Math.round((filled / total) * maxWidth);
  return '█'.repeat(f) + '░'.repeat(maxWidth - f);
}

/**
 * @param {object} sig  - tam sinyal objesi
 * @param {object} breakdown - scorer.js breakdown
 */
async function sendSignalAlert(sig, breakdown) {
  const regime_icon = sig.regime === 'REVERSAL' ? '✅' : sig.regime === 'NEUTRAL' ? '❓' : '⚠️';
  const emc_line    = sig.hasEMC
    ? `\n⚡ <b>EMC</b> — Extreme Momentum Condition (15m RSI 95+)`
    : '';

  const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 <b>SHORT SİNYALİ</b>  |  Derece: <b>${sig.grade}</b>  [${sig.score}/100]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>$${sig.symbol}</b>
📍 Fiyat: <code>${sig.entryPrice}</code>
🔹 Rejim: <b>${sig.regime}</b> ${regime_icon}${emc_line}

📊 <b>RSI Analizi:</b>
  ⏱ 5m  → ${sig.rsi5m?.toFixed(1) ?? '—'}${sig.rsi5m >= 95 ? '  🔥' : sig.rsi5m >= 90 ? '  ✅' : ''}
  ⏱ 15m → ${sig.rsi15m?.toFixed(1) ?? '—'}${sig.rsi15m >= 95 ? '  🔥' : sig.rsi15m >= 90 ? '  ✅' : ''}
  ⏱ 1h  → ${sig.rsi1h?.toFixed(1) ?? '—'}  ✅
  ⏱ 4h  → ${sig.rsi4h?.toFixed(1) ?? '—'}  ✅

📐 EMA21 uzaklık: <b>${sig.ema21Distance?.toFixed(2)} × ATR</b>  ✅
${sig.dailyResistance ? `🧱 Günlük direnç: <code>${sig.dailyResistance}</code>` : ''}${sig.dailyEMA200 ? `  |  EMA200: <code>${sig.dailyEMA200}</code>` : ''}
📦 Volume: <b>${sig.volumeRatio?.toFixed(1)}×</b> ortalama
📈 CVD: ${sig.cvdDirection === 'NEGATIVE' ? 'Negatife dönüyor ✅' : sig.cvdDirection === 'POSITIVE' ? 'Pozitif ⚠️' : 'Nötr'}
${sig.oiDeltaPct !== null ? `📊 OI Delta: <b>${sig.oiDeltaPct > 0 ? '+' : ''}${sig.oiDeltaPct?.toFixed(2)}%</b>` : ''}

🎯 TP-A: <code>${sig.tpA}</code>
🎯 TP-B: <code>${sig.tpB}</code>

🧠 <b>Skor: ${sig.score}/100</b>
  RSI şiddeti    ${bar(breakdown.rsi,    25)}  ${breakdown.rsi}/25
  EMA21 uzaklık  ${bar(breakdown.ema21,  20)}  ${breakdown.ema21}/20
  Direnç         ${bar(breakdown.resist, 20)}  ${breakdown.resist}/20
  Volume + CVD   ${bar(breakdown.volume, 15)}  ${breakdown.volume}/15
  OI delta       ${bar(breakdown.oi,     10)}  ${breakdown.oi}/10
  Divergence     ${bar(breakdown.diverge,10)}  ${breakdown.diverge}/10
${breakdown.emcBonus > 0 ? `  ⚡ EMC bonus    +${breakdown.emcBonus}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' });
}

// ── Komut Handler'ları ─────────────────────────────────────────────────────

bot.onText(/\/signals/, async (msg) => {
  const signals = db.getRecentSignals(10);
  if (!signals.length) return bot.sendMessage(msg.chat.id, 'Henüz sinyal yok.');

  const lines = signals.map(s => {
    const icon = s.outcome === 'WIN' ? '✅' : s.outcome === 'LOSS' ? '❌' : '➖';
    const r    = s.rMultiple != null ? ` | R: ${s.rMultiple.toFixed(2)}` : '';
    return `${icon} <b>${s.symbol}</b> [${s.grade} ${s.score}] ${r}`;
  }).join('\n');

  bot.sendMessage(msg.chat.id, `<b>Son 10 Sinyal:</b>\n${lines}`, { parse_mode: 'HTML' });
});

bot.onText(/\/stats/, async (msg) => {
  const s = db.getStats();
  if (!s || !s.total) return bot.sendMessage(msg.chat.id, 'Henüz çözümlenmiş sinyal yok.');

  const winRate = s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : 0;
  const text = `
📊 <b>Genel İstatistik</b>
Toplam: ${s.total}
✅ Win: ${s.wins} | ❌ Loss: ${s.losses} | ➖ Nötr: ${s.neutrals}
Win rate: <b>${winRate}%</b>
Ort. R: <b>${s.avgR ?? '—'}</b>
Ort. MFE: ${s.avgMFE ?? '—'}%
Ort. MAE: ${s.avgMAE ?? '—'}%
  `.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/winrate/, async (msg) => {
  const rows = db.getWinrateByGrade();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Henüz veri yok.');

  const lines = rows.map(r =>
    `<b>${r.grade}</b>: ${r.winPct}% win | ${r.total} sinyal | Ort R: ${r.avgR ?? '—'}`
  ).join('\n');

  bot.sendMessage(msg.chat.id, `📈 <b>Dereceye Göre Win Rate:</b>\n${lines}`, { parse_mode: 'HTML' });
});

bot.onText(/\/regime/, async (msg) => {
  const rows = db.getWinrateByRegime();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Henüz veri yok.');

  const lines = rows.map(r =>
    `<b>${r.regime}</b>: ${r.winPct}% win | ${r.total} sinyal | Ort R: ${r.avgR ?? '—'}`
  ).join('\n');

  bot.sendMessage(msg.chat.id, `🔍 <b>Rejime Göre Win Rate:</b>\n${lines}`, { parse_mode: 'HTML' });
});

bot.onText(/\/emc/, async (msg) => {
  const rows = db.getEMCStats();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Henüz veri yok.');

  const withEMC    = rows.find(r => r.hasEMC === 1);
  const withoutEMC = rows.find(r => r.hasEMC === 0);

  const text = `
⚡ <b>EMC (Extreme Momentum Condition) Analizi</b>
EMC Var:  ${withEMC ? `${withEMC.winPct}% win | ${withEMC.total} sinyal` : '—'}
EMC Yok:  ${withoutEMC ? `${withoutEMC.winPct}% win | ${withoutEMC.total} sinyal` : '—'}
  `.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/best/, async (msg) => {
  const rows = db.getBestSymbols();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Henüz yeterli veri yok.');

  const lines = rows.map((r, i) => `${i+1}. <b>${r.symbol}</b>: ${r.winPct}% (${r.total} sinyal)`).join('\n');
  bot.sendMessage(msg.chat.id, `🏆 <b>En Başarılı Coinler:</b>\n${lines}`, { parse_mode: 'HTML' });
});

bot.onText(/\/worst/, async (msg) => {
  const rows = db.getWorstSymbols();
  if (!rows.length) return bot.sendMessage(msg.chat.id, 'Henüz yeterli veri yok.');

  const lines = rows.map((r, i) => `${i+1}. <b>${r.symbol}</b>: ${r.winPct}% (${r.total} sinyal)`).join('\n');
  bot.sendMessage(msg.chat.id, `⚠️ <b>En Başarısız Coinler:</b>\n${lines}`, { parse_mode: 'HTML' });
});

bot.onText(/\/report/, async (msg) => {
  const s    = db.getStats();
  const rows = db.getWinrateByGrade();
  if (!s || !s.total) return bot.sendMessage(msg.chat.id, 'Henüz veri yok.');

  const winRate  = ((s.wins / s.total) * 100).toFixed(1);
  const gradeStr = rows.map(r => `  ${r.grade}: ${r.winPct}% (${r.total})`).join('\n');

  const text = `
📋 <b>Performans Raporu</b>

Toplam sinyal: ${s.total}
Win rate: <b>${winRate}%</b>
Ort. R-multiple: <b>${s.avgR ?? '—'}</b>

<b>Dereceye göre:</b>
${gradeStr}
  `.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, async (msg) => {
  const text = `
<b>Scalp Sinyal Motoru — Komutlar</b>

/signals  — Son 10 sinyal
/stats    — Genel istatistik
/winrate  — Dereceye göre win rate
/regime   — Rejime göre win rate
/emc      — EMC analizi
/best     — En başarılı coinler
/worst    — En başarısız coinler
/report   — Performans raporu
  `.trim();
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

module.exports = { bot, sendSignalAlert };
