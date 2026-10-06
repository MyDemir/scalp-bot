'use strict';

/**
 * Bilgi botunun Telegram komutları ve buton işleyicileri.
 */

const { formatCard, summaryText, esc, px, pct, dayTime } = require('./infoCard');
const { evaluate, circles } = require('./infoEngine');
const { classTable, median, touchText } = require('./infoStats');
const { rowToStat } = require('./cardStore');
const { dropText } = require('./eventLog');
const { buildExports } = require('./exportData');
const { buildWeekly } = require('./weeklyReport');
const cfgAll = require('./config');

const HOUR = 3_600_000;

const TOPICS = {
  kart:     'RSI kartları (tümü)',
  kart3:    '🔴🔴🔴 ve 🔴🔴🔴🔴 kartlar (ayrıca bu konuya; boşsa "kart" konusuna)',
  sistem:   'bot mesajları ("hazır" vb.)',
  backtest: 'backtest raporları (--telegram)',
  rapor:    'haftalık istatistik dosyaları (Pazartesi 03:01; boşsa "sistem" konusuna)',
};

function normSym(x) {
  const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9一-鿿]/g, '');
  if (!s) return null;
  return s.endsWith('USDT') ? s : s + 'USDT';
}

function installInfoTelegram({ telegram, settings, tracker, store = null, details = null, getSeries, ctx, status, chartFor = null }) {
  const defs = settings.defs;

  const DEF = Object.fromEntries(defs.map(d => [d.key, d]));
  const SECTIONS = [
    { id: 'rsi', title: '📊 RSI kartı', keys: ['rsiMin', 'rsiMin2', 'strongRsi', 'rsiEntryMax', 'minTFs', 'rsiPeriod', 'resetRsi', 'seriesBursts', 'seriesMinRsi5m'],
      sum: v => `eşik ${v.rsiMin} · ${v.minTFs}/3 dilim · RSI(${v.rsiPeriod}) · seri 5m≥${v.seriesMinRsi5m ?? 85}` },
    { id: 'lvl', title: '🎯 Direnç ve kırılım', keys: ['levelRequired', 'levelMaxPct', 'dipBelowPct', 'dipAbovePct', 'sfpAbovePct', 'confluencePct', 'levelsSwing', 'swingBars', 'zoneTouches', 'levelsFib', 'levelsWeeklyZone', 'sfpCards', 'sfpBars', 'discoveryCards'],
      sum: v => `${v.levelRequired ? 'şart açık' : 'şart kapalı'} · %${v.levelMaxPct} içinde · haftalık bölge ${v.levelsWeeklyZone ? 'açık' : 'kapalı'} · SFP ${v.sfpCards ? 'açık' : 'kapalı'}` },
    { id: 'grd', title: '🏅 Derece ve kontrol listesi', keys: ['grade2Min', 'grade3Min', 'grade4Min', 'sepPct2', 'sepPct5', 'sepPct10', 'confRsi', 'sepATR', 'sepRequired', 'confRequired', 'macdRequired'],
      sum: v => `🔴🔴≥${v.grade2Min} · 🔴🔴🔴≥${v.grade3Min} · 🔴🔴🔴🔴≥${v.grade4Min ?? 7} (9 madde)` },
    { id: 'vol', title: '📦 Hacimli mum', keys: ['burstPct1', 'burstPct2', 'volMult', 'volAvgN', 'takerBuyPct', 'takerSellPct', 'volGrade2X', 'dirGrade3Pct', 'windowMin', 'shortWindowMin'],
      sum: v => `gövde ≥ %${v.burstPct1} · hacim ≥ ${v.volMult}×` },
    { id: 'mov', title: '⚡ Hareket', keys: ['moveAlertPct'],
      sum: v => (v.moveAlertPct > 0 ? `1 dk ≥ %${v.moveAlertPct} → RSI kartına eklenir` : 'kapalı') },
    { id: 'snd', title: '🔔 Bildirim', keys: ['cardSound'],
      sum: v => `kart ${v.cardSound ? 'sesli' : 'sessiz'}` },
    { id: 'cht', title: '🖼 Grafik', keys: ['chart', 'chartTf', 'chartFib', 'chartIchi', 'chartMinTouches'],
      sum: v => (v.chart ? `${v.chartTf}${v.chartIchi ? ' · Ichimoku' : ''}${v.chartFib ? ' · Fibonacci' : ''}` : 'kapalı') },
    { id: 'uni', title: '🌐 İzlenen coinler', keys: ['minVolumeM'],
      sum: v => `24s hacim ≥ ${v.minVolumeM}M $` },
  ];
  {
    const used = new Set(SECTIONS.flatMap(x => x.keys));
    const rest = defs.filter(d => d.menu !== false && !used.has(d.key)).map(d => d.key);
    if (rest.length) SECTIONS.push({ id: 'etc', title: '🧩 Diğer', keys: rest, sum: () => `${rest.length} ayar` });
  }
  const SEC = Object.fromEntries(SECTIONS.map(x => [x.id, x]));
  const secOf = key => SECTIONS.find(x => x.keys.includes(key));
  const val = (d, v) => (d.type === 'bool' ? (v ? 'açık' : 'kapalı') : String(v));
  const num = x => String(+x.toFixed(4));
  const pairs = btns => { const kb = []; for (let i = 0; i < btns.length; i += 2) kb.push(btns.slice(i, i + 2)); return kb; };
  const ADMIN_NOTE = '<i>Değiştirmek yalnızca yöneticilere açık. Değişiklik anında geçerli ve kalıcı.</i>';

  function menu() {
    const v = settings.get();
    const text = `⚙️ <b>Bilgi botu ayarları</b>\n\n${SECTIONS.map(x => `<b>${x.title}</b>\n${esc(x.sum(v))}`).join('\n\n')}\n\n${ADMIN_NOTE}`;
    return { text, keyboard: pairs(SECTIONS.map(x => ({ text: x.title, callback_data: `g:${x.id}` }))) };
  }

  function sectionMenu(id) {
    const x = SEC[id];
    if (!x) return menu();
    const v = settings.get();
    const lines = x.keys.map(k => `• ${esc(DEF[k].label)}: <b>${esc(val(DEF[k], v[k]))}</b>`);
    let extra = '';
    if (id === 'cht') extra = `\n\nIchimoku: ${v.ichiTenkan}/${v.ichiKijun}/${v.ichiChikou}/${v.ichiSenkouB}/${v.ichiShift} — değiştirmek için <code>/ayar ichiTenkan 9</code> gibi`;
    const text = `⚙️ <b>${x.title}</b>\n\n${lines.join('\n')}${extra}\n\nDeğiştirmek istediğin ayara dokun.\n${ADMIN_NOTE}`;
    const btns = x.keys.map(k => {
      const d = DEF[k];
      return d.type === 'bool'
        ? { text: `${v[k] ? '✅' : '▫️'} ${d.short}`, callback_data: `t:${k}` }
        : { text: `${d.short}: ${v[k]}`, callback_data: `e:${k}` };
    });
    return { text, keyboard: [...pairs(btns), [{ text: '↩️ Ayarlar', callback_data: 'g:main' }]] };
  }

  function editMenu(key) {
    const d = DEF[key];
    if (!d || d.type === 'bool') return sectionMenu(secOf(key)?.id);
    const x = secOf(key);
    const v = settings.get()[key], def = settings.defaults()[key];
    const back = [{ text: `↺ Varsayılan (${def})`, callback_data: `d:${key}` }, { text: `↩️ ${x ? x.title : 'Ayarlar'}`, callback_data: x ? `g:${x.id}` : 'g:main' }];
    if (d.type === 'enum') {
      const text = `⚙️ ${x ? `${x.title} › ` : ''}<b>${esc(d.label)}</b>\n\nŞu an: <b>${esc(v)}</b> · varsayılan ${esc(def)}\n\n${ADMIN_NOTE}`;
      return { text, keyboard: [d.options.map(o => ({ text: o === v ? `✓ ${o}` : o, callback_data: `v:${key}:${o}` })), back] };
    }
    const text = `⚙️ ${x ? `${x.title} › ` : ''}<b>${esc(d.label)}</b>\n\nŞu an: <b>${v}</b> · varsayılan ${def} · aralık ${d.min}–${d.max}\n\n${ADMIN_NOTE}`;
    const st = d.step;
    return { text, keyboard: [[
      { text: `−${num(5 * st)}`, callback_data: `s:${key}:-5` },
      { text: `−${num(st)}`, callback_data: `s:${key}:-1` },
      { text: `+${num(st)}`, callback_data: `s:${key}:1` },
      { text: `+${num(5 * st)}`, callback_data: `s:${key}:5` },
    ], back] };
  }

  const show = async (cq, m) => { await telegram.editMessage(cq.message.chat.id, cq.message.message_id, m.text, m.keyboard); };

  const denied = { text: 'Bu işlem için grup yöneticisi olmalısın.', alert: true };
  const detailSent = new Map();
  function detailFor(id) {
    const html = details ? details.get(id) : null;
    if (!html) return null;
    const sym = id.split('-')[0];
    const sr = getSeries(sym);
    return `${html}\n\n<i>${esc(summaryText(sym, tracker.log(sym), sr ? sr.price() : null))}</i>`;
  }

  if (telegram.onPrivateStart) {
    telegram.onPrivateStart(async (param, msg) => {
      if (!(await telegram.isMember(msg.from?.id))) return 'Bu bot yalnızca grup üyeleri içindir.';
      if (!param.startsWith('d_')) return 'Merhaba! Gruptaki kartlarda <b>📋 Detay</b> butonuna bastığında ayrıntılar buraya, yalnızca sana gelir.';
      return detailFor(param.slice(2)) || 'Bu kartın ayrıntıları artık yok (bot yeniden başladı).';
    });
  }

  async function onCallback(cq) {
    const data = String(cq.data || '');
    const uid = cq.from?.id;
    if (data === 'n') return null;

    const [kind, a, b] = data.split(':');
    if (kind === 'd') {
      const id = data.slice(2);
      const html = detailFor(id);
      if (!html) return { text: 'Bu kartın ayrıntıları artık yok (bot yeniden başladı).', alert: true };
      const key = `${uid}:${id}`, last = detailSent.get(key) || 0;
      if (Date.now() - last < 10_000) return { text: '📋 Detay az önce özel mesajla gönderildi.' };
      if (await telegram.sendPrivate(uid, html)) {
        detailSent.set(key, Date.now());
        if (detailSent.size > 1000) detailSent.delete(detailSent.keys().next().value);
        return { text: '📋 Detay özel mesajla gönderildi.' };
      }
      const bot = telegram.getBotUsername ? telegram.getBotUsername() : null;
      if (!bot) return { text: 'Önce botla özel sohbeti başlat (bota /start yaz), sonra tekrar bas.', alert: true };
      return { url: `https://t.me/${bot}?start=d_${id}` };
    }
    if (kind === 'o') {
      const sr = getSeries(a);
      return { text: summaryText(a, tracker.log(a), sr ? sr.price() : null), alert: true };
    }
    if (kind === 'g') { await show(cq, a === 'main' ? menu() : sectionMenu(a)); return null; }
    if (kind === 'e') { await show(cq, editMenu(a)); return null; }
    if (!(await telegram.isAdmin(uid))) return denied;

    if (kind === 'm') {
      settings.mute(a, HOUR);
      console.log(`[AYAR] ${a} 1 saat susturuldu (kullanıcı ${uid})`);
      return { text: `🔕 ${a} 1 saat susturuldu. Açmak için: /ac ${a.replace(/USDT$/, '')}` };
    }
    if (kind === 'f') {
      const on = settings.toggleFollow(a);
      return { text: on ? `⭐ ${a} takipte — kartları her zaman sesli gelir.` : `☆ ${a} takipten çıkarıldı.` };
    }
    if (kind === 's' || kind === 't' || kind === 'd' || kind === 'v') {
      const r = kind === 's' ? settings.bump(a, Number(b))
        : kind === 't' ? settings.bump(a, 0)
          : kind === 'd' ? settings.set(a, settings.defaults()[a])
            : settings.set(a, b);
      if (!r.ok) return { text: r.error, alert: true };
      console.log(`[AYAR] ${a} = ${r.value} (kullanıcı ${uid})`);
      await show(cq, kind === 't' ? sectionMenu(secOf(a)?.id) : editMenu(a));
      return { text: `${DEF[a]?.short || a}: ${val(DEF[a] || {}, r.value)}` };
    }
    return null;
  }

  const adminOnly = fn => async (args, msg) => ((await telegram.isAdmin(msg.from?.id)) ? fn(args, msg) : 'Bu komut için grup yöneticisi olmalısın.');

  const help = () => `
<b>Bilgi Botu — Komutlar</b>

/ayarlar — ayarları gör / butonlarla değiştir
/ayar anahtar değer — tek ayarı değiştir (ör. <code>/ayar rsiMin 95</code>) · <code>/ayar sifirla</code>
/coin ETH — coinin anlık durumu (şart aranmaz)
/sustur ETH [dk] — coini sustur (varsayılan 60 dk) · /ac ETH
/sessiz — susturulanlar
/takip [ETH] — takip listesi / ekle-çıkar (takip edilenlerin kartları sesli gelir)
/gecmis ETH [adet] — coinin son kartları ve sonrasında fiyat
/istatistik [gün] — kart sınıfları ve sonrasında fiyat (varsayılan 7 gün)
/seviye [gün] [ad] — dirence alttan temastan sonraki 60 dk: geri çekilme, 3dk EMA21'e dönüş, kırılım (ör. <code>/seviye 7 fib</code>)
/kacan [gün] — düşüş defteri: pompa tepesinden düşüşler, kartlı/kartsız, kartsızlarda eksik şart
/disaaktar [gün] — (yönetici) istatistik verisi CSV olarak özelden: düşüşler, kartlar, temaslar
/haftalik — (yönetici) haftalık dosyanın ön izlemesi özelden (silmez). Asıl dosya her Pazartesi 03:01'de gruba gider ve veritabanı temizlenir
/konu [ad] — konulu grupta yönlendirme (konunun içinde yaz: /konu kart · /konu sistem · /konu kart3 · /konu backtest · /konu rapor)
/durum — bot durumu
/benkimim — Telegram kullanıcı ID'n

<b>Derece daireleri</b>
Kart: kurulum kontrol listesi skoru (9 madde: günlük/haftalık direnç, çakışan direnç, 3m/5m RSI ${settings.get().strongRsi}–${settings.get().rsiEntryMax}, 15m ≥ ${settings.get().strongRsi}, 5m+15m ≥ ${settings.get().strongRsi}, 1h/4h ≥ ${settings.get().confRsi}, kademeli EMA21 ayrışma, ≥2 negatif tepe, MACD 3m/5m sat kesişimi) — 🔴 &lt; ${settings.get().grade2Min} · 🔴🔴 ≥ ${settings.get().grade2Min} · 🔴🔴🔴 ≥ ${settings.get().grade3Min} · 🔴🔴🔴🔴 ≥ ${settings.get().grade4Min ?? 7} (sesli)
Hacimli mum / ⚡: 1 daire temel · 2 daire hacim ≥ ${settings.get().volGrade2X}× · 3 daire + yön uyumu ≥ %${settings.get().dirGrade3Pct} — 🟢 alış/yükseliş · 🔴 satış/düşüş · ⚪ nötr
RSI periyodu: ${settings.get().rsiPeriod}

Kart ne zaman gelir: 3m/5m/15m'den en az <b>${settings.get().minTFs}</b> tanesinde RSI ≥ <b>${settings.get().rsiMin}</b>${settings.get().levelRequired ? ` ve fiyatın üstünde en fazla <b>%${settings.get().levelMaxPct}</b> uzakta bir seviye (4h/1d MA200 · EMA200 · 30 günlük tepe)` : ''}. Kontrol: 3m/5m/15m kapanışları + hacimli her 1m mum. Önceki karttan bu yana yeni veri yoksa kart gitmez.${settings.get().seriesBursts ? ' Seri sürerken (5m RSI ' + (settings.get().seriesMinRsi5m ?? 85) + ' üzerinde) gelen hacimli mumlar şart aranmadan kart olur (#SERI).' : ''}${settings.get().moveAlertPct > 0 ? `\n\n⚡ İzlenen coinde 1 dakikada ≥ %${settings.get().moveAlertPct} fiyat değişimi: RSI şartı sağlanıyorsa RSI kartına eklenir; bugünkü ▲/▼ sayısı 📋 Detay'da.` : ''}`.trim();

  const commands = {
    help, yardim: help, start: help,

    ayarlar: () => menu(),

    ayar: adminOnly((args) => {
      const [k, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!k) return 'Kullanım: <code>/ayar anahtar değer</code> — anahtarlar /ayarlar listesinde (ör. rsiMin, minTFs, levelMaxPct).';
      if (['sifirla', 'sıfırla', 'reset'].includes(k.toLowerCase())) { settings.reset(); return '↩️ Tüm ayarlar varsayılana döndü.'; }
      const d = defs.find(x => x.key.toLowerCase() === k.toLowerCase());
      if (!d) return `Bilinmeyen ayar: <code>${esc(k)}</code>. Liste: ${defs.map(x => x.key).join(', ')}`;
      const r = settings.set(d.key, rest.join(' '));
      return r.ok ? `✅ ${esc(d.label)} = <b>${r.value}</b>` : `❌ ${esc(r.error)}`;
    }),

    coin: (args) => {
      const sym = normSym(args);
      if (!sym) return 'Kullanım: /coin ETH';
      const sr = getSeries(sym);
      if (!sr) return `${esc(sym)} izlenmiyor (hacim filtresi dışında ya da yok).`;
      if (!sr.ready()) return `${esc(sym)} için veri henüz hazır değil.`;
      const s = settings.get();
      const snap = evaluate(sr, s, ctx(), true);
      const card = {
        id: `${sym}-${snap.t}-coin`, symbol: sym, seq: '–', t: snap.t, price: snap.price, snap,
        news: [`Anlık durum (kart değil) · şart: ${snap.ok ? 'sağlanıyor ✅' : `sağlanmıyor (${snap.fails.join(', ')})`}`],
        tags: [`#${sym}`], followed: settings.isFollowed(sym),
      };
      const out = formatCard(card, s, { now: Date.now() });
      details?.set(card.id, out.details);
      const photo = chartFor ? chartFor(sym, snap.level, snap.levels || []) : null;
      return photo ? { ...out, photo } : out;
    },

    sustur: adminOnly((args) => {
      const [x, m] = args.split(/\s+/);
      const sym = normSym(x);
      if (!sym) return 'Kullanım: /sustur ETH [dakika]';
      const min = Math.max(1, Math.min(7 * 1440, Number(m) || 60));
      settings.mute(sym, min * 60_000);
      return `🔕 ${esc(sym)} ${min} dk susturuldu.`;
    }),

    ac: adminOnly((args) => {
      const sym = normSym(args);
      if (!sym) return 'Kullanım: /ac ETH';
      settings.unmute(sym);
      return `🔔 ${esc(sym)} susturması kaldırıldı.`;
    }),

    sessiz: () => {
      const l = settings.mutedList();
      if (!l.length) return 'Susturulan coin yok.';
      return '🔕 <b>Susturulanlar</b>\n' + l.map(([s, u]) => `${esc(s)} — ${Math.ceil((u - Date.now()) / 60000)} dk kaldı`).join('\n');
    },

    takip: async (args, msg) => {
      const sym = normSym(args);
      if (!sym) {
        const l = settings.followList();
        return l.length ? '⭐ <b>Takip</b>\n' + l.map(esc).join('\n') : 'Takip listesi boş. Eklemek için: /takip ETH';
      }
      if (!(await telegram.isAdmin(msg.from?.id))) return 'Bu komut için grup yöneticisi olmalısın.';
      return settings.toggleFollow(sym) ? `⭐ ${esc(sym)} takibe alındı.` : `☆ ${esc(sym)} takipten çıkarıldı.`;
    },

    gecmis: (args) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const [x, nArg] = args.split(/\s+/);
      const sym = normSym(x);
      if (!sym) return 'Kullanım: /gecmis ETH [adet]';
      const n = Math.max(1, Math.min(30, Number(nArg) || 10));
      const rows = store.recent(sym, n).map(rowToStat);
      if (!rows.length) return `${esc(sym)} için kayıtlı kart yok.`;
      const lines = rows.map(r => {
        const w = r.fwd[60] ? `60dk: ${pct(r.fwd[60].low, 1)} / ${pct(r.fwd[60].high, 1)} · sonra ${pct(r.fwd[60].close, 1)}` : r.partial ? '60dk: eksik (yeniden başlatma)' : '60dk: bekleniyor';
        if (r.kind === 'move') return `${dayTime(r.t)} ⚡${circles(r.grade || 1, r.movePct > 0 ? 'green' : 'red')} ${pct(r.movePct)} → ${w}`;
        const cls = [`RSI ${r.hits}/3`, r.level?.zone === 'dip' ? 'dirençte' : r.level ? 'yaklaşıyor' : null, r.burst ? `${r.burst.dir === 'sell' ? '▼' : r.burst.dir === 'buy' ? '▲' : '◆'}patlama` : null, r.inSeries ? 'seri içi' : null].filter(Boolean).join(' · ');
        return `${dayTime(r.t)} ${r.grade != null ? circles(r.grade) + ' ' : ''}#${r.seq} ${cls} → ${w}`;
      });
      return `🗂 <b>${esc(sym)}</b> — son ${rows.length} kayıt (fiyat değişimi karttaki fiyata göre: en düşük / en yüksek · 60 dk sonra)\n${lines.join('\n')}`;
    },

    istatistik: (args) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(90, Number(args) || 7));
      const rows = store.since(Date.now() - days * 86_400_000).map(rowToStat);
      const cards = rows.filter(r => r.kind === 'card'), moves = rows.filter(r => r.kind === 'move');
      if (!rows.length) return `Son ${days} günde kayıt yok.`;
      const cls = classTable(cards).filter(r => r.n > 0).map(r =>
        `${esc(r.name.trim())}: <b>${r.n}</b> · 60dk en düşük ${pct(r.low60)} · en yüksek ${pct(r.high60)} · sonra ${pct(r.close60)}`);
      const mv = [['▲ yükseliş', moves.filter(m => m.movePct > 0)], ['▼ düşüş', moves.filter(m => m.movePct < 0)]].map(([k, a]) => {
        const f = a.filter(m => m.fwd[60]);
        return `${k}: <b>${a.length}</b> · 60dk sonra medyan ${pct(median(f.map(m => m.fwd[60].close)))} (en düşük ${pct(median(f.map(m => m.fwd[60].low)))} / en yüksek ${pct(median(f.map(m => m.fwd[60].high)))})`;
      });
      const pending = cards.filter(c => !c.fwd[60]).length;
      return `📊 <b>Son ${days} gün</b> · ${cards.length} kart
<i>Karttan sonraki 60 dk'da fiyat, kart anındaki fiyata göre (medyan). Kazanç/kayıp değildir.${pending ? ` 60 dk'sı dolmamış ${pending} kart hariç.` : ''}</i>

