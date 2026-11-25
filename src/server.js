'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const infoBot = require('./infoBot');
const binance = require('./binanceClient');
const telegram = require('./telegram');
const cfg = require('./config');

const app = express();
app.set('case sensitive routing', true);   // /API/... yönetici denetimini atlatamasın; tüm rotalar küçük harf
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Temel güvenlik başlıkları — API yanıtları önbelleğe alınmaz, URL'deki belirteç Referer ile sızmaz.
// CSP: satır içi betik yok (script-src 'self'); panel ve giriş sayfası betikleri /panel/*.js dosyalarıdır.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  // API ve HTML yanıtları (giriş sayfası dahil) önbelleğe alınmaz; yalnız /panel/ statikleri hariç.
  if (!req.path.startsWith('/panel/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// CSRF savunması: tarayıcıdan gelen yazma isteklerinde Origin/Referer bu sunucuyla aynı olmalı.
// (Origin başlığı olmayan sunucu-sunucu istekleri — ör. harici bot nabzı — etkilenmez.)
function sameOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  try {
    // Ters vekil (Fly.io vb.) Host'u değiştirebilir; iletilen özgün host da kabul edilir.
    const host = new URL(source).host;
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return host === req.headers.host || (forwarded && host === forwarded);
  } catch {
    return false;
  }
}
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || sameOrigin(req)) return next();
  return res.status(403).json({ ok: false, error: 'Farklı kaynaktan gelen istek reddedildi.' });
});

const { createAdminAuth, safeEqual } = require('./adminAuth');
const adminAuth = createAdminAuth({ telegram });
app.locals.adminAuth = adminAuth;
app.use('/api/auth', adminAuth.authRateLimit);   // IP başına 10 dk'da 20 istek
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const result = await adminAuth.requestCode(String(req.body?.userId || ''), adminAuth.clientIp(req));
    res.status(result.ok ? 202 : (result.status || 503)).json({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  } catch (err) {
    console.error('[AUTH] Telegram doğrulama kodu gönderilemedi:', err.message);
    res.status(503).json({ ok: false, error: 'Telegram üzerinden kod gönderilemedi. Yapılandırmayı kontrol edin.' });
  }
});
app.post('/api/auth/verify', async (req, res) => {
  if (adminAuth.isLocked(String(req.body?.userId || ''), adminAuth.clientIp(req))) return res.status(429).json({ ok: false, error: 'Bu kullanıcı ID için çok fazla yanlış kod denendi; 24 saat boyunca kilitlendi.' });
  const result = await adminAuth.verifyCode(String(req.body?.userId || ''), String(req.body?.code || ''), adminAuth.clientIp(req));
  if (!result) return res.status(401).json({ ok: false, error: 'Kod geçersiz, süresi dolmuş veya kullanım sınırına ulaşmış.' });
  adminAuth.setCookie(res, result.token);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, token: result.token, userId: result.userId, role: result.role, expiresAt: result.expiresAt });
});
app.post('/api/auth/logout', (req, res) => {
  adminAuth.logout(req, res);
  res.json({ ok: true });
});
app.get('/api/auth/session', (req, res) => {
  const session = adminAuth.getSession(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: Boolean(session), userId: session?.userId || null, role: session?.role || null, expiresAt: session?.expiresAt || null });
});
app.post('/api/external-bots/heartbeat', (req, res) => {
  if (!validBotKey(req)) return res.status(401).json({ ok: false, error: 'Geçerli X-Bot-Key başlığı gerekli (EXTERNAL_BOT_KEY).' });
  return handleHeartbeat(req, res);
});
// Giriş sayfasının betiği oturumsuz sunulur (adminAuth.middleware PUBLIC_ASSETS); express.static (panel) gelse de aynı dosya.
app.get('/panel/login.js', (req, res) => res.sendFile('panel/login.js', { root: __dirname }));
app.use(adminAuth.middleware);

// Yalnız yönetici uçları (grup üyesi oturumları 403 alır). Liste tek yerde: karar değişirse buradan.
const ADMIN_ONLY = ['/api/logs', '/api/external-bots', '/api/settings'];
app.use((req, res, next) => {
  const lowerPath = req.path.toLowerCase();
  if (!ADMIN_ONLY.some(p => lowerPath === p || lowerPath.startsWith(p + '/'))) return next();
  if (req.adminSession?.role === 'admin') return next();
  return res.status(403).json({ ok: false, error: 'Yalnız yönetici' });
});

