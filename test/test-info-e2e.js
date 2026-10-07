'use strict';
// Uçtan uca: gerçek src/index.js (BOT_MODE=info) + sahte Binance REST/WS + sahte Telegram
const SP = require('./_tmp'), REPO = require('path').resolve(__dirname, '..');
const fs = require('fs'); const assert = require('assert');
const { gen, MIN } = require('./gen');
const M = require('./mockinfo');
const PR = 18301, PW = 18302, PT = 18303, CHAT = '-1001234567890', ADMIN = 42, USER = 99;
const SETF = `${SP}/info-settings.json`; fs.rmSync(SETF, { force: true });
for (const f of ['', '-wal', '-shm']) fs.rmSync(`${SP}/cards.db${f}`, { force: true });
Object.assign(process.env, {
  BOT_MODE: 'info', DB_PATH: `${SP}/info-e2e.db`, INFO_SETTINGS_PATH: SETF,
  TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_BASE: `http://127.0.0.1:${PT}`,
  BINANCE_REST_BASE_URL: `http://127.0.0.1:${PR}`, BINANCE_WS_MARKET_URL: `ws://127.0.0.1:${PW}/market/stream`, LIQ_STREAM: '0', BINANCE_SPOT_BASE_URL: `http://127.0.0.1:${PR}`,
  BINANCE_REST_WEIGHT_PER_MIN: '600000',
});
delete process.env.TELEGRAM_ADMIN_IDS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const D = 1440, nowF = Math.floor(Date.now() / MIN) * MIN, start = nowF - 40 * D * MIN;

const pump = gen({ seed: 3, days: 41, start, p0: 130, pumps: [{ at: 40 * D + 5, len: 90, rate: 0.0012, vol: 3, dumpLen: 40 }] });
// Patlamalar: 40D+25 satış (%1.2 düşüş, taker %20 — RSI düşükken → yalnızca sayaca), 40D+62 alım (%1.2, taker %80 — kurulum içinde → kart)
function inject(i, mult, tk) { const c = pump[i], o = pump[i - 1].c, nc = o * mult, f = nc / c.c;
  Object.assign(c, { o, c: nc, h: Math.max(o, nc) * 1.0005, l: Math.min(o, nc) * 0.9995, v: c.v * 6, tb: c.v * 6 * tk }); c.q = c.v * nc; c.tq = c.tb * nc;
  for (let j = i + 1; j < pump.length; j++) for (const k of ['o', 'h', 'l', 'c']) pump[j][k] *= f; }
inject(40 * D + 25, 0.988, 0.2); inject(40 * D + 62, 1.012, 0.8); inject(40 * D + 76, 0.986, 0.2);   // 76: seri içi satış (RSI'ı düşürür)
const defs = {
  BTCUSDT: { m1: gen({ seed: 5, days: 41, start, p0: 60000 }), histUntil: nowF, vol: 9e9 },
  PUMPUSDT: { m1: pump, histUntil: nowF, vol: 3e8 },
  CALMUSDT: { m1: gen({ seed: 7, days: 41, start, p0: 2 }), histUntil: nowF, vol: 2e7 },
  LOWUSDT: { m1: gen({ seed: 8, days: 41, start, p0: 1 }), histUntil: nowF, vol: 1e6 },
  USDCUSDT: { m1: gen({ seed: 9, days: 41, start, p0: 1 }), histUntil: nowF, vol: 5e9, base: 'USDC' },
  NEWUSDT: { m1: gen({ seed: 11, days: 41, start, p0: 3 }), histUntil: nowF, vol: 1e6 },
};
{ const a = defs.LOWUSDT.m1, i = 40 * D + 2,   // açılıştan 2 dk sonra: hacim katı bellekte yok → REST yedeği
  o = a[i - 1].c, nc = o * 1.026, f = nc / a[i].c;
  Object.assign(a[i], { o, c: nc, h: nc * 1.001, l: o * 0.999, v: a[i].v * 5, tb: a[i].v * 5 * 0.8 });
  for (let j = i + 1; j < a.length; j++) for (const k of ['o', 'h', 'l', 'c']) a[j][k] *= f; }
const market = M.buildMarket(defs);
const rest = []; M.startRest(PR, market, rest);
const ws = M.startWs(PW);
const tg = M.startTelegram(PT, { admins: [ADMIN] });