<b>Kart sınıfları</b>
${cls.join('\n') || '—'}${moves.length ? `

<b>⚡ Eski 1 dk hareket uyarıları</b> (artık ayrı kart yok)
${mv.join('\n')}` : ''}`.slice(0, 4000);
    },

    seviye: (args) => {
      if (!store || !store.enabled() || !store.touchesSince) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const parts = args.split(/\s+/).filter(Boolean);
      const dIdx = parts.findIndex(x => /^\d+$/.test(x));
      const days = Math.max(1, Math.min(60, dIdx >= 0 ? Number(parts.splice(dIdx, 1)[0]) : 7));
      const rows = store.touchesSince(Date.now() - days * 86_400_000);
      return touchText(rows, { title: `son ${days} gün · ${rows.length} temas`, filter: parts.join(' '), s: settings.get() });
    },

    kacan: (args) => {
      if (!store || !store.enabled() || !store.eventsSince) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(60, Number(String(args).trim()) || 7));
      const rows = store.eventsSince(Date.now() - days * 86_400_000);
      return dropText(rows, { title: `son ${days} gün · ${rows.length} düşüş`, s: settings.get(), E: { ...require('./eventLog').DEFAULTS, ...(cfgAll.events || {}) } });
    },

    disaaktar: adminOnly(async (args, msg) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(90, Number(String(args).trim()) || 30));
      const uid = msg.from?.id;
      const files = buildExports(store, days);
      let sent = 0;
      for (const f of files) {
        const ok = await telegram.sendDocumentPrivate(uid, f.name, Buffer.from(f.csv, 'utf8'), `${f.name} · son ${days} gün · ${f.n} satır`);
        if (!ok) {
          const bot = telegram.getBotUsername?.();
          return `❌ Özelden gönderemedim. Önce bota özelden bir kez /start yaz${bot ? `: https://t.me/${bot}` : ''} — sonra tekrar /disaaktar.`;
        }
        sent++;
      }
      return `📤 ${sent} dosya özelden gönderildi (son ${days} gün): ${files.map(f => `${f.name} ${f.n}`).join(' · ')}`;
    }),

    haftalik: adminOnly(async (args, msg) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const w = buildWeekly(store, { s: settings.get(), E: { ...require('./eventLog').DEFAULTS, ...(cfgAll.events || {}) } });
      for (const [k, f] of w.files.entries()) {
        const ok = await telegram.sendDocumentPrivate(msg.from?.id, f.name, f.buf, k === 0 ? `📦 Ön izleme · ${w.label} · ${w.counts.cards} kart · ${w.counts.drops} düşüş · ${w.counts.touches} temas (silinmedi)` : null, f.type);
        if (!ok) { const bot = telegram.getBotUsername?.(); return `❌ Özelden gönderemedim. Önce bota özelden bir kez /start yaz${bot ? `: https://t.me/${bot}` : ''}.`; }
      }
      return `📦 Haftalık ön izleme özelden gönderildi (${w.files.length} dosya). Asıl rapor Pazartesi 03:01'de gruba gider, ardından veritabanı temizlenir.`;
    }),

    konu: async (args, msg) => {
      const [a0, a1] = args.split(/\s+/).filter(Boolean).map(x => x.toLowerCase());
      const list = () => {
        const t = settings.topics();
        return '🧵 <b>Konu yönlendirme</b>\n' + Object.entries(TOPICS).map(([k, d]) => `• <b>${k}</b> — ${d}: ${t[k] ? `konu #${t[k]}` : '<i>genel akış</i>'}`).join('\n') +
          '\n\nBağlamak için ilgili konunun içinde yaz: <code>/konu kart</code> · kaldırmak: <code>/konu sil kart</code>';
      };
      if (!a0) return list();
      if (!(await telegram.isAdmin(msg.from?.id))) return 'Bu komut için grup yöneticisi olmalısın.';
      if (a0 === 'sil') {
        if (!TOPICS[a1]) return `Bilinmeyen konu adı. Seçenekler: ${Object.keys(TOPICS).join(', ')}`;
        settings.clearTopic(a1);
        return `🧵 <b>${a1}</b> artık genel akışa gidiyor.`;
      }
      if (!TOPICS[a0]) return `Bilinmeyen konu adı. Seçenekler: ${Object.keys(TOPICS).join(', ')}`;
      if (!msg.is_topic_message || !msg.message_thread_id) {
        return 'Bu komutu bağlamak istediğin <b>konunun içinde</b> yaz (grup konulu olmalı: Grup ayarları → Konular).';
      }
      settings.setTopic(a0, msg.message_thread_id);
      console.log(`[AYAR] konu ${a0} → #${msg.message_thread_id} (kullanıcı ${msg.from?.id})`);
      return `🧵 <b>${a0}</b> (${TOPICS[a0]}) bu konuya bağlandı.`;
    },

    durum: () => status(),

    benkimim: (args, msg) => `Kullanıcı ID: <code>${msg.from?.id ?? '—'}</code>`,
  };

  telegram.setCommands(commands);
  const MENU = [
    ['ayarlar', 'Ayar menüsü (bölümler → ayar → −/+)'],
    ['coin', 'Coinin anlık durumu + grafik · örn. /coin ETH'],
    ['yardim', 'Komutlar ve derece dairelerinin anlamı'],
    ['durum', 'Bot durumu: izlenen coin, bağlantı, kart sayısı'],
    ['gecmis', 'Coinin son kartları ve sonrasında fiyat · örn. /gecmis ETH'],
    ['istatistik', 'Kart sınıfları ve kart sonrası fiyat · örn. /istatistik 7'],
    ['seviye', 'Seviye tepkisi: temastan sonra çekilme / EMA21 / kırılım · örn. /seviye 7 fib'],
    ['kacan', 'Düşüş defteri: pompa tepesinden düşüşler, kartlı / kartsız · örn. /kacan 7'],
    ['disaaktar', '(yönetici) İstatistik verisi CSV olarak özelden · örn. /disaaktar 30'],
    ['haftalik', '(yönetici) Haftalık dosyanın ön izlemesi özelden (silmez)'],
    ['takip', 'Takip listesi / ekle-çıkar (kartları hep sesli) · örn. /takip ETH'],
    ['sustur', 'Coini sustur (varsayılan 60 dk) · örn. /sustur ETH 30'],
    ['ac', 'Susturmayı aç · örn. /ac ETH'],
    ['sessiz', 'Susturulan coinler'],
    ['ayar', 'Tek ayarı yazarak değiştir · örn. /ayar rsiMin 90'],
    ['konu', 'Konulu grupta yönlendirme · konunun içinde /konu kart'],
    ['benkimim', 'Telegram kullanıcı ID\'n'],
  ].filter(([c]) => commands[c]).map(([command, description]) => ({ command, description }));
  if (telegram.publishCommands) telegram.publishCommands(MENU).catch(() => {});
  telegram.onCallback(onCallback);
  return { menu, onCallback, commands, normSym };
}

module.exports = { installInfoTelegram, normSym, px };