// Panel salt okunur bir yansıtma ekranıdır: bot ayarları ve durumu panelden değiştirilemez
// (ayarlar yalnızca Telegram komutlarıyla yapılır). Oturumlu kullanıcıdan gelen yazma isteği reddedilir.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return res.status(405).json({ ok: false, error: 'Panel salt okunurdur; ayarlar Telegram üzerinden yapılır.' });
});


const startedAt = Date.now();
let botStarted = false;
let botError = null;

// ── Sistem Hata & Günlük Kayıt Deposu ───────────────────────────────────────
const logsBuffer = [];
const MAX_LOGS = 500;
let errorCount = 0;
let warnCount = 0;

// Uyarı ve hatalar ayrıca diske yazılır (bkz. logStore.js) — yeniden başlatmadan sonra da incelenebilir.
// Testlerde LOG_DIR verilmedikçe diske yazılmaz.
const { createLogStore, dayOf } = require('./logStore');
const logStore = createLogStore({ disabled: process.env.NODE_ENV === 'test' && !process.env.LOG_DIR });
app.locals.logStore = logStore;
logStore.prune();
for (const e of logStore.recent(MAX_LOGS)) logsBuffer.push({ id: e.t + Math.random(), restored: true, ...e });
setInterval(() => logStore.prune(), 6 * 60 * 60 * 1000).unref();
process.on('exit', () => logStore.flush());

