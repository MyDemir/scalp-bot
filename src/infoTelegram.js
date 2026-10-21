'use strict';

/**
 * Bilgi botunun Telegram komutları ve buton işleyicileri.
 */

const { formatCard, summaryText, esc, px, pct, dayTime } = require('./infoCard');
const { evaluate, circles } = require('./infoEngine');
const { classTable, median, touchText } = require('./infoStats');
const { rowToStat } = require('./cardStore');
const { dropText, teyitText, createTeyitAcc, slimDrop } = require('./eventLog');
const { buildExports } = require('./exportData');
const { buildWeekly } = require('./weeklyReport');
const cfgAll = require('./config');
const { flowText, changesText } = require('./spotFlow');

const HOUR = 3_600_000;

const TOPICS = {
  kart:     'RSI kartları (tümü)',
  kart3:    '🔴🔴🔴 ve 🔴🔴🔴🔴 kartlar (ayrıca bu konuya; boşsa "kart" konusuna)',
  sistem:   'bot mesajları ("hazır" vb.)',
  backtest: 'backtest raporları (--telegram)',
  rapor:    'haftalık istatistik dosyaları (Pazartesi 03:01; boşsa "sistem" konusuna)',
  tepe:     '🔻 tepe reddi bildirimleri (boşsa "kart" konusuna)',
};

function normSym(x) {
  const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9一-鿿]/g, '');
  if (!s) return null;
  return s.endsWith('USDT') ? s : s + 'USDT';
}