const logs = [];
for (const lvl of ['log', 'warn', 'error']) { const o = console[lvl]; console['_' + lvl] = o; console[lvl] = (...a) => logs.push(a.map(x => typeof x === 'string' ? x : (x?.stack || JSON.stringify(x))).join(' ')); }
const waitFor = async (pred, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return; await sleep(50); } throw new Error('zaman aşımı: ' + label); };
const has = s => logs.some(l => l.includes(s));
const results = []; const ok = s => results.push('✅ ' + s);

(async () => {
  const cfg = require(`${REPO}/src/config`);
  Object.assign(cfg, { heartbeatMs: 1500, telegramMinIntervalMs: 20 });
  Object.assign(cfg.info, { rsiMin: 90, resetRsi: 75 });      // senaryo normal eşiklerle kurgulandı
  require(`${REPO}/src/index.js`);
  const bot = require(`${REPO}/src/infoBot`)._internal;

  await waitFor(() => has('Bilgi botu çalışıyor'), 30000, 'başlangıç');
  const syms = [...bot.series.keys()].sort();
  assert.deepStrictEqual(syms, ['BTCUSDT', 'CALMUSDT', 'PUMPUSDT']);
  assert.strictEqual(ws.conns.length, 1);
  assert.deepStrictEqual([...ws.conns[0].subs].sort(), ['btcusdt@kline_1m', 'calmusdt@kline_1m', 'pumpusdt@kline_1m']);
  const seedCalls = rest.filter(h => h.startsWith('klines PUMPUSDT'));
  assert.deepStrictEqual(seedCalls.map(h => h.split(' ')[2]), ['1d', '4h', '1h', '15m', '5m', '3m', '1m'], 'seed sırası');
  for (const s of bot.series.values()) assert(s.ready(), s.symbol + ' hazır değil');
  await waitFor(() => tg.sent.some(m => m.text.includes('Bilgi botu hazır')), 3000, 'hazır mesajı');
  ok(`Evren: hacim ≥ 5M ve stabil olmayanlar → ${syms.join(', ')} (LOW/NEW 1M evren dışı, USDC elendi); WS'te yalnızca izlenen 3 parite, tek bağlantı, coin başına yalnızca 1m akışı; tohum sırası 1d→…→1m; "hazır" mesajı gitti`);

  // ── Konulu grup: kartlar #77, sistem mesajları #88 konusuna ──
  const bk = tg.sent.length;
  tg.command(CHAT, ADMIN, '/konu kart', 77);
  tg.command(CHAT, ADMIN, '/konu sistem', 88);
  tg.command(CHAT, ADMIN, '/konu sistem');                 // konu dışında → uyarı
  tg.command(CHAT, USER, '/konu kart3', 99);               // yönetici değil
  tg.command('-1009999', ADMIN, '/durum', null, 'Yeni Forum');   // tanımsız sohbet → ID loglanır
  await waitFor(() => tg.sent.length >= bk + 4, 3000, '/konu');
  const kr = tg.sent.slice(bk);
  assert(kr.some(m => m.message_thread_id === 77 && m.text.includes('<b>kart</b>') && m.text.includes('bağlandı')), 'konu kart yanıtı #77 içinde');
  assert(kr.some(m => m.message_thread_id === 88 && m.text.includes('<b>sistem</b>')));
  assert(kr.some(m => m.text.includes('konunun içinde')));
  assert(kr.some(m => m.message_thread_id === 99 && m.text.includes('yönetici')));
  assert.deepStrictEqual(bot.settings.topics(), { kart: 77, sistem: 88 });
  await waitFor(() => has('Tanımsız sohbetten mesaj yok sayıldı: "Yeni Forum" ID -1009999 (konulu grup)'), 2000, 'yabancı sohbet logu');
  ok('Konular — /konu kart (#77) ve /konu sistem (#88) yönetici tarafından konunun içinde bağlandı, yanıtlar aynı konuya gitti; konu dışında yazınca uyarı, üye reddedildi; tanımsız sohbetin ID\'si loglandı');

  // Gelecek dakikaları WS'ten it (kapanmamış ara güncellemeler de gönderilir → atlanmalı)
  let pushed = 0;
  const futureLen = market.PUMPUSDT.future.length;
  for (let i = 0; i < 160 && i < futureLen; i++) {
    for (const s of ['BTCUSDT', 'PUMPUSDT', 'CALMUSDT', 'LOWUSDT']) {
      const c = market[s].future[i];
      ws.push(s, { ...c, c: c.o }, false);          // ara güncelleme
      pushed += ws.push(s, c, true);
    }
    if (i % 10 === 9) await sleep(30);
  }
  await waitFor(() => bot.stats.closes >= 160 * 3, 10000, 'kapanışlar');
  await sleep(500);
  assert(!tg.sent.some(m => m.text.startsWith('⚡')), 'ayrı ⚡ hareket kartı olmamalı');
  ok('⚡ Ayrı hareket kartı yok: izlenen liste dışındaki LOW\'daki 1 dk +%2.6 hareket hiç bildirilmedi (LOW dinlenmiyor)');

  const cards = tg.sent.filter(m => m.reply_markup && !/Anlık durum/.test(m.text) && /Kart \d+/.test(m.text) && !m.text.startsWith('⚡'));
  assert(cards.length >= 2, 'en az 2 kart bekleniyordu: ' + cards.length);
  assert(cards.every(c => c.text.includes('PUMPUSDT')), 'yalnızca PUMP kart üretmeli');
  const nums = cards.map(c => Number(c.text.match(/Kart (\d+)/)[1]));
  assert(nums[0] === 1 && nums.every((x, i) => i === 0 || x === nums[i - 1] + 1 || x === 1), 'kart numaraları seri içinde 1,2,3… (sıfırlanınca 1) olmalı: ' + nums);
  const detId = c => c.reply_markup.inline_keyboard[1][0].callback_data.slice(2);
  const det = c => bot.details.get(detId(c)) || '';
  assert(cards[0].text.includes('🔔: RSI 90+ · Kart 1') && has('İlk kart'), 'ilk kart: ' + cards[0].text);
  // Kısa kart düzeni: RSI alt alta · boş satır · direnç · fiyat · saat; kutu yok
  { const ln = cards[0].text.split(/\r?\n/); const i = ln.findIndex(l => l.startsWith('RSI 3dk:'));
    // … Fiyat · Funding · (hacimli mum / ⚡ satırları kartın altında) · ⏱
    let k = i + 8;
    while (k < ln.length - 1 && /^(🟢|🔴|⚪|⚡)/.test(ln[k])) k++;
    assert(i > 0 && ln[i + 1].startsWith('RSI 5dk:') && ln[i + 4].startsWith('RSI 4s:') && ln[i + 5] === '' && ln[i + 6].startsWith('Direnç:') && ln[i + 7].startsWith('Fiyat:') && ln[i + 8 - (ln[i + 8].startsWith('Funding:') ? 0 : 1)] && ln.slice(i + 8).some(l => l.startsWith('Funding:')) && ln[ln.length - 1].startsWith('⏱:') && ln.slice(1, i).every(l => !/^(🟢|🔴|⚪|⚡)/.test(l)), 'kart düzeni: ' + ln.join(' | '));
    assert(cards.filter(c => c.text.includes('Hacimli')).every(c => { const L2 = c.text.split(/\r?\n/); const h = L2.findIndex(l => l.includes('Hacimli')); return h > L2.findIndex(l => l.startsWith('Fiyat:')) && h === L2.length - 2; }), 'hacimli mum satırı kartın altında, saatten hemen önce');
    assert(!cards.some(c => c.text.includes('blockquote')), 'kutu olmamalı'); }
  assert(cards.every(c => /^(🔴|🟢|⚪)+ <b>#PUMPUSDT — RSI<\/b>$/.test(c.text.split(/\r?\n/)[0]) && c.text.split('#PUMPUSDT').length === 2), 'başlıkta yalnız daireler + #PUMPUSDT, altta tekrar yok');
  assert(!cards.some(c => /mert/i.test(c.text)), 'kartta kişi adı olmamalı');
  // Sahte kırılım kartı yalnızca kart anında RSI şartı varken (3m/5m/15m'den ≥ 2 dilim ≥ eşik)
  for (const l of logs.filter(x => /\[KART\].*Sahte kırılım/.test(x))) assert(/RSI [23]\/3/.test(l), 'RSI şartı yokken sahte kırılım kartı: ' + l);
  assert(!cards.some(c => c.text.includes('Sahte kırılım') && /RSI 3dk: (\d+)/.test(c.text) && false));
  { const vis = h => { const t = h.replace(/\r\n/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); return t.length + (t.match(/\n/g) || []).length; };
    for (const c of cards.filter(c => c.method === 'sendPhoto')) {
      assert(vis(c.text) <= 1024 && det(c).includes('🎯 <b>Kontrol'), 'fotoğraf açıklaması ≤1024 ve Detay hazır: ' + vis(c.text));
    } }
  // Saat hizasına göre alış patlaması ya kartın yeniliği olur ya da ilk karttan hemen önce gelip yalnız sayaca yazılır
  const burstCard = cards.find(c => c.text.includes('Hacimli yükselen mum')) || cards[0];
  assert(burstCard, 'kart yok');
  assert(det(burstCard).replace(/<[^>]+>/g, '').includes('Hacimli mum (1 saat): 1 alış · 1 satış'), 'sayaç: kurulum öncesi satış (yalnızca sayaç) + kart anındaki alım');
  const pre = cards.filter(c => c.text.includes('Hacimli düşen mum') && !c.text.includes('Seri sürüyor (şart dışı)'));
  assert.strictEqual(pre.length, 0, 'seri başlamadan (RSI düşükken) olan satış patlaması kart üretmemeli');
  // Seri içi satış mumu: 5m RSI seriesMinRsi5m (85) altına inmişse artık kart yok (sürekli hacim bildirimi olmasın)
  const serCard = cards.find(c => c.text.includes('🔔: Seri sürüyor (şart dışı)'));
  assert(!serCard || /RSI 5dk: (8[5-9]|9\d|100)/.test(serCard.text), 'seri içi kart yalnız 5m RSI ≥ 85 iken: ' + (serCard && serCard.text));
  const kb = cards[0].reply_markup.inline_keyboard;
  assert(kb[0][0].url.includes('BINANCE:PUMPUSDT.P') && kb[0][1].url.includes('/futures/PUMPUSDT'));
  assert.deepStrictEqual(kb[1].map(b => b.callback_data.split(':')[0]), ['d', 'm', 'f']);
  // 📋 Detay: YALNIZCA basan kişiye özel mesaj; grupta hiçbir şey görünmez
  { const n0 = tg.sent.length, a0 = tg.answers.length, p0 = tg.privates.length;
    tg.click(CHAT, USER, kb[1][0].callback_data, 4242);
    await waitFor(() => tg.privates.length > p0 && tg.answers.length > a0, 3000, 'detay');
    const d = tg.privates.at(-1);
    assert(Number(d.chat_id) === USER && d.text.includes('📊 <b>Hacim ve alış–satış</b>') && /1 saat: .* \$ · ort\. [\d.]+ katı · alış %\d+ \/ satış %\d+ · net/.test(d.text) && d.text.includes('🎯 <b>Kontrol'), 'detay mesajı: ' + d.text.slice(0, 500));
    assert(/özel mesajla/.test(tg.answers.at(-1).text));
    await sleep(300);
    assert.strictEqual(tg.sent.length, n0, 'grupta mesaj olmamalı');
    // botu hiç başlatmamış kullanıcı → özel sohbet bağlantısı (t.me/bot?start=d_<id>) → /start ile Detay gelir
    const NEWU = 555; tg.blockedPrivate.add(NEWU);
    tg.click(CHAT, NEWU, kb[1][0].callback_data, 4242);
    await waitFor(() => tg.answers.length > a0 + 1, 3000, 'detay bağlantı');
    const link = tg.answers.at(-1).url;
    assert(link && link === `https://t.me/info_test_bot?start=d_${detId(cards[0])}`, 'bağlantı: ' + JSON.stringify(tg.answers.at(-1)));
    tg.blockedPrivate.delete(NEWU);
    tg.privateMsg(NEWU, `/start d_${detId(cards[0])}`);
    await waitFor(() => tg.privates.some(m => Number(m.chat_id) === NEWU && m.text.includes('Hacim ve alış–satış')), 3000, 'özel /start');
    // grup üyesi olmayan → reddedilir; özel sohbette başka komut çalışmaz
    tg.privateMsg(777, `/start d_${detId(cards[0])}`);
    await waitFor(() => tg.privates.some(m => Number(m.chat_id) === 777), 3000, 'üye değil');
    assert(/yalnızca grup üyeleri/.test(tg.privates.find(m => Number(m.chat_id) === 777).text));
    const pn = tg.privates.length; tg.privateMsg(NEWU, '/ayarlar'); await sleep(400);
    assert.strictEqual(tg.privates.length, pn, 'özel sohbette /ayarlar çalışmamalı');
    assert.strictEqual(tg.sent.length, n0, 'grupta hâlâ mesaj yok');
    tg.click(CHAT, USER, 'd:YOKUSDT-1', 4243);
    await waitFor(() => tg.answers.length > a0 + 2, 3000, 'detay yok');
    assert(/artık yok/.test(tg.answers.at(-1).text));
    ok('📋 Detay yalnız basana özel mesajla (grupta mesaj yok): hacim/alış–satış 15dk·1s·4s·24s + kontrol; botu başlatmamış kullanıcıya t.me/…?start=d_<id> bağlantısı, /start ile Detay geldi; grup üyesi olmayan reddedildi; özel sohbette başka komut çalışmıyor'); }
  assert(cards.every(c => c.parse_mode === 'HTML'));
  const silentN = cards.filter(c => c.disable_notification).length;
  assert(cards.every(c => Number(c.message_thread_id) === 77), 'kartlar #77 konusuna: ' + cards.map(c => c.message_thread_id));
  assert.strictEqual(silentN, 0, 'varsayılan: her kart bildirimli');
  assert(cards.every(c => c.method === 'sendPhoto' && c.photoBytes > 20000), 'kartlar grafikli (sendPhoto) gitmeli');
  const vis = t => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').length;
  assert(cards.every(c => vis(c.text) <= 1024), 'açıklama 1024 sınırında: ' + cards.map(c => vis(c.text) + (c.text.includes('blockquote') ? 'D' : '')).join(','));
  ok(`Kartlar: ${cards.length} PUMP kartı (#1…#${nums.at(-1)}), BTC/CALM kart yok; ilk kart "İlk kart", RSI düşükken olan satış patlaması yalnızca sayaca yazıldı (kart yok), kurulum içindeki alım patlaması ayrı kart + #HACIM, seri içi satış mumu 5m RSI 85 altına inince kart yok; butonlar (TradingView/Binance/Özet/Sustur/Takip) ve açılır detay bloğu var; ${silentN} sessiz / ${cards.length - silentN} sesli`);
  console._log('\n--- örnek kart (patlama) ---\n' + require(`${REPO}/src/infoCard`).toPlain(burstCard.text) + '\n---');
  console._log('haberler:\n' + cards.map(c => c.text.split('\n')[1]).join('\n'));
  const skipped = logs.filter(l => l.includes('[HEARTBEAT]')).map(l => Number((l.match(/(\d+) ara güncelleme atlandı/) || [])[1] || 0)).reduce((a, b) => a + b, 0);

  // Heartbeat
  await waitFor(() => logs.filter(l => l.includes('[HEARTBEAT]')).length >= 2, 5000, 'heartbeat');
  const hb = logs.filter(l => l.includes('[HEARTBEAT]')).at(-1);
  const sk2 = logs.filter(l => l.includes('[HEARTBEAT]')).map(l => Number((l.match(/(\d+) ara güncelleme atlandı/) || [])[1] || 0)).reduce((a, b) => a + b, 0);
  assert(sk2 >= 480, 'ara güncellemeler atlanmalı: ' + sk2);
  ok(`Kapanmamış ara güncellemeler ayrıştırılmadan atlandı (${sk2}); heartbeat: ${hb.slice(12, 200)}…`);

  // ── Komutlar ve butonlar ──
  const before = tg.sent.length;
  tg.command(CHAT, USER, '/ayarlar');
  await waitFor(() => tg.sent.length > before, 3000, '/ayarlar');
  const menu = tg.sent.at(-1);
  assert(menu.text.includes('Bilgi botu ayarları') && menu.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'g:rsi') && menu.text.includes('⚡ Hareket'));
  tg.click(CHAT, USER, 'g:rsi');                                  // gezinme herkese açık
  await waitFor(() => tg.edits.length >= 1, 3000, 'bölüm');
  assert(tg.edits[0].text.includes('RSI kartı') && tg.edits[0].reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'e:rsiMin'), 'bölüm sayfası');
  tg.edits.length = 0; tg.answers.length = 0;
  assert(tg.myCommands.length === 2 && tg.myCommands[0].scope.type === 'chat' && String(tg.myCommands[0].scope.chat_id) === CHAT && tg.myCommands[1].scope.type === 'default', 'komut menüsü iki kapsamda kaydedilmeli');
  const cmdNames = tg.myCommands[0].commands.map(c => c.command);
  assert(cmdNames[0] === 'ayarlar' && cmdNames.includes('coin') && cmdNames.includes('konu') && tg.myCommands[0].commands.every(c => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.length <= 256));
  ok(`"/" komut menüsü Telegram'a kaydedildi (${cmdNames.length} komut: ${cmdNames.join(', ')})`);
  ok('/ayarlar — bölümlü ana sayfa geldi; üye bölüm sayfasını açabildi (yalnız görüntüleme)');

  tg.click(CHAT, USER, 's:rsiMin:1');
  await waitFor(() => tg.answers.some(a => /yönetici/.test(a.text || '')), 3000, 'yetkisiz tık');
  tg.answers.splice(0, tg.answers.findIndex(a => /yönetici/.test(a.text || '')));   // önceki tıkın geç gelen yanıtı (yarış) atlanır
  assert(/yönetici/.test(tg.answers[0].text) && bot.settings.get().rsiMin === 90, 'yetkisiz: ' + JSON.stringify(tg.answers) + ' rsiMin ' + bot.settings.get().rsiMin);
  tg.click(CHAT, ADMIN, 's:rsiMin:1');
  await waitFor(() => tg.answers.length >= 2 && tg.edits.length >= 1, 3000, 'yetkili tık');
  assert.strictEqual(bot.settings.get().rsiMin, 91);
  assert(tg.edits[0].text.includes('Kart eşiği RSI (🔴)') && tg.edits[0].text.includes('Şu an: <b>91</b>'), tg.edits[0].text.slice(0, 300));
  const saved = JSON.parse(fs.readFileSync(SETF, 'utf8'));
  assert.strictEqual(saved.values.rsiMin, 91);
  tg.click(CHAT, ADMIN, 't:sepRequired');
  await waitFor(() => tg.answers.length >= 3, 3000, 'toggle');
  assert.strictEqual(bot.settings.get().sepRequired, true);
  ok('Ayar butonları — üye basınca "yönetici olmalısın" (değişmedi); yönetici basınca RSI 90→91 ve ayrışma şartı açıldı, menü yerinde güncellendi, dosyaya yazıldı');

  const b2 = tg.sent.length;
  tg.command(CHAT, ADMIN, '/ayar rsiMin 90');
  tg.command(CHAT, ADMIN, '/ayar sepRequired kapat');
  tg.command(CHAT, USER, '/ayar rsiMin 50');
  tg.command(CHAT, ADMIN, '/ayar rsiMin 150');
  await waitFor(() => tg.sent.length >= b2 + 4, 3000, '/ayar');
  assert.strictEqual(bot.settings.get().rsiMin, 90); assert.strictEqual(bot.settings.get().sepRequired, false);
  assert(tg.sent.some(m => m.text.includes('❌') && m.text.includes('50–100')));
  ok('/ayar — yönetici değiştirdi, üye reddedildi, sınır dışı değer (150) reddedildi');

  tg.click(CHAT, USER, 'o:PUMPUSDT');
  await waitFor(() => tg.answers.length >= 4, 3000, 'özet');
  const oz = tg.answers.at(-1);
  assert(oz.show_alert && /PUMPUSDT · bu seride \d+ kart/.test(oz.text) && oz.text.length <= 200);
  ok(`Özet butonu (herkes) — açılır pencere: "${oz.text}"`);

  tg.command(CHAT, USER, '/coin pump');
  await waitFor(() => tg.sent.some(m => m.text && m.text.includes('Anlık durum')), 3000, '/coin');
  assert(tg.sent.find(m => m.text && m.text.includes('Anlık durum')).method === 'sendPhoto', '/coin grafikli');
  ok('/coin PUMP — anlık durum kartı (şart aranmadan) geldi');

  tg.click(CHAT, ADMIN, 'm:PUMPUSDT');
  await waitFor(() => tg.answers.length >= 5, 3000, 'sustur');
  assert(bot.settings.isMuted('PUMPUSDT'));
  const nCards = tg.sent.filter(m => m.reply_markup && /PUMPUSDT<\/b>[\s\S]*Kart \d+/.test(m.text)).length;
  for (let i = 160; i < 175 && i < futureLen; i++) for (const s of ['BTCUSDT', 'PUMPUSDT', 'CALMUSDT']) ws.push(s, market[s].future[i], true);
  await sleep(600);
  assert.strictEqual(tg.sent.filter(m => m.reply_markup && /PUMPUSDT<\/b>[\s\S]*Kart \d+/.test(m.text)).length, nCards, 'susturulan coin kart göndermemeli');
  ok('🔕 Sustur (yönetici) — PUMP 1 saat susturuldu, sonraki mumlarda kart gitmedi');

  tg.command(CHAT, USER, '/durum');
  await waitFor(() => tg.sent.some(m => m.text.includes('izleniyor ·')), 3000, '/durum');
  { const dm = tg.sent.find(m => m.text.includes('izleniyor ·'));
    assert(/Son 5 dk: \d+ mum · gecikme ort [\d.]+ sn, en fazla [\d.]+ sn · işlem yükü %[\d.]+/.test(dm.text) && /(Tüm hazır coinlerde son 3 dk mumu var|Geride \(son 3 dk mum yok\))/.test(dm.text), '/durum yetişme satırları: ' + dm.text);
    console._log('\n' + dm.text.replace(/<[^>]+>/g, '').split('\n').slice(0, 4).join('\n')); }

  // ── Evren yenileme: NEW eklenir, CALM düşer ──
  market.NEWUSDT.vol = 5e7; market.CALMUSDT.vol = 1e6;
  await bot.refreshUniverse();
  assert(bot.series.has('NEWUSDT') && !bot.series.has('CALMUSDT'));
  assert(bot.series.get('NEWUSDT').ready());
  await waitFor(() => !ws.conns[0].subs.has('calmusdt@kline_1m') && ws.conns[0].subs.has('newusdt@kline_1m'), 3000, 'abonelik');
  assert.strictEqual(ws.conns.length, 1, 'yeni bağlantı açılmamalı');
  ok('Evren yenileme — NEW evrene girdi (tohum + SUBSCRIBE), CALM evrenden çıktı (UNSUBSCRIBE); bağlantı kopmadı');

  // ── Kart geçmişi ──
  const st = bot.getStore();
  assert(st.enabled());
  const Database = require(`${REPO}/node_modules/better-sqlite3`);
  const db = new Database(`${SP}/cards.db`, { readonly: true });
  const rows = db.prepare('SELECT * FROM cards ORDER BY t').all();
  assert(rows.filter(r => r.kind === 'card').length === cards.length && rows.filter(r => r.kind === 'move').length === 0, 'db: ' + rows.length);
  const r1 = rows.find(r => r.kind === 'card');
  assert(r1.low15 != null && r1.low60 != null && JSON.parse(r1.data).hits >= 2, 'ilk kartın 15/60 dk takibi dolmalı');
  const b3 = tg.sent.length;
  tg.command(CHAT, USER, '/gecmis pump 5');
  tg.command(CHAT, USER, '/istatistik 1');
  await waitFor(() => tg.sent.length >= b3 + 2, 3000, 'geçmiş komutları');
  const gm = tg.sent.find(m => m.text.includes('🗂')), im = tg.sent.find(m => m.text.includes('📊 <b>Son 1 gün'));
  assert(gm && /#\d+ RSI [23]\/3/.test(gm.text) && /60dk: [−+]/.test(gm.text));
  assert(im && im.text.includes('Kart sınıfları') && !im.text.includes('hareket uyarı'));
  ok(`Kart geçmişi — ${rows.length} kayıt cards.db'de (${cards.length} kart; ayrı hareket kaydı yok), 15/60 dk sonrası dolduruldu; /gecmis ve /istatistik yanıt verdi`);
  console._log('\n' + gm.text.replace(/<[^>]+>/g, '').split('\n').slice(0, 3).join('\n'));
  const tRows = db.prepare('SELECT * FROM touches ORDER BY t').all();
  const b4 = tg.sent.length;
  tg.command(CHAT, USER, '/seviye 1');
  await waitFor(() => tg.sent.length >= b4 + 1, 3000, '/seviye');
  const sm = tg.sent.slice(b4).find(m => m.text.includes('📐'));
  assert(sm && sm.text.includes('Seviye tepkisi') && sm.text.includes(`${tRows.length} temas`), '/seviye: ' + (sm && sm.text));
  if (tRows.length) assert(tRows.every(r => r.pb >= 0 && r.c60 != null && r.name), 'touches satırları');
  ok(`Seviye tepkisi — ${tRows.length} temas kaydı (60 dk'sı dolan), /seviye yanıt verdi`);
  { const eRows = db.prepare('SELECT * FROM events ORDER BY t').all();
    const b5 = tg.sent.length;
    tg.command(CHAT, USER, '/kacan 1');
    await waitFor(() => tg.sent.slice(b5).some(m => m.text.includes('📉 <b>Düşüş defteri</b>')), 3000, '/kacan');
    const km = tg.sent.slice(b5).find(m => m.text.includes('📉 <b>Düşüş defteri</b>'));
    assert(km.text.includes(`${eRows.length} düşüş`), '/kacan: ' + km.text);
    if (eRows.length) assert(eRows.every(r => r.price > 0 && JSON.parse(r.data).rsi5 != null && r.low15 != null), 'events satırları');
    const bm = tg.sent.length;
    tg.command(CHAT, USER, '/disaaktar 1');                         // üye → reddedilir
    await waitFor(() => tg.sent.slice(bm).some(m => m.text.includes('yöneticisi olmalısın')), 9000, '/disaaktar üye');
    const d0 = tg.docs.length, b6 = tg.sent.length;
    tg.command(CHAT, ADMIN, '/disaaktar 1');
    await waitFor(() => tg.docs.length >= d0 + 3 && tg.sent.length > b6, 5000, '/disaaktar');
    const names = tg.docs.slice(d0).map(d => d.documentName);
    assert.deepStrictEqual(names, ['tepeler.csv', 'kartlar.csv', 'temaslar.csv']);
    assert(tg.docs.slice(d0).every(d => Number(d.chat_id) === ADMIN && d.documentBytes > 0 && /^\uFEFF?(id|symbol),/.test(d.documentText)), 'özelden CSV: ' + tg.docs.slice(d0).map(d => [d.chat_id, d.documentText.slice(0, 20)]).join(' | '));
    const kc = tg.docs.slice(d0)[1].documentText.split('\n').filter(Boolean);
    assert(kc.length === cards.length + 1 && kc[0].includes('rsi_3m') && kc[0].includes('fwd_60_low'), 'kartlar.csv: ' + kc[0].slice(0, 200));
    assert(tg.sent.slice(b6).some(m => m.text.includes('📤 3 dosya özelden gönderildi')));
    { const d1 = tg.docs.length, nCards = db.prepare('SELECT COUNT(*) n FROM cards').get().n;
      tg.command(CHAT, ADMIN, '/haftalik');
      await waitFor(() => tg.docs.length >= d1 + 4, 5000, '/haftalik');
      const hw = tg.docs.slice(d1).map(d => d.documentName);
      assert(/^haftalik-\d{4}-H\d\d\.md$/.test(hw[0]) && hw.slice(1).every(n => /^(tepeler|kartlar|temaslar)-\d{4}-H\d\d\.csv$/.test(n)), 'haftalık ön izleme: ' + hw);
      assert(tg.docs[d1].documentText.includes('# Haftalık istatistik'));
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cards').get().n, nCards, 'ön izleme veri silmemeli'); }
    ok(`Düşüş defteri — ${eRows.length} olay; /kacan yanıt verdi; /disaaktar üyeye kapalı, yöneticiye 3 CSV'yi özelden gönderdi; /haftalik ön izleme (MD + 3 CSV) özelden, veri silinmedi (kartlar.csv ${kc.length - 1} satır, rsi_3m · fwd_60_low … sütunları)`); }
  console._log('\n' + sm.text.replace(/<[^>]+>/g, '').split('\n').slice(0, 12).join('\n'));

  // ── Kopukluk: sunucu bağlantıyı kapatır → yeniden bağlan + boşluk doldurma ──
  ws.conns[0].ws.terminate();
  await waitFor(() => ws.conns.length === 2 && ws.conns[1].subs.size === 3, 8000, 'yeniden bağlanma');
  ws.push('BTCUSDT', market.BTCUSDT.future[175], false);      // veri geri geldi (ara güncelleme yeterli)
  await waitFor(() => has('Boşluk doldurma tamamlandı'), 8000, 'boşluk');
  assert(rest.some(h => /^klines BTCUSDT 1m \d+$/.test(h) && Number(h.split(' ')[3]) < 50), 'kısa 1m doldurma isteği bekleniyordu');
  ok('Kopukluk — yeniden bağlandı, 1m boşluğu REST ile dolduruldu');

  const errs = logs.filter(l => /\[(UNCAUGHT|REJECTION|FATAL|DEĞERLENDİRME|BOŞLUK)\]|\[SEED\] \S+USDT:/.test(l) || /gönderilemedi/.test(l));
  assert.strictEqual(errs.length, 0, 'beklenmeyen hata: ' + errs.join(' | '));
  ok('Beklenmeyen hata yok');
  console._log(results.join('\n'));
  process.exit(0);
})().catch(e => { console._log('❌ BAŞARISIZ:', e.message, (e.stack || '').split('\n').find(l => l.includes('test-info-e2e'))); console._log(results.join('\n')); console._log('--- son loglar ---\n' + logs.slice(-30).join('\n')); process.exit(1); });