function addLog(level, args) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');

  const tagMatch = msg.match(/^\[([\p{L}\p{N}#_.-]+)\]/u);
  const tag = tagMatch ? tagMatch[1] : (level === 'error' ? 'HATA' : (level === 'warn' ? 'UYARI' : 'SİSTEM'));
  // Bot bazı uyarıları console.log ile "[UYARI] …" / "[HATA] …" biçiminde yazar; seviyeyi etiketten düzelt.
  if (level === 'info' && /^UYARI$/i.test(tag)) level = 'warn';
  if (level === 'info' && /^HATA$/i.test(tag)) level = 'error';

  if (level === 'error') errorCount++;
  if (level === 'warn') warnCount++;

  const entry = { id: Date.now() + Math.random(), t: Date.now(), level, tag, message: msg };
  logsBuffer.unshift(entry);
  if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();
  // Diske yalnızca uyarı ve hatalar yazılır; sistem/bilgi satırları yalnızca canlı akışta kalır.
  if (level === 'error' || level === 'warn') logStore.append(entry);
}

// Konsol çıktılarını dinle ve log havuzuna aktar
const origError = console.error;
const origWarn = console.warn;
const origLog = console.log;

console.error = function(...args) {
  addLog('error', args);
  origError.apply(console, args);
};
console.warn = function(...args) {
  addLog('warn', args);
  origWarn.apply(console, args);
};
console.log = function(...args) {
  const str = String(args[0] || '');
  if (str.startsWith('[') || /hata|error|warn|kopukluk|bağlan|kapat|uyarı/i.test(str)) {
    addLog('info', args);
  }
  origLog.apply(console, args);
};

// Harici Telegram botları kayıt deposu (Multi-Bot Hub)
const externalBots = new Map();
const MAX_EXTERNAL_BOTS = 50;
const MAX_BOT_METRICS = 20;
const BOT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// Harici botlardan gelen alanlar panelde gösterilir: tür ve uzunluk sınırı (depolama/DoS),
// HTML kaçışı ise istemcide escapeHtml ile yapılır.
function cleanText(value, max = 120) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function cleanMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return null;
  const out = {};
  for (const [k, v] of Object.entries(metrics).slice(0, MAX_BOT_METRICS)) {
    const key = cleanText(k, 40);
    const val = cleanText(v, 80);
    if (key && val != null) out[key] = val;
  }
  return out;
}

const BOT_STATUSES = new Set(['online', 'offline', 'error', 'pending', 'starting', 'idle']);

function hasRoomFor(id) {
  return externalBots.has(id) || externalBots.size < MAX_EXTERNAL_BOTS;
}

// Harici botlar panele oturum açmadan nabız gönderebilsin diye isteğe bağlı paylaşılan anahtar.
// EXTERNAL_BOT_KEY tanımlı değilse nabız uç noktası yalnızca yönetici oturumuyla çalışır.
function validBotKey(req) {
  const expected = process.env.EXTERNAL_BOT_KEY;
  const supplied = req.headers['x-bot-key'];
  return Boolean(expected && expected.length >= 16 && typeof supplied === 'string' && safeEqual(supplied, expected));
}

// Başlangıç botu
externalBots.set('scalp-primary', {
  id: 'scalp-primary',
  name: 'Scalp Sinyal Motoru (Ana Bot)',
  type: 'local',
  telegram: '@ScalpSinyalBot',
  status: 'online',
  lastSeen: Date.now(),
  lastSignal: 'RSI ≥ 85 · SFP & Seviye Motoru',
  metrics: { 'Mod': 'USDT-M Futures', 'Strateji': 'RSI + SFP + Hacim' }
});

// Botu arka planda başlat
async function bootBot() {
  if (botStarted) return;
  botStarted = true;
  try {
    process.env.TELEGRAM_OPTIONAL = '1';
    await infoBot.main();
    console.log('[SERVER] Bilgi botu motoru başarıyla başlatıldı');
  } catch (err) {
    botError = err?.message || String(err);
    console.error('[SERVER] Bilgi botu başlatılırken hata:', botError);
  }
}

// ── Multi-Bot Hub API ───────────────────────────────────────────────────────

app.get('/api/external-bots', (req, res) => {
  const localBot = externalBots.get('scalp-primary');
  if (localBot) {
    const internal = infoBot._internal || {};
    localBot.lastSeen = Date.now();
    localBot.status = botError ? 'error' : (botStarted ? 'online' : 'starting');
    localBot.telegram = telegram.getBotUsername() ? '@' + telegram.getBotUsername() : (process.env.TELEGRAM_BOT_TOKEN ? 'Bağlanıyor...' : 'Web/Yerel Mod');
    localBot.metrics = {
      'İşlenen Mum': (internal.stats?.closes || 0).toLocaleString(),
      'Bugünkü Kart': internal.stats?.cardsToday || internal.stats?.cards || 0,
      'Bellek (RSS)': Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    };
  }

  const list = [...externalBots.values()].map(b => {
    const isLocal = b.type === 'local';
    const isOnline = isLocal ? (botStarted && !botError) : (Date.now() - b.lastSeen < 120_000);
    return {
      ...b,
      isOnline,
      lastSeenSecondsAgo: Math.floor((Date.now() - b.lastSeen) / 1000)
    };
  });

  res.json({ ok: true, bots: list });
});

function handleHeartbeat(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!BOT_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'id alanı zorunludur (harf, rakam, _ . : - · en fazla 64 karakter)' });
  if (id === 'scalp-primary') return res.status(400).json({ ok: false, error: 'Yerel bot nabzı dışarıdan güncellenemez' });
  if (!hasRoomFor(id)) return res.status(429).json({ ok: false, error: `En fazla ${MAX_EXTERNAL_BOTS} harici bot kaydedilebilir` });

  const name = cleanText(body.name, 80);
  const tg = cleanText(body.telegram, 64);
  const lastSignal = cleanText(body.lastSignal, 200);
  const error = cleanText(body.error, 300);
  const status = BOT_STATUSES.has(body.status) ? body.status : null;
  const metrics = cleanMetrics(body.metrics);

  if (error) {
    console.error(`[HARİCİ BOT] ${name || id} hatası: ${error}`);
  }

  const existing = externalBots.get(id) || { id, type: 'remote', registeredAt: Date.now() };
  externalBots.set(id, {
    ...existing,
    id,
    type: 'remote',
    name: name || existing.name || id,
    telegram: tg || existing.telegram || '—',
    status: error ? 'error' : (status || 'online'),
    lastSignal: lastSignal || existing.lastSignal || '—',
    metrics: metrics || existing.metrics || {},
    lastError: error || null,
    lastSeen: Date.now()
  });

  res.json({ ok: true, message: 'Heartbeat kaydedildi' });
}



// ── Sistem Hata & Günlük API ───────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const level = req.query.level;
  let filtered = logsBuffer;
  if (level && level !== 'all') {
    filtered = logsBuffer.filter(l => l.level === level);
  }
  res.json({
    ok: true,
    total: logsBuffer.length,
    errorCount,
    warnCount,
    logs: filtered.slice(0, 200)
  });
});


// Kalıcı günlük: gün listesi, bir günün kayıtları (filtreli) ve ham dosya indirme
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/logs/days', (req, res) => {
  res.json({ ok: true, persistent: logStore.enabled(), days: logStore.summary() });
});

app.get('/api/logs/history', (req, res) => {
  const day = String(req.query.day || dayOf(Date.now()));
  if (!DAY_RE.test(day)) return res.status(400).json({ ok: false, error: 'day YYYY-MM-DD olmalı' });
  const level = ['all', 'error', 'warn', 'info'].includes(req.query.level) ? req.query.level : 'all';
  const result = logStore.query({ day, level, q: String(req.query.q || '').slice(0, 100), limit: req.query.limit });
  res.json({ ok: true, persistent: logStore.enabled(), ...result });
});