function installInfoTelegram({ telegram, settings, tracker, store = null, details = null, getSeries, ctx, status, chartFor = null, flow = null }) {
  const defs = settings.defs;

  const DEF = Object.fromEntries(defs.map(d => [d.key, d]));
  const SECTIONS = [
    { id: 'rsi', title: '📊 RSI kartı', keys: ['rsiMin', 'rsiMin2', 'strongRsi', 'rsiEntryMax', 'minTFs', 'rsiPeriod', 'resetRsi', 'seriesBursts', 'seriesMinRsi15m'],
      sum: v => `eşik ${v.rsiMin} · ${v.minTFs}/3 dilim · RSI(${v.rsiPeriod}) · seri 15m≥${v.seriesMinRsi15m ?? 85}` },
    { id: 'lvl', title: '🎯 Direnç ve kırılım', keys: ['levelRequired', 'levelMaxPct', 'dipBelowPct', 'dipAbovePct', 'sfpAbovePct', 'confluencePct', 'levelsSwing', 'swingBars', 'zoneTouches', 'levelsFib', 'levelsWeeklyZone', 'sfpCards', 'sfpBars', 'discoveryCards'],
      sum: v => `${v.levelRequired ? 'şart açık' : 'şart kapalı'} · %${v.levelMaxPct} içinde · haftalık bölge ${v.levelsWeeklyZone ? 'açık' : 'kapalı'} · SFP ${v.sfpCards ? 'açık' : 'kapalı'}` },
    { id: 'grd', title: '🏅 Derece ve kontrol listesi', keys: ['gradeBy', 'gradeRsi1h', 'gradeRsi15m', 'gradeAtr5Pct', 'gradeRsi1hMax', 'gradeRsi4hMax', 'gradeRunawayMax', 'gradeNoLevelMax', 'grade2Min', 'grade3Min', 'grade4Min', 'sepPct2', 'sepPct5', 'sepPct10', 'confRsi', 'sepATR', 'sepRequired', 'confRequired', 'macdRequired'],
      sum: v => (v.gradeBy === 'liste' ? `liste: 🔴🔴≥${v.grade2Min} · 🔴🔴🔴≥${v.grade3Min} · 🔴🔴🔴🔴≥${v.grade4Min ?? 7} (9 madde)`
        : `4 şart: ayrışma · 1s RSI ${v.gradeRsi1h ?? 80}–${v.gradeRsi1hMax ?? 88} · 15dk RSI ≥ ${v.gradeRsi15m ?? 85} · 5dk ATR ≥ %${v.gradeAtr5Pct ?? 1.2} (her biri +1 daire, en fazla 4) · kaçak pompa (1s ≥ ${v.gradeRsi1hMax ?? 88} / 4s ≥ ${v.gradeRsi4hMax ?? 80}) en fazla ${v.gradeRunawayMax ?? 2} · dirençsiz en fazla ${v.gradeNoLevelMax ?? 3}`) },
    { id: 'vol', title: '📦 Hacimli mum', keys: ['burstPct1', 'burstPct2', 'volMult', 'volAvgN', 'takerBuyPct', 'takerSellPct', 'volGrade2X', 'dirGrade3Pct', 'windowMin', 'shortWindowMin'],
      sum: v => `gövde ≥ %${v.burstPct1} · hacim ≥ ${v.volMult}×` },
    { id: 'mov', title: '⚡ Hareket', keys: ['moveAlertPct'],
      sum: v => (v.moveAlertPct > 0 ? `1 dk ≥ %${v.moveAlertPct} → RSI kartına eklenir` : 'kapalı') },
    { id: 'pk', title: '🔻 Tepe reddi', keys: ['peakAlert', 'peakAlertMin', 'peakAlertAtrPct', 'peakAlertPumpPct', 'peakAlertRsiOnly', 'peakAlertGapMin'],
      sum: v => (v.peakAlert ? `skor ≥ ${v.peakAlertMin}/4${v.peakAlertAtrPct > 0 ? ` · ATR ≥ %${v.peakAlertAtrPct}` : ''} · pompa ≥ %${v.peakAlertPumpPct}${v.peakAlertRsiOnly ? ' · yalnız RSI şartlı' : ''} · ${v.peakAlertGapMin} dk'da bir` : 'kapalı') },
    { id: 'snd', title: '🔔 Bildirim', keys: ['cardSound'],
      sum: v => `kart ${v.cardSound ? 'sesli' : 'sessiz'}` },
    { id: 'cht', title: '🖼 Grafik', keys: ['chart', 'chartTf', 'chartFib', 'chartIchi', 'chartMinTouches'],
      sum: v => (v.chart ? `${v.chartTf}${v.chartIchi ? ' · Ichimoku' : ''}${v.chartFib ? ' · Fibonacci' : ''}` : 'kapalı') },
    { id: 'flw', title: '🌊 Akış (/akis)', keys: ['flowK', 'flowCvdPct', 'flowPricePct', 'flowStrongX', 'flowWeakX', 'flowBuyPct', 'flowSellPct', 'flowBigPct', 'flowBigMinUsd'],
      sum: v => `son ${v.flowK} pencere · CVD ±%${v.flowCvdPct} · fiyat ±%${v.flowPricePct} · 🐋 günlük hacmin %${v.flowBigPct} (≥ ${v.flowBigMinUsd} $)` },
    { id: 'uni', title: '🌐 İzlenen coinler', keys: ['minVolumeM', 'tradfi'],
      sum: v => `24s hacim ≥ ${v.minVolumeM}M $ · hisse/emtia ${v.tradfi ? 'açık' : 'kapalı'}` },
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
    return { text, keyboard: [...pairs(SECTIONS.map(x => ({ text: x.title, callback_data: `g:${x.id}` }))), [{ text: '↺ Tümünü varsayılana döndür', callback_data: 'r:all' }]] };
  }

  /** Varsayılana döndürme onayı: id = 'all' ya da bölüm */
  function resetMenu(id) {
    const x = id === 'all' ? null : SEC[id];
    const keys = x ? x.keys : Object.keys(settings.defaults());
    const v = settings.get(), def = settings.defaults();
    const diff = keys.filter(k => k in def && v[k] !== def[k]);
    const name = x ? x.title : 'tüm ayarlar';
    const back = { text: '↩️ Vazgeç', callback_data: x ? `g:${x.id}` : 'g:main' };
    if (!diff.length) return { text: `⚙️ <b>${esc(name)}</b> zaten varsayılan değerlerde.`, keyboard: [[back]] };
    const lines = diff.slice(0, 25).map(k => `• ${esc(DEF[k]?.short || k)}: ${esc(val(DEF[k] || {}, v[k]))} → <b>${esc(val(DEF[k] || {}, def[k]))}</b>`);
    const more = diff.length > 25 ? `\n… ve ${diff.length - 25} ayar daha` : '';
    return { text: `↺ <b>${esc(name)}</b> varsayılana dönsün mü?\n\nDeğişecek ${diff.length} ayar:\n${lines.join('\n')}${more}\n\n<i>Susturulan ve takipteki coinler, konu bağlantıları etkilenmez.</i>`,
      keyboard: [[{ text: '✅ Evet, varsayılana döndür', callback_data: `r:${id}:ok` }, back]] };
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
    return { text, keyboard: [...pairs(btns), [{ text: '↺ Bu bölümü varsayılana döndür', callback_data: `r:${id}` }, { text: '↩️ Ayarlar', callback_data: 'g:main' }]] };
  }

  function editMenu(key) {
    const d = DEF[key];
    if (!d || d.type === 'bool') return sectionMenu(secOf(key)?.id);
    const x = secOf(key);
    const v = settings.get()[key], def = settings.defaults()[key];
    const back = [{ text: `↺ Varsayılan (${def})`, callback_data: `z:${key}` }, { text: `↩️ ${x ? x.title : 'Ayarlar'}`, callback_data: x ? `g:${x.id}` : 'g:main' }];
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
    if (kind === 'cmd' && a === 'panelyay') {
      try {
        const admins = await telegram.getGroupAdminIds();
        if (!admins.map(String).includes(String(uid || ''))) return denied;
      } catch (err) {
        console.error('[PANEL-YAYIN] Canlı Telegram yöneticileri doğrulanamadı:', err.message);
        return { text: 'Telegram yönetici listesi alınamadı. /adminyenile komutunu dene.', alert: true };
      }
      const { notifyWebPanelToAdmins } = require('./webUrl');
      const sender = cq.from?.username ? `@${cq.from.username}` : (uid || 'Yönetici');
      notifyWebPanelToAdmins(telegram, { note: 'Telegram Butonu ile Gönderildi', triggeredBy: sender, broadcastToGroup: true })
        .catch(err => console.warn('[PANEL-YAYIN]', err.message));
      return { text: '✅ Web paneli linki gruba ve yöneticilere başarıyla iletiliyor!', alert: true };
    }
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
    if (kind === 'r') {
      if (b !== 'ok') { await show(cq, resetMenu(a)); return null; }
      const x = a === 'all' ? null : SEC[a];
      const n = settings.reset(x ? x.keys : null);
      console.log(`[AYAR] ${x ? x.title : 'tüm ayarlar'} varsayılana döndü (${n} ayar, kullanıcı ${uid})`);
      await show(cq, x ? sectionMenu(x.id) : menu());
      return { text: n ? `↺ ${n} ayar varsayılana döndü.` : 'Zaten varsayılandaydı.' };
    }
    if (kind === 's' || kind === 't' || kind === 'z' || kind === 'v') {
      const r = kind === 's' ? settings.bump(a, Number(b))
        : kind === 't' ? settings.bump(a, 0)
          : kind === 'z' ? settings.set(a, settings.defaults()[a])
            : settings.set(a, b);
      if (!r.ok) return { text: r.error, alert: true };
      console.log(`[AYAR] ${a} = ${r.value} (kullanıcı ${uid})`);
      await show(cq, kind === 't' ? sectionMenu(secOf(a)?.id) : editMenu(a));
      return { text: `${DEF[a]?.short || a}: ${val(DEF[a] || {}, r.value)}` };
    }
    return null;
  }

  // Büyük veri okuyan raporlar (/kacan, /teyit, /disaaktar, /haftalik) aynı anda tek tane — bellek ve mum gecikmesi için
  let heavyBusy = false;
  const heavy = async fn => {
    if (heavyBusy) return '⏳ Başka bir rapor hazırlanıyor — birazdan tekrar dene.';
    heavyBusy = true;
    try { return await fn(); } finally { heavyBusy = false; }
  };
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
/akis [ETH] — spot/futures alım-satım akışı 1s/4s/günlük/haftalık/aylık ve Toplanıyor/Dağıtım etiketi · argümansız: son etiket değişiklikleri
/istatistik [gün] — kart sınıfları ve sonrasında fiyat (varsayılan 7 gün)
/seviye [gün] [ad] — dirence alttan temastan sonraki 60 dk: geri çekilme, 3dk EMA21'e dönüş, kırılım (ör. <code>/seviye 7 fib</code>)
/kacan [gün] — düşüş defteri: pompa tepesinden düşüşler, kartlı/kartsız, kartsızlarda eksik şart
/teyit [gün] — teyit adayları: her pompa tepe adayında hangi durum varken daha sık düştü (varken / yokken düşüş oranı)
/disaaktar [gün] — (yönetici) istatistik verisi CSV olarak özelden: düşüşler, kartlar, temaslar, akış
/haftalik — (yönetici) haftalık dosyanın ön izlemesi özelden (silmez). Asıl dosya her Pazartesi 03:01'de gruba gider ve veritabanı temizlenir
/konu [ad] — konulu grupta yönlendirme (konunun içinde yaz: /konu kart · /konu sistem · /konu kart3 · /konu backtest · /konu rapor)
/durum — bot durumu
/benkimim — Telegram kullanıcı ID'n
/adminyenile — Telegram grubunun yönetici listesini canlı yenile ve doğrula

<b>Derece daireleri</b>
Kart (varsayılan): daireler hep 🔴 = short olgunluğu; 1 + sağlanan şart — EMA21 ayrışma · 1s RSI ${settings.get().gradeRsi1h ?? 80}–${settings.get().gradeRsi1hMax ?? 88} · 15dk RSI ≥ ${settings.get().gradeRsi15m ?? 85} · 5dk ATR ≥ %${settings.get().gradeAtr5Pct ?? 1.2} (en fazla 4); kaçak pompada (1s ≥ ${settings.get().gradeRsi1hMax ?? 88} ya da 4s ≥ ${settings.get().gradeRsi4hMax ?? 80}) en fazla ${settings.get().gradeRunawayMax ?? 2}, direnç yoksa en fazla ${settings.get().gradeNoLevelMax ?? 3} (🔴🔴🔴 ve üstü sesli). Kaçak pompa, 15 dk yön ve 3dk/5dk RSI ≥ ${settings.get().strongRsi} (🔥) yalnız Detay'da
Kart (gradeBy = liste): kurulum kontrol listesi skoru (9 madde: günlük/haftalık direnç, çakışan direnç, 3m/5m RSI ${settings.get().strongRsi}–${settings.get().rsiEntryMax}, 15m ≥ ${settings.get().strongRsi}, 5m+15m ≥ ${settings.get().strongRsi}, 1h/4h ≥ ${settings.get().confRsi}, kademeli EMA21 ayrışma, ≥2 negatif tepe, MACD 3m/5m sat kesişimi) — 🔴 &lt; ${settings.get().grade2Min} · 🔴🔴 ≥ ${settings.get().grade2Min} · 🔴🔴🔴 ≥ ${settings.get().grade3Min} · 🔴🔴🔴🔴 ≥ ${settings.get().grade4Min ?? 7} (sesli)
Hacimli mum / ⚡: 1 daire temel · 2 daire hacim ≥ ${settings.get().volGrade2X}× · 3 daire + yön uyumu ≥ %${settings.get().dirGrade3Pct} — 🟢 alış/yükseliş · 🔴 satış/düşüş · ⚪ nötr
RSI periyodu: ${settings.get().rsiPeriod}

Kart ne zaman gelir: 3m/5m/15m'den en az <b>${settings.get().minTFs}</b> tanesinde RSI ≥ <b>${settings.get().rsiMin}</b>${settings.get().levelRequired ? ` ve fiyatın üstünde en fazla <b>%${settings.get().levelMaxPct}</b> uzakta bir seviye (4h/1d MA200 · EMA200 · 30 günlük tepe)` : ''}. Kontrol: 3m/5m/15m kapanışları + hacimli her 1m mum. Önceki karttan bu yana yeni veri yoksa kart gitmez.${settings.get().seriesBursts ? ' Seri sürerken (15m RSI ' + (settings.get().seriesMinRsi15m ?? 85) + ' üzerinde) gelen hacimli mumlar şart aranmadan kart olur (#SERI).' : ''}${settings.get().moveAlertPct > 0 ? `\n\n⚡ İzlenen coinde 1 dakikada ≥ %${settings.get().moveAlertPct} fiyat değişimi: RSI şartı sağlanıyorsa RSI kartına eklenir; bugünkü ▲/▼ sayısı 📋 Detay'da.` : ''}`.trim();

  const commands = {
    help, yardim: help, start: help,

    ayarlar: () => menu(),

    ayar: adminOnly((args) => {
      const [k, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!k) return 'Kullanım: <code>/ayar anahtar değer</code> — anahtarlar /ayarlar listesinde (ör. rsiMin, minTFs, levelMaxPct).';
      if (['sifirla', 'sıfırla', 'reset'].includes(k.toLowerCase())) { const n = settings.reset(); return `↩️ Tüm ayarlar varsayılana döndü (${n} ayar değişti).`; }
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

    akis: (args) => {
      const f = typeof flow === 'function' ? flow() : flow;
      if (!f || !f.enabled()) return 'Akış takibi kapalı ya da henüz başlamadı.';
      const x = String(args || '').trim();
      if (!x) return changesText(f.changes({ since: Date.now() - 24 * HOUR, limit: 30 }), 24);
      const sym = normSym(x);
      if (!sym) return 'Kullanım: /akis ETH';
      const sm = f.summary(sym);
      if (!Object.values(sm).some(v => v.spot || v.futures)) return `${esc(sym)} için akış verisi yok (izlenmiyor ya da henüz yüklenmedi).`;
      return flowText(esc(sym), sm, f.changes({ symbol: sym, limit: 8 }), settings.get(), f.hasSpot(sym));
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
        const dips = [5, 15, 30, 60].filter(x => r.fwd[x]).map(x => `${x}dk ${pct(r.fwd[x].low, 1)}`);
        const w = r.fwd[60] ? `dip ${dips.join(' · ')} · 60dk tepe ${pct(r.fwd[60].high, 1)} · sonra ${pct(r.fwd[60].close, 1)}`
          : dips.length ? `dip ${dips.join(' · ')} · 60dk bekleniyor` : r.partial ? '60dk: eksik (yeniden başlatma)' : 'bekleniyor';
        if (r.kind === 'tepe') return `${dayTime(r.t)} 🔻 Tepe reddi ${r.score ?? r.seq ?? '—'}/4 → ${w}`;
        if (r.kind === 'move') return `${dayTime(r.t)} ⚡${circles(r.grade || 1, r.movePct > 0 ? 'green' : 'red')} ${pct(r.movePct)} → ${w}`;
        const cls = [`RSI ${r.hits}/3`, r.level?.zone === 'dip' ? 'dirençte' : r.level ? 'yaklaşıyor' : null, r.burst ? `${r.burst.dir === 'sell' ? '▼' : r.burst.dir === 'buy' ? '▲' : '◆'}patlama` : null, r.inSeries ? 'seri içi' : null].filter(Boolean).join(' · ');
        return `${dayTime(r.t)} ${r.grade != null ? circles(r.grade) + ' ' : ''}#${r.seq} ${cls} → ${w}`;
      });
      return `🗂 <b>${esc(sym)}</b> — son ${rows.length} kayıt (karttaki fiyata göre: 5/15/30/60 dk içindeki en düşük · 60 dk en yüksek · 60. dk)\n${lines.join('\n')}`;
    },

    istatistik: (args) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(90, Number(args) || 7));
      const rows = store.since(Date.now() - days * 86_400_000).map(rowToStat);
      const cards = rows.filter(r => r.kind === 'card'), moves = rows.filter(r => r.kind === 'move');
      if (!rows.length) return `Son ${days} günde kayıt yok.`;
      const cls = classTable(cards).filter(r => r.n > 0).map(r =>
        `${esc(r.name.trim())}: <b>${r.n}</b> · dip 5/15/30/60 ${[r.low5, r.low15, r.low30, r.low60].map(v => pct(v, 1)).join(' / ')} · tepe60 ${pct(r.high60, 1)} · son60 ${pct(r.close60, 1)}`);
      const mv = [['▲ yükseliş', moves.filter(m => m.movePct > 0)], ['▼ düşüş', moves.filter(m => m.movePct < 0)]].map(([k, a]) => {
        const f = a.filter(m => m.fwd[60]);
        return `${k}: <b>${a.length}</b> · 60dk sonra medyan ${pct(median(f.map(m => m.fwd[60].close)))} (en düşük ${pct(median(f.map(m => m.fwd[60].low)))} / en yüksek ${pct(median(f.map(m => m.fwd[60].high)))})`;
      });
      const pending = cards.filter(c => !c.fwd[60]).length;
      return `📊 <b>Son ${days} gün</b> · ${cards.length} kart
<i>Karttan sonra fiyat, kart anındaki fiyata göre (medyan): dip = 5 / 15 / 30 / 60 dk içindeki en düşük, tepe60 = 60 dk en yüksek, son60 = 60. dk. 5 ve 30 dk yeni kayıtlarda. Kazanç/kayıp değildir.${pending ? ` 60 dk'sı dolmamış ${pending} kart hariç.` : ''}</i>

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

    kacan: (args) => heavy(async () => {
      if (!store || !store.enabled() || !store.forEachEvent) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(60, Number(String(args).trim()) || 7));
      const since = Date.now() - days * 86_400_000;
      const counts = store.eventCounts({ since });
      const rows = [];                                   // yalnız "düştü"ler, rapor alanlarıyla (bellek)
      await store.forEachEvent({ since, outcome: 'düştü' }, r => { rows.push(slimDrop(r)); });
      rows.sort((a, b) => a.t - b.t);
      return dropText(rows, { title: `son ${days} gün · ${rows.length} düşüş`, s: settings.get(), E: { ...require('./eventLog').DEFAULTS, ...(cfgAll.events || {}) }, counts });
    }),

    teyit: (args) => heavy(async () => {
      if (!store || !store.enabled() || !store.forEachEvent) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(60, Number(String(args).trim()) || 7));
      const E = { ...require('./eventLog').DEFAULTS, ...(cfgAll.events || {}) };
      const acc = createTeyitAcc(); acc.setDropPct(E.dropPct);
      await store.forEachEvent({ since: Date.now() - days * 86_400_000 }, r => acc.add(r));   // satırlar tutulmaz, yalnız sayaçlar
      return teyitText(acc, { title: `son ${days} gün · ${acc.n} tepe adayı`, E });
    }),

    disaaktar: adminOnly((args, msg) => heavy(async () => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(90, Number(String(args).trim()) || 30));
      const uid = msg.from?.id;
      const { files, counts } = await buildExports(store, days, Date.now(), { base: `veri-son${days}gun`, flow: typeof flow === 'function' ? flow() : flow });
      for (const [k, f] of files.entries()) {
        const ok = await telegram.sendDocumentPrivate(uid, f.name, f.buf, k === 0 ? `📤 son ${days} gün · tepeler ${counts.tepeler} · kartlar ${counts.kartlar} · temaslar ${counts.temaslar} · akış ${counts.akis ?? 0} satır (zip içinde CSV)` : null, f.type);
        if (!ok) {
          const bot = telegram.getBotUsername?.();
          return `❌ Özelden gönderemedim. Önce bota özelden bir kez /start yaz${bot ? `: https://t.me/${bot}` : ''} — sonra tekrar /disaaktar.`;
        }
      }
      return `📤 ${files.length} zip özelden gönderildi (son ${days} gün): tepeler.csv ${counts.tepeler} · kartlar.csv ${counts.kartlar} · temaslar.csv ${counts.temaslar} · akis.csv ${counts.akis ?? 0}`;
    })),

    haftalik: adminOnly((args, msg) => heavy(async () => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const w = await buildWeekly(store, { s: settings.get(), E: { ...require('./eventLog').DEFAULTS, ...(cfgAll.events || {}) } });
      for (const [k, f] of w.files.entries()) {
        const ok = await telegram.sendDocumentPrivate(msg.from?.id, f.name, f.buf, k === 0 ? `📦 Ön izleme · ${w.label} · ${w.counts.cards} kart · ${w.counts.peaks} tepe adayı (${w.counts.drops} düştü) · ${w.counts.touches} temas (silinmedi)` : null, f.type);
        if (!ok) { const bot = telegram.getBotUsername?.(); return `❌ Özelden gönderemedim. Önce bota özelden bir kez /start yaz${bot ? `: https://t.me/${bot}` : ''}.`; }
      }
      return `📦 Haftalık ön izleme özelden gönderildi (${w.files.length} dosya). Asıl rapor Pazartesi 03:01'de gruba gider, ardından veritabanı temizlenir.`;
    })),

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

    adminyenile: async (args, msg) => {
      const userId = String(msg.from?.id || '');
      try {
        const ids = await (telegram.refreshGroupAdminIds ? telegram.refreshGroupAdminIds() : telegram.getGroupAdminIds());
        const currentIds = ids.map(String);
        if (!currentIds.includes(userId)) return '⛔ Güncel Telegram yönetici listesinde görünmüyorsun. TELEGRAM_CHAT_ID değerini ve grup yöneticiliğini kontrol et.';
        return `✅ Telegram yönetici listesi canlı olarak yenilendi. Güncel yönetici sayısı: <b>${currentIds.length}</b>. Bu kontrol için TELEGRAM_ADMIN_IDS gerekmez.`;
      } catch (err) {
        console.error('[ADMIN-YENILE] Telegram yönetici listesi alınamadı:', err.message);
        return '❌ Telegram yönetici listesi alınamadı. TELEGRAM_CHAT_ID değerini, botun doğru grupta olduğunu ve gruptaki yönetici erişimini kontrol et.';
      }
    },

    panel: async (args, msg) => {
      try {
        const admins = await telegram.getGroupAdminIds();
        if (!admins.map(String).includes(String(msg.from?.id || ''))) return 'Bu komut için yapılandırılmış Telegram grubunun yöneticisi olmalısın.';
      } catch (err) {
        console.error('[PANEL] Canlı Telegram yöneticileri doğrulanamadı:', err.message);
        return '❌ Telegram yöneticileri doğrulanamadı. /adminyenile komutunu dene ve TELEGRAM_CHAT_ID ile botun grup erişimini kontrol et.';
      }
      const { getWebPanelUrl, notifyWebPanelToAdmins } = require('./webUrl');
      const url = getWebPanelUrl();
      const sub = String(args || '').trim().toLowerCase();
      if (['bildir', 'gonder', 'duyur', 'admin'].includes(sub)) {
        const sender = msg?.from?.username ? `@${msg.from.username}` : (msg?.from?.id || 'Yönetici');
        notifyWebPanelToAdmins(telegram, {
          note: 'Yönetici Talebiyle Gönderildi',
          triggeredBy: sender,
          broadcastToGroup: true
        }).catch(err => console.warn('[PANEL-BILDIR]', err.message));
        return '📢 Panel bildirimi, yönetici talebinle gruba ve yöneticilere özel mesajla gönderiliyor.';
      }
      const text = `⚡ <b>Scalp Terminal & Web Paneli</b>\n\n` +
        `🌐 <b>Canlı Web Paneli:</b> <a href="${url}">${url}</a>\n\n` +
        `• Canlı Sinyal Akışı & Kartlar\n` +
        `• Bot Merkezi (Multi-Bot Hub)\n` +
        `• Hata & Sistem Teşhis Günlüğü\n` +
        `• Anlık Motor Ayarları & Testler\n\n` +
        `<i>Bu bağlantı yalnızca sana özel mesajla gönderilir. Gruba açıkça duyurmak için /panel gonder yaz.</i>`;
      const keyboard = [
        [{ text: '🌐 Web Panelini Aç', url }],
        [{ text: '📲 Linki Gruba & Adminlere İlet', callback_data: 'cmd:panelyay' }]
      ];
      const sent = await telegram.sendPrivate(msg.from.id, text, keyboard);
      if (!sent) return 'Panel bağlantısını özelden gönderemedim. Önce bota özelden /start yazıp tekrar dene.';
      return '🌐 Panel bağlantısını Telegram özel mesajına gönderdim.';
    },

    panelligonder: async (args, msg) => commands.panel('gonder', msg),
    panelbildir: async (args, msg) => commands.panel('gonder', msg),
    web: (args, msg) => commands.panel(args, msg),

    benkimim: (args, msg) => {
      const userId = msg.from?.id;
      const chatId = msg.chat?.id;
      const senderChatId = msg.sender_chat?.id;
      return [
        `👤 Kullanıcı ID: <code>${userId ?? 'Telegram bu mesajda kullanıcı ID\'sini paylaşmıyor'}</code>`,
        `💬 Sohbet/Kanal ID: <code>${chatId ?? '—'}</code>`,
        ...(senderChatId != null ? [`📣 Mesaj adına gönderilen kanal/sohbet ID: <code>${senderChatId}</code>`, 'ℹ️ Mesaj kanal veya anonim yönetici adına gönderildiği için gerçek kullanıcı ID\'si Telegram tarafından gizlenmiş olabilir.'] : []),
      ].join('\n');
    },
  };

  telegram.setCommands(commands);
  const MENU = [
    ['ayarlar', 'Ayar menüsü (bölümler → ayar → −/+)'],
    ['panel', '🌐 Canlı Web Paneli bağlantısı ve durum'],
    ['adminyenile', 'Telegram grubunun güncel yöneticilerini yenile ve doğrula'],
    ['coin', 'Coinin anlık durumu + grafik · örn. /coin ETH'],
    ['yardim', 'Komutlar ve derece dairelerinin anlamı'],
    ['durum', 'Bot durumu: izlenen coin, bağlantı, kart sayısı'],
    ['gecmis', 'Coinin son kartları ve sonrasında fiyat · örn. /gecmis ETH'],
    ['akis', 'Spot/futures alım-satım akışı ve Toplanıyor/Dağıtım etiketi · örn. /akis ETH'],
    ['istatistik', 'Kart sınıfları ve kart sonrası fiyat · örn. /istatistik 7'],
    ['seviye', 'Seviye tepkisi: temastan sonra çekilme / EMA21 / kırılım · örn. /seviye 7 fib'],
    ['kacan', 'Düşüş defteri: pompa tepesinden düşüşler, kartlı / kartsız · örn. /kacan 7'],
    ['teyit', 'Teyit adayları: hangi durum varken tepeden daha sık düştü · örn. /teyit 7'],
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