app.get('/api/logs/export', (req, res) => {
  const day = String(req.query.day || '');
  if (!DAY_RE.test(day)) return res.status(400).json({ ok: false, error: 'day YYYY-MM-DD olmalı' });
  const buf = logStore.exportDay(day);
  if (!buf) return res.status(404).json({ ok: false, error: 'Bu güne ait kayıt yok.' });
  res.setHeader('Content-Disposition', `attachment; filename="scalp-log-${day}.jsonl"`);
  res.type('application/x-ndjson').send(buf);
});

// Salt okunur raporlar — Telegram komutlarının çıktısı (ayar/durum değiştirmeyenler)
app.get('/api/reports/:name', async (req, res) => {
  const internal = infoBot._internal || {};
  const name = String(req.params.name || '');
  if (!internal.PANEL_REPORTS?.has(name)) return res.status(404).json({ ok: false, error: 'Bilinmeyen rapor.' });
  try {
    const out = await internal.runReport(name, cleanText(req.query.args, 60) || '');
    res.json({ ok: true, name, text: out.text, image: out.photo ? 'data:image/png;base64,' + out.photo.toString('base64') : null });
  } catch (err) {
    console.error(`[PANEL] /api/reports/${name} hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Rapor hazırlanamadı.' });
  }
});

// ── Scalp Bot API ──────────────────────────────────────────────────────────

// Panel "veri kapsamı": en eski kayıtlar ve haftalık rapor slotları (ms epoch UTC; yoksa null).
// Slotlar weeklyReport durumundan okunur; sonraki slot = son slot + 7 gün (Pazartesi 03:01 TSİ, haftalık).
function coverage(internal) {
  const out = { oldestCard: null, oldestEvent: null, oldestTouch: null, lastWeeklySlot: null, nextWeeklySlot: null };
  try {
    const store = internal.getStore?.();
    if (store && store.enabled()) {
      const o = store.oldest();
      out.oldestCard = o.card; out.oldestEvent = o.event; out.oldestTouch = o.touch;
    }
    const last = Number(internal.getWeekly?.()?.state?.lastSlot);
    if (Number.isFinite(last) && last > 0) { out.lastWeeklySlot = last; out.nextWeeklySlot = last + 7 * 86_400_000; }
  } catch (err) {
    console.error(`[PANEL] coverage hesaplanamadı: ${err?.message || err}`);
  }
  return out;
}

app.get('/api/status', (req, res) => {
  const internal = infoBot._internal || {};
  const tgStats = telegram.getStats();
  const wsStats = binance.getWsStats();
  const seriesMap = internal.series;
  const readyCount = seriesMap ? [...seriesMap.values()].filter(s => s.ready()).length : 0;
  const totalCount = seriesMap ? seriesMap.size : 0;
  const mem = process.memoryUsage();

  res.json({
    ok: true,
    coverage: coverage(internal),
    botStarted,
    botError,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    statusText: internal.statusText ? internal.statusText() : 'Piyasa taranıyor...',
    stats: internal.stats || {},
    diagnostics: {
      errorCount,
      warnCount,
      recentErrors: logsBuffer.filter(l => l.level === 'error').slice(0, 5)
    },
    market: {
      totalPairs: totalCount,
      readyPairs: readyCount,
    },
    telegram: {
      polling: telegram.isPolling(),
      username: telegram.getBotUsername(),
      stats: tgStats,
      // chatId panele hiç gitmez; üyeye yalnız kart gönderimleri (özel yanıtlar yöneticide kalır)
      recentDispatches: telegram.getRecentDispatches()
        .filter(d => req.adminSession?.role === 'admin' || d.kind === 'card')
        .map(({ chatId, ...rest }) => rest),
    },
    websocket: wsStats,
    gapRecovery: internal.gapMetrics || {},
    health: internal.health ? internal.health() : null,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
  });
});

app.get('/api/settings', (req, res) => {
  const internal = infoBot._internal || {};
  const s = internal.settings ? internal.settings.get() : cfg.info;
  const { DEFS } = require('./infoSettings');
  res.json({ ok: true, settings: s, defs: DEFS.map(d => ({ key: d.key, label: d.label, type: d.type })) });
});


// Tepe defteri özelliklerinden panele giden beyaz liste (214 alanlık fotoğrafın tamamı gitmez).
// Anahtarlar src/eventLog.js features()/PEAK_COLS/OUTCOME_COLS/AUDIT_COLS adlarıdır; ayrıca `g_*` ve `v3*` önekliler.
const EVENT_FEAT_KEYS = new Set([
  'price', 'grade', 'gradeOld', 'gradeVer', 'score', 'hits', 'rsiOk', 'ok', 'checkOk', 'fails',
  'rsi3', 'rsi5', 'rsi15', 'rsi1h', 'rsi4h', 'rsi3c', 'rsi5c', 'rsi15c', 'rsi1hc', 'rsi4hc',
  'sep3', 'sep5', 'sep15', 'atr5Pct', 'macd3', 'macd5', 'macd15', 'stochK', 'stochD',
  'pumpPct', 'pumpMin', 'pkLv', 'pkLvKind', 'pkLvDist', 'pkLvTouches',
  'trPct', 'trMin', 'trLv', 'upBeforeDrop', 't1', 't2', 't3', 'outcome', 'cardWhen',
  'cfgGradeRsi15m', 'cfgGradeAtr5Pct', 'cfgGradeMacd5m', 'cfgGradeStoch5m', 'cfgSepPct2', 'cfgGradeRsi3m',
]);
const EVENT_FEAT_PREFIXES = ['g_', 'v3'];
function slimEventFeat(feat) {
  const out = {};
  for (const [k, v] of Object.entries(feat || {})) {
    if (v == null) continue;
    if (EVENT_FEAT_KEYS.has(k) || EVENT_FEAT_PREFIXES.some(p => k.startsWith(p))) out[k] = v;
  }
  return out;
}
const limitOf = (q, def, max) => Math.max(1, Math.min(Math.floor(Number(q) || def), max));

app.get('/api/cards', (req, res) => {
  const internal = infoBot._internal || {};
  const store = internal.getStore?.();
  // ?symbol=ETH (ETHUSDT) · ?kind=card (varsayılan) | move (eski ⚡ uyarı kayıtları) | all
  const symbol = panelSymbol(req.query.symbol);
  const kind = ['card', 'move', 'all'].includes(req.query.kind) ? req.query.kind : 'card';
  if (!store || !store.enabled()) {
    const dispatches = telegram.getRecentDispatches().filter(d => d.kind === 'card' && (!symbol || String(d.text || '').includes('#' + symbol)))
      .map(({ chatId, ...rest }) => rest);
    return res.json({ ok: true, source: 'memory', cards: dispatches });
  }
  try {
    res.json({ ok: true, source: 'sqlite', cards: store.cardsBy({ symbol, kind: kind === 'all' ? null : kind, limit: limitOf(req.query.limit, 50, 100) }) });
  } catch (err) {
    console.error(`[PANEL] /api/cards hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Kartlar okunamadı.' });
  }
});

app.get('/api/touches', (req, res) => {
  const internal = infoBot._internal || {};
  const store = internal.getStore?.();
  if (!store || !store.enabled()) return res.json({ ok: true, touches: [] });
  try {
    res.json({ ok: true, touches: store.recentTouches(limitOf(req.query.limit, 50, 100)) });
  } catch (err) {
    console.error(`[PANEL] /api/touches hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Temaslar okunamadı.' });
  }
});

// Tepe defteri (src/eventLog.js): en yeni başta; ?outcome=düştü|devam|yatay ile süzülür.
app.get('/api/events', (req, res) => {
  const store = (infoBot._internal || {}).getStore?.();
  if (!store || !store.enabled()) return res.json({ ok: true, events: [] });
  try {
    const outcome = cleanText(req.query.outcome, 20);
    const events = store.recentEvents(limitOf(req.query.limit, 50, 200), outcome).map(e => ({
      id: e.id, symbol: e.symbol, t: e.t, price: e.price, outcome: e.outcome, dropT: e.dropT, dropMin: e.dropMin,
      card: e.card, cardGrade: e.cardGrade, out: e.out, feat: slimEventFeat(e.feat), hasPath: e.hasPath,
    }));
    res.json({ ok: true, events });
  } catch (err) {
    console.error(`[PANEL] /api/events hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Tepe defteri okunamadı.' });
  }
});

// Tepe sonrası 15 dk 1m yolu: bars = ham fiyat (kayıt girişe göre %; entry * (1 + %/100))
app.get('/api/paths/:id', (req, res) => {
  const store = (infoBot._internal || {}).getStore?.();
  const id = String(req.params.id || '');
  if (!store || !store.enabled() || !/^[A-Z0-9._-]{1,40}$/i.test(id)) return res.status(404).json({ ok: false, error: 'Yol bulunamadı.' });
  try {
    const r = store.pathById(id);
    if (!r) return res.status(404).json({ ok: false, error: 'Yol bulunamadı.' });
    const px = p => +(r.entry * (1 + p / 100)).toPrecision(8);
    const bars = [];
    for (let i = 0; i < r.n && i * 3 + 2 < r.buf.length; i++) bars.push({ h: px(r.buf[i * 3]), l: px(r.buf[i * 3 + 1]), c: px(r.buf[i * 3 + 2]) });
    res.json({ ok: true, path: { id: r.id, symbol: r.symbol, t: r.t, entry: r.entry, n: bars.length, bars } });
  } catch (err) {
    console.error(`[PANEL] /api/paths hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Yol okunamadı.' });
  }
});



// Spot/futures akış (src/spotFlow.js): ?symbol=ETH → 5 pencere özeti + son değişiklikler · symbol yoksa tüm coinlerde son değişiklikler
app.get('/api/flow', (req, res) => {
  const flow = (infoBot._internal || {}).getFlow?.();
  if (!flow || !flow.enabled()) return res.json({ ok: true, enabled: false, changes: [] });
  try {
    const raw = (cleanText(req.query.symbol, 20) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit) || 50), 200));
    if (!raw) return res.json({ ok: true, enabled: true, changes: flow.changes({ since: Date.now() - 7 * 86_400_000, limit }) });
    const symbol = raw.endsWith('USDT') ? raw : raw + 'USDT';
    const history = flow.rowsOf(symbol, 'spot', '4h', 12).reverse().map(r => ({ t: r.t, vol: r.vol, buyPct: r.vol > 0 ? +(r.buy / r.vol * 100).toFixed(2) : null, close: r.close, big: flow.bigSum(symbol, r.t, r.t + 4 * 3_600_000) }));
    res.json({ ok: true, enabled: true, symbol, hasSpot: flow.hasSpot(symbol), bigThreshold: Math.round(flow.bigThreshold(symbol)), windows: flow.summary(symbol), history, changes: flow.changes({ symbol, limit }) });
  } catch (err) {
    console.error(`[PANEL] /api/flow hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Akış verisi okunamadı.' });
  }
});

// Panel akış tablosu: evrendeki tüm coinler (günlük spot özeti, 5 pencerenin etiketi, bugünkü büyük işlemler)
app.get('/api/flow/table', (req, res) => {
  const flow = (infoBot._internal || {}).getFlow?.();
  if (!flow || !flow.enabled()) return res.json({ ok: true, enabled: false, rows: [] });
  try {
    res.json({ ok: true, enabled: true, rows: flow.table() });
  } catch (err) {
    console.error(`[PANEL] /api/flow/table hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Akış tablosu okunamadı.' });
  }
});

// ── Panel ek uçları ─────────────────────────────────────────────────────────
// Botta zaten üretilen bilgilendirici veri, salt okunur: yalnız GET, oturum arkasında (adminAuth.middleware), LIMIT'li.
// Hiçbiri coin başına yeni bellek tutmaz: bellekteki yapıların anlık kopyası ya da indeksli / zaman aralığıyla sınırlı SQLite okuması.
// Üye ve yönetici okuyabilir (Telegram grubunda zaten görünen bilgiler); yönetici-özel uç yok.
// "Sonrası" ve "değişim" alanları yalnız fiyat değişimidir (kazanç/kayıp hesaplanmaz).

const PANEL_SYM_RE = /^[A-Z0-9]{2,30}$/;
/** "eth" / "ETHUSDT" / "1000pepe" → "ETHUSDT" / "1000PEPEUSDT"; geçersizse null */
function panelSymbol(q) {
  const raw = (cleanText(q, 24) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return null;
  const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
  return PANEL_SYM_RE.test(sym) ? sym : null;
}
const panelUniverse = internal => (internal.series ? [...internal.series.keys()] : []);
const panelEvent = e => ({
  id: e.id, symbol: e.symbol, t: e.t, price: e.price, outcome: e.outcome, dropT: e.dropT, dropMin: e.dropMin,
  card: e.card, cardGrade: e.cardGrade, out: e.out, feat: slimEventFeat(e.feat), hasPath: e.hasPath,
});
const DAY_MS = 86_400_000;

// 📋 Detay: kartın Telegram'daki ayrıntı metni (bellekte, son 3000 kart; yeniden başlatmada silinir)
const PANEL_CARD_ID_RE = /^[A-Z0-9]{2,30}-\d{10,14}$/;
app.get('/api/cards/:id/detail', (req, res) => {
  const id = String(req.params.id || '');
  const det = PANEL_CARD_ID_RE.test(id) ? (infoBot._internal || {}).details?.get?.(id) : null;
  if (!det) return res.status(404).json({ ok: false, error: 'Bu kartın ayrıntısı bellekte yok (yeniden başlatmada silinir; son 3000 kart tutulur).' });
  res.json({ ok: true, id, text: String(det).slice(0, 4000) });
});

// Takip: sonrası izlenen kartlar, süren seriler, bugünkü ⚡ 1 dk hareket sayıları, takip ve susturulan coinler
app.get('/api/tracking', (req, res) => {
  const internal = infoBot._internal || {};
  try {
    const limit = limitOf(req.query.limit, 50, 100);
    const now = Date.now();
    const store = internal.getStore?.();
    const open = store && store.enabled() && store.openTracks ? store.openTracks(limit) : [];
    const tr = internal.tracker;
    const series = [], moves = [];
    if (tr) {
      for (const sym of panelUniverse(internal)) {
        if (tr.active?.(sym)) {
          const log = (tr.log?.(sym) || []).filter(e => e.t >= now - DAY_MS);
          const last = log[log.length - 1];
          series.push({ symbol: sym, seq: last?.seq ?? null, cards24h: log.length, lastT: last?.t ?? null, lastPrice: last?.price ?? null, maxGrade: tr.maxGrade?.(sym) ?? null });
        }
        const mv = tr.moveStats?.(sym, now);
        if (mv && (mv.up || mv.down)) moves.push({ symbol: sym, up: mv.up, down: mv.down });
      }
    }
    series.sort((a, b) => (b.lastT || 0) - (a.lastT || 0));
    moves.sort((a, b) => (b.up + b.down) - (a.up + a.down));
    const s = internal.settings;
    res.json({
      ok: true, open, series: series.slice(0, limit), moves: moves.slice(0, limit),
      follows: s?.followList ? s.followList().slice(0, 200) : [],
      muted: s?.mutedList ? s.mutedList(now).slice(0, 200).map(([symbol, until]) => ({ symbol, until })) : [],
    });
  } catch (err) {
    console.error(`[PANEL] /api/tracking hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Takip bilgisi okunamadı.' });
  }
});

// Piyasa: piyasa geneli (dakikalık), likidasyonlar (bellekte son 60 dk), spot büyük işlemler (?hours=1|4|24)
app.get('/api/market', (req, res) => {
  const internal = infoBot._internal || {};
  try {
    const limit = limitOf(req.query.limit, 30, 100);
    const hours = [1, 4, 24].includes(Number(req.query.hours)) ? Number(req.query.hours) : 24;
    const now = Date.now();
    const syms = panelUniverse(internal);
    const liqS = internal.liqStream;
    const liq = liqS?.liq ? syms.map(sym => ({ symbol: sym, ...liqS.liq(sym, now) }))
      .filter(r => (r.liqShort60 || 0) + (r.liqLong60 || 0) > 0)
      .sort((a, b) => ((b.liqShort60 || 0) + (b.liqLong60 || 0)) - ((a.liqShort60 || 0) + (a.liqLong60 || 0)))
      .slice(0, limit) : [];
    const flow = internal.getFlow?.();
    const bigOn = Boolean(flow && flow.enabled() && flow.bigTop);
    const big = bigOn ? flow.bigTop({ symbols: flow.universe(), since: now - hours * 3_600_000, until: now + 1, limit }) : [];
    // Funding: yalnız bellekteki premium Map'inden okunur (REST yok); oran yüzde olarak
    const prem = internal.getPremium?.();
    const fr = prem && typeof prem.entries === 'function'
      ? [...prem.entries()].filter(([, v]) => v && Number.isFinite(v.rate)).map(([symbol, v]) => ({ symbol, ratePct: +(v.rate * 100).toFixed(4), next: Number(v.next) || null }))
      : [];
    fr.sort((a, b) => b.ratePct - a.ratePct || (a.symbol < b.symbol ? -1 : 1));
    const funding = { top: fr.slice(0, 10), bottom: fr.slice(-10).reverse() };
    res.json({ ok: true, state: internal.marketState ? internal.marketState(now) : null, hours, liq, liqStats: liqS?.stats?.() || null, bigEnabled: bigOn, big, funding });
  } catch (err) {
    console.error(`[PANEL] /api/market hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Piyasa verisi okunamadı.' });
  }
});

// Coin ayrıntısı: izleniyor mu, takip/susturma, seri, ⚡ bugün, likidasyon, son kartlar, 7 günlük tepe adayı ve temaslar, 24 s büyük işlem
app.get('/api/coin/:symbol', (req, res) => {
  const sym = panelSymbol(req.params.symbol);
  if (!sym) return res.status(400).json({ ok: false, error: 'Geçersiz coin.' });
  const internal = infoBot._internal || {};
  try {
    const now = Date.now();
    const since = now - 7 * DAY_MS;
    const store = internal.getStore?.();
    const db = store && store.enabled() ? store : null;
    const flow = internal.getFlow?.();
    const fl = flow && flow.enabled() ? flow : null;
    const tr = internal.tracker, s = internal.settings;
    const log = (tr?.log?.(sym) || []).filter(e => e.t >= now - DAY_MS);
    const last = log[log.length - 1];
    const muted = s?.mutedList ? s.mutedList(now).find(([x]) => x === sym) : null;
    res.json({
      ok: true, symbol: sym, watched: Boolean(internal.series?.has(sym)),
      followed: Boolean(s?.isFollowed?.(sym)), mutedUntil: muted ? muted[1] : null,
      series: tr?.active?.(sym) ? { seq: last?.seq ?? null, cards24h: log.length, lastT: last?.t ?? null, maxGrade: tr.maxGrade?.(sym) ?? null } : null,
      moves: tr?.moveStats ? tr.moveStats(sym, now) : null,
      liq: internal.liqStream?.liq ? internal.liqStream.liq(sym, now) : null,
      open: db?.openTracks ? db.openTracks(100).filter(o => o.symbol === sym) : [],
      cards: db ? db.cardsBy({ symbol: sym, kind: 'card', limit: limitOf(req.query.limit, 10, 30) }) : [],
      events: db?.eventsOf ? db.eventsOf(sym, since, 20).map(panelEvent) : [],
      touches: db?.touchesOf ? db.touchesOf(sym, since, 20) : [],
      big: fl?.bigHours ? { day: fl.bigSum(sym, now - DAY_MS, now + 1), hours: fl.bigHours(sym, now - DAY_MS, 24), threshold: Math.round(fl.bigThreshold(sym)) } : null,
    });
  } catch (err) {
    console.error(`[PANEL] /api/coin hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Coin bilgisi okunamadı.' });
  }
});

// Ek veri akışlarının sayaçları (Sistem → Sağlık): likidasyon, spot büyük işlem, akış, tepe ek verisi
app.get('/api/feeds', (req, res) => {
  const internal = infoBot._internal || {};
  try {
    const flow = internal.getFlow?.(), bt = internal.getBigTrades?.(), store = internal.getStore?.();
    res.json({
      ok: true,
      liq: internal.liqStream?.stats?.() || null,
      bigTrades: bt?.stats ? { ...bt.stats } : null,
      flow: flow && flow.enabled() ? { ...flow.stats, universe: flow.universe().length } : null,
      enricher: internal.enricher?.stats ? { ...internal.enricher.stats } : null,
      openTracks: store && store.enabled() ? store.openCount() : null,
      details: internal.details?.map?.size ?? null,
    });
  } catch (err) {
    console.error(`[PANEL] /api/feeds hatası: ${err?.message || err}`);
    res.status(500).json({ ok: false, error: 'Akış sayaçları okunamadı.' });
  }
});

// ── Panel (statik: src/panel/) ─────────────────────────────────────────────
// '/' oturumluysa src/panel/index.html'i önbelleksiz gönderir (oturum belirteci HTML'e gömülmez; oturum yalnız çerezde).
// Oturumsuz '/' isteğini adminAuth.middleware giriş sayfasıyla karşılar. Betik ve stil /panel altından gelir (CSP script-src 'self').
const PANEL_DIR = path.join(__dirname, 'panel');
const PANEL_FILES = new Set(['/index.html', '/app.js', '/app.css', '/login.js']);
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile('index.html', { root: PANEL_DIR, cacheControl: false });
});
app.use('/panel', (req, res, next) => (PANEL_FILES.has(req.path) ? next() : res.status(404).type('text').send('Bulunamadı.')));
app.use('/panel', express.static(PANEL_DIR, { index: false }));

// Sunucuyu 0.0.0.0:3000 üzerinde dinle ve bot motorunu başlat. `node src/server.js` ya da
// src/index.js start() çağırır; testler uygulamayı require edip kendi portunda, motoru başlatmadan açar.
let server = null;
function start() {
  if (server) return server;
  server = app.listen(PORT, HOST, () => {
    console.log(`[SERVER] Scalp Terminal http://${HOST}:${PORT} üzerinde çalışıyor`);
    bootBot();
  });

  function shutdownServer() {
    console.log('\n[SERVER] Kapatılıyor...');
    server.close(() => {
      binance.stopWebSocket();
      telegram.stop();
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdownServer);
  process.on('SIGTERM', shutdownServer);
  return server;
}

if (require.main === module) start();

app.start = start;
module.exports = app;
