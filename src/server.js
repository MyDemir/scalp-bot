'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const infoBot = require('./infoBot');
const binance = require('./binanceClient');
const telegram = require('./telegram');
const cfg = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Temel güvenlik başlıkları — API yanıtları önbelleğe alınmaz, URL'deki belirteç Referer ile sızmaz.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
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
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const result = await adminAuth.requestCode(String(req.body?.userId || ''));
    res.status(result.ok ? 202 : 503).json(result);
  } catch (err) {
    console.error('[AUTH] Telegram doğrulama kodu gönderilemedi:', err.message);
    res.status(503).json({ ok: false, error: 'Telegram üzerinden kod gönderilemedi. Yapılandırmayı kontrol edin.' });
  }
});
app.post('/api/auth/verify', async (req, res) => {
  const result = await adminAuth.verifyCode(String(req.body?.userId || ''), String(req.body?.code || ''));
  if (!result) return res.status(401).json({ ok: false, error: 'Kod geçersiz, süresi dolmuş veya kullanım sınırına ulaşmış.' });
  adminAuth.setCookie(res, result.token);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, token: result.token, userId: result.userId, expiresAt: result.expiresAt });
});
app.post('/api/auth/logout', (req, res) => {
  adminAuth.logout(req, res);
  res.json({ ok: true });
});
app.get('/api/auth/session', (req, res) => {
  const session = adminAuth.getSession(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: Boolean(session), userId: session?.userId || null, expiresAt: session?.expiresAt || null });
});
app.post('/api/external-bots/heartbeat', (req, res) => {
  if (!validBotKey(req)) return res.status(401).json({ ok: false, error: 'Geçerli X-Bot-Key başlığı gerekli (EXTERNAL_BOT_KEY).' });
  return handleHeartbeat(req, res);
});
app.use(adminAuth.middleware);

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

// Kayıtlar ayrıca diske yazılır (bkz. logStore.js) — yeniden başlatmadan sonra da incelenebilir.
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

  if (level === 'error') errorCount++;
  if (level === 'warn') warnCount++;

  const entry = { id: Date.now() + Math.random(), t: Date.now(), level, tag, message: msg };
  logsBuffer.unshift(entry);
  if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();
  logStore.append(entry);
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

// ── Scalp Bot API ──────────────────────────────────────────────────────────

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
      recentDispatches: telegram.getRecentDispatches(),
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


app.get('/api/universe', (req, res) => {
  const internal = infoBot._internal || {};
  const seriesMap = internal.series || new Map();
  const list = [];
  for (const [sym, sr] of seriesMap) {
    const c1m = sr.d['1m']?.c;
    const lastPrice = c1m && c1m.length ? c1m[c1m.length - 1] : null;
    list.push({
      symbol: sym,
      ready: sr.ready(),
      lastPrice,
      isTradfi: binance.isTradfi?.(sym) || false,
    });
  }
  res.json({ ok: true, count: list.length, symbols: list });
});

app.get('/api/cards', (req, res) => {
  const internal = infoBot._internal || {};
  const store = internal.getStore?.();
  if (!store || !store.enabled()) {
    const dispatches = telegram.getRecentDispatches().filter(d => d.kind === 'card');
    return res.json({ ok: true, source: 'memory', cards: dispatches });
  }
  try {
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit) || 50), 100));
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const rows = store.since(since).slice(-limit).reverse();
    res.json({ ok: true, source: 'sqlite', cards: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/touches', (req, res) => {
  const internal = infoBot._internal || {};
  const store = internal.getStore?.();
  if (!store || !store.enabled()) return res.json({ ok: true, touches: [] });
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const touches = store.touchesSince(since).slice(-50).reverse();
    res.json({ ok: true, touches });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});



// ── HTML Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const session = adminAuth.getSession(req, { allowQuery: true });
  const currentToken = session ? (session.token || '') : '';
  res.send(`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SCALP ENGINE // TERMINAL — Bot Hub, Sinyal & Hata Teşhis Terminali</title>
  <meta name="description" content="Binance USDT-M Futures kurumsal scalp botu ve harici Telegram botları merkezi yönetim ve hata izleme terminali">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
          },
          colors: {
            obsidian: {
              950: '#070a10',
              900: '#0c101b',
              850: '#111726',
              800: '#172033',
              700: '#22304d'
            }
          }
        }
      }
    }
  </script>
  <style>
    body {
      background-color: #070a10;
      color: #e2e8f0;
      font-feature-settings: "cv02", "cv03", "cv04", "cv11";
      -webkit-font-smoothing: antialiased;
    }
    .tabular { font-variant-numeric: tabular-nums; }
    .glass-panel {
      background: rgba(12, 16, 27, 0.85);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(34, 48, 77, 0.7);
    }
    .hairline-border { border-color: rgba(34, 48, 77, 0.6); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #070a10; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  </style>
</head>
<body class="min-h-screen flex flex-col font-sans selection:bg-amber-500/20 selection:text-amber-300">

  <!-- Toast Notification Container -->
  <div id="toast-container" class="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"></div>

  <!-- Confirm Modal (safe window.confirm alternative for iframes) -->
  <div id="confirm-modal" class="hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="glass-panel border hairline-border rounded-lg max-w-sm w-full p-5 space-y-4 shadow-2xl">
      <h3 class="font-bold text-white text-sm font-mono" id="confirm-modal-title">İşlem Onayı</h3>
      <p class="text-xs text-slate-300" id="confirm-modal-msg">Emin misiniz?</p>
      <div class="flex justify-end gap-2 pt-2 border-t hairline-border">
        <button onclick="closeConfirmModal(false)" class="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-white cursor-pointer">İptal</button>
        <button onclick="closeConfirmModal(true)" class="px-3.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 font-bold text-xs text-white font-mono cursor-pointer">Onayla</button>
      </div>
    </div>
  </div>

  <!-- Top Bar & Navigation -->
  <header class="border-b hairline-border glass-panel sticky top-0 z-50">
    <!-- Row 1: Brand & Action Controls -->
    <div class="max-w-[1520px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
      
      <!-- Brand & Mode -->
      <div class="flex items-center gap-3 shrink-0">
        <div class="w-8 h-8 rounded bg-gradient-to-br from-amber-500/20 to-amber-600/5 border border-amber-500/30 flex items-center justify-center text-amber-400 font-mono font-bold text-sm shadow-sm select-none">
          ⚡
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold tracking-tight text-white font-mono uppercase">Scalp Engine</span>
          <span class="hidden sm:inline-block text-[11px] font-mono text-slate-400 bg-obsidian-950 px-2 py-0.5 rounded border hairline-border">v2.5 · Terminal</span>
        </div>
      </div>

      <!-- Action Toolbar (Strictly dimensioned, zero layout shifts, smooth responsive scroll) -->
      <div class="flex items-center gap-2 overflow-x-auto no-scrollbar py-1 shrink min-w-0 max-w-full justify-end">
        <button onclick="switchTab('tab-logs')" id="status-quick-btn" class="w-[84px] shrink-0 justify-center flex items-center gap-1.5 text-xs font-mono bg-obsidian-950 border hairline-border px-2 py-1.5 rounded hover:border-slate-600 transition select-none cursor-pointer" title="Hata Günlüğüne Git">
          <span id="quick-err-dot" class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
          <span id="quick-err-text">0 Hata</span>
        </button>
        <button onclick="logoutAdmin()" class="w-[58px] shrink-0 justify-center text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 hover:bg-rose-950 hover:text-rose-300 text-slate-400 font-mono transition whitespace-nowrap border hairline-border select-none cursor-pointer" title="Oturumu Kapat">Çıkış</button>
      </div>

    </div>

    <!-- Row 2: Universal Tab Navigation (Scrollable, stable padding, ZERO layout shifts) -->
    <div class="border-t hairline-border bg-obsidian-950/80 px-4 sm:px-6">
      <nav class="max-w-[1520px] mx-auto flex items-center gap-2 py-2 overflow-x-auto no-scrollbar text-xs">
        <button onclick="switchTab('tab-hub')" id="nav-tab-hub" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm select-none cursor-pointer">
          <span>Bot Merkezi</span>
          <span id="bot-count-nav" class="font-mono text-[11px] opacity-80">(1)</span>
        </button>
        <button onclick="switchTab('tab-terminal')" id="nav-tab-terminal" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer">
          <span>Sinyal Akışı & Kartlar</span>
        </button>
        <button onclick="switchTab('tab-levels')" id="nav-tab-levels" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer">
          <span>Direnç Kayıtları</span>
        </button>
        <button onclick="switchTab('tab-integration')" id="nav-tab-integration" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer">
          <span>API & Webhook</span>
        </button>
        <button onclick="switchTab('tab-settings')" id="nav-tab-settings" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer">
          <span>Motor Ayarları</span>
        </button>
        <button onclick="switchTab('tab-logs')" id="nav-tab-logs" class="px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer">
          <span>Hata & Olay Günlüğü</span>
          <span id="nav-error-badge" class="hidden text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">0</span>
        </button>
      </nav>
    </div>
  </header>


  <!-- Executive KPI Strip -->
  <section class="border-b hairline-border bg-obsidian-900/60">
    <div class="max-w-[1520px] mx-auto px-4 sm:px-6 py-3.5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-y-3 gap-x-6 text-xs">
      
      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">İzlenen Pariteler</div>
        <div class="font-mono font-bold text-white text-base tabular flex items-baseline gap-1.5">
          <span id="stat-pairs">—</span>
          <span class="text-[11px] text-emerald-400 font-normal" id="stat-ready">Hazırlanıyor</span>
        </div>
      </div>

      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">İşlenen 1m Mum</div>
        <div class="font-mono font-bold text-slate-200 text-base tabular" id="stat-closes">—</div>
      </div>

      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">Bugünkü Sinyal Kartı</div>
        <div class="font-mono font-bold text-amber-400 text-base tabular" id="stat-cards">0</div>
      </div>

      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">Sistem Hata & Uyarı</div>
        <div class="font-mono font-bold text-base tabular flex items-baseline gap-1.5">
          <span id="stat-err-count" class="text-emerald-400">0 Hata</span>
          <span class="text-[11px] text-slate-500 font-normal" id="stat-warn-count">· 0 Uyarı</span>
        </div>
      </div>

      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">Telegram Kuyruk & Durum</div>
        <div class="font-mono font-bold text-white text-base tabular flex items-baseline gap-1.5">
          <span id="stat-queue">0 bekleyen</span>
          <span class="text-[11px] text-slate-500 font-normal" id="stat-tg-dropped">0 düşen</span>
        </div>
      </div>

      <div>
        <div class="text-slate-500 text-[11px] mb-0.5">Bellek & Çalışma Süresi</div>
        <div class="font-mono font-bold text-slate-300 text-base tabular flex items-baseline gap-1.5">
          <span id="stat-mem">— MB</span>
          <span class="text-[11px] text-slate-500 font-normal" id="val-uptime">—</span>
        </div>
      </div>

    </div>
  </section>

  <!-- Main Viewport Workspace -->
  <main class="max-w-[1520px] mx-auto px-4 sm:px-6 py-6 flex-1 w-full space-y-6">

    <!-- ═══════════════ TAB 1: MULTI-BOT HUB ═══════════════ -->
    <div id="tab-hub" class="space-y-6">
      <div class="glass-panel p-5 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 class="text-base font-bold text-white tracking-tight flex items-center gap-2">
            <span>Bağlı Telegram Botları & Arka Plan Süreçleri</span>
            <span class="text-xs font-mono text-slate-500 font-normal">· Canlı İzleme</span>
          </h2>
          <p class="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">
            Bu panel hem bu depodaki Scalp botunu hem de diğer repolarınızdaki harici botları tek ekranda toplar.
          </p>
        </div>
      </div>

      <div id="bots-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        <!-- Rendered via JS -->
      </div>
    </div>

    <!-- ═══════════════ TAB 2: SCALP SIGNAL TERMINAL ═══════════════ -->
    <div id="tab-terminal" class="hidden space-y-6">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        
        <div class="lg:col-span-3 space-y-4">
          <div class="flex items-center justify-between border-b hairline-border pb-3">
            <div class="flex items-center gap-3">
              <h2 class="text-sm font-bold tracking-tight text-white uppercase font-mono">Sinyal Akışı</h2>
              <span class="text-xs text-slate-500 font-mono tabular">(<span id="cards-count">0</span> kart yayında)</span>
            </div>
            <div class="w-48 sm:w-64">
              <input type="text" id="filter-search" oninput="filterCards()" placeholder="Parite ara (örn: BTC, SOL)..." class="w-full bg-obsidian-950 border hairline-border rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 font-mono">
            </div>
          </div>

          <div id="cards-container" class="space-y-3">
            <div class="p-12 text-center text-slate-500 glass-panel rounded-lg">
              <div class="text-sm font-medium text-slate-400">Piyasa taranıyor</div>
              <div class="text-xs text-slate-600 mt-1">Koşullar sağlandığında kartlar burada listelenecektir.</div>
            </div>
          </div>
        </div>

        <div class="space-y-5">
          <div class="glass-panel p-4 rounded-lg space-y-3.5">
            <div class="flex items-center justify-between border-b hairline-border pb-2.5">
              <span class="text-xs font-bold text-white font-mono tracking-tight uppercase">Motor Parametreleri</span>
              <button onclick="switchTab('tab-settings')" class="text-[11px] text-amber-400 hover:text-amber-300">Tümü</button>
            </div>
            <div class="space-y-2 text-xs font-mono">
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">RSI Tetikleme:</span>
                <span class="text-white font-semibold" id="cfg-rsi">≥ 85 (2/3 TF)</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">Direnç Payı:</span>
                <span class="text-white font-semibold" id="cfg-level">≤ %2.5</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">Hacim Patlaması:</span>
                <span class="text-white font-semibold" id="cfg-burst">%1.0 / %1.5 (×2)</span>
              </div>
              <div class="flex justify-between py-1">
                <span class="text-slate-400">Min 24s Hacim:</span>
                <span class="text-white font-semibold" id="cfg-vol">≥ 3M $</span>
              </div>
            </div>
          </div>

          <div class="glass-panel p-4 rounded-lg space-y-3.5">
            <div class="flex items-center justify-between border-b hairline-border pb-2.5">
              <span class="text-xs font-bold text-white font-mono tracking-tight uppercase">Telegram Kuyruk Teşhisi</span>
              <span class="text-[10px] text-emerald-400 font-mono">OOM Koruması</span>
            </div>
            <div class="space-y-2 text-xs font-mono">
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">İletilen Mesaj:</span>
                <span class="text-emerald-400 font-semibold tabular" id="tg-sent">0</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">429 Hız Sınırı Tekrarı:</span>
                <span class="text-amber-400 font-semibold tabular" id="tg-429">0</span>
              </div>
              <div class="flex justify-between py-1 border-b border-slate-800/40">
                <span class="text-slate-400">Taşma Koruması (Düşen):</span>
                <span class="text-slate-400 font-semibold tabular" id="tg-overflow">0</span>
              </div>
              <div class="flex justify-between py-1">
                <span class="text-slate-400">Bayat Sinyal TTL (Düşen):</span>
                <span class="text-slate-400 font-semibold tabular" id="tg-expired">0</span>
              </div>
            </div>
          </div>

          <div class="glass-panel p-4 rounded-lg space-y-3.5">
            <div class="flex items-center justify-between border-b hairline-border pb-2.5">
              <span class="text-xs font-bold text-white font-mono tracking-tight uppercase">Veri Akışı Sağlığı</span>
              <span class="text-[10px] font-mono" id="hl-badge">—</span>
            </div>
            <div class="space-y-2 text-xs font-mono" id="health-rows">
              <div class="text-slate-500">Yükleniyor…</div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ═══════════════ TAB 3: HATA & SİSTEM TEŞHİS GÜNLÜĞÜ ═══════════════ -->
    <div id="tab-logs" class="hidden space-y-6">
      
      <div class="glass-panel p-5 rounded-lg space-y-4">
        <!-- Logs Header Toolbar -->
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b hairline-border pb-4">
          <div>
            <h2 class="text-sm font-bold text-white uppercase font-mono tracking-tight flex items-center gap-2">
              <span>Sistem Teşhis & Canlı Hata Günlüğü</span>
              <span id="log-count-badge" class="text-xs text-slate-500 font-normal">0 kayıt</span>
            </h2>
            <p class="text-xs text-slate-400 mt-0.5">Binance bağlantıları, Telegram hız sınırları, SQLite ve motor hataları anlık olarak buraya akar.</p>
          </div>

          <!-- Controls & Filters -->
          <div class="flex flex-wrap items-center gap-2">
            <!-- Filter by level -->
            <div class="flex items-center bg-obsidian-950 p-1 rounded border hairline-border text-xs font-mono">
              <button onclick="setLogLevel('all')" id="log-filter-all" class="px-2.5 py-1 rounded bg-slate-800 text-white font-medium transition">Tümü</button>
              <button onclick="setLogLevel('error')" id="log-filter-error" class="px-2.5 py-1 rounded text-slate-400 hover:text-white transition font-medium">Hatalar</button>
              <button onclick="setLogLevel('warn')" id="log-filter-warn" class="px-2.5 py-1 rounded text-slate-400 hover:text-white transition font-medium">Uyarılar</button>
              <button onclick="setLogLevel('info')" id="log-filter-info" class="px-2.5 py-1 rounded text-slate-400 hover:text-white transition font-medium">Sistem</button>
            </div>

            <!-- Search in logs -->
            <input type="text" id="log-search" oninput="filterLogView()" placeholder="Loglarda ara..." class="w-40 bg-obsidian-950 border hairline-border rounded px-2.5 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 font-mono">

            <button onclick="copyAllLogs()" class="text-xs font-mono px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border hairline-border transition">
              Kopyala
            </button>
          </div>
        </div>

        <!-- Terminal Console View -->
        <div class="bg-obsidian-950 border hairline-border rounded-lg p-3 font-mono text-xs overflow-hidden flex flex-col">
          <div class="flex items-center justify-between text-[11px] text-slate-500 border-b hairline-border pb-2 mb-2 px-1">
            <span class="flex items-center gap-2">
              <span id="log-mode-dot" class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span id="log-mode-label">Canlı Log Akışı</span>
            </span>
            <span class="flex items-center gap-2">
              <select id="log-day" onchange="selectLogDay(this.value)" class="bg-obsidian-950 border hairline-border rounded px-2 py-1 text-[11px] text-slate-200 font-mono">
                <option value="">Canlı (son kayıtlar)</option>
              </select>
              <button onclick="downloadLogDay()" id="log-download" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border hairline-border">İndir</button>
            </span>
          </div>
          
          <div id="log-stream-container" class="space-y-1.5 max-h-[560px] overflow-y-auto pr-1">
            <div class="text-slate-600 py-8 text-center">Henüz bir log veya hata kaydı bulunmuyor.</div>
          </div>
        </div>
      </div>

    </div>

    <!-- ═══════════════ TAB 4: RESISTANCE TOUCHES ═══════════════ -->
    <div id="tab-levels" class="hidden space-y-6">
      <div class="glass-panel p-5 rounded-lg space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b hairline-border pb-3.5">
          <div>
            <h2 class="text-sm font-bold text-white uppercase font-mono tracking-tight">Direnç Temasları & Seviye Tepkileri (SQLite)</h2>
            <p class="text-xs text-slate-400 mt-0.5">Fiyatın direnç seviyelerine alttan teması ve sonraki 60 dakikalık fiyat tepki geçmişi.</p>
          </div>
          <span class="text-xs font-mono text-slate-400 tabular" id="touches-count">0 kayıt</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs font-mono">
            <thead>
              <tr class="text-slate-500 border-b hairline-border">
                <th class="py-2.5 px-3">Parite</th>
                <th class="py-2.5 px-3">Direnç Seviyesi</th>
                <th class="py-2.5 px-3">Seviye Değeri</th>
                <th class="py-2.5 px-3">Temas Sayısı</th>
                <th class="py-2.5 px-3 text-right">Geri Çekilme (pb)</th>
                <th class="py-2.5 px-3 text-right">Sonuç</th>
                <th class="py-2.5 px-3 text-right">Zaman</th>
              </tr>
            </thead>
            <tbody id="touches-table-body" class="divide-y divide-slate-800/40">
              <tr>
                <td colspan="7" class="py-8 text-center text-slate-500">Kayıt bulunamadı.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ═══════════════ TAB 5: ENGINE SETTINGS ═══════════════ -->
    <div id="tab-settings" class="hidden space-y-6">
      <div class="glass-panel p-6 rounded-lg max-w-4xl space-y-4">
        <div>
          <h2 class="text-sm font-bold text-white uppercase font-mono tracking-tight">Motor Ayarları (salt okunur)</h2>
          <p class="text-xs text-slate-400 mt-1">Çalışan motorun güncel ayarları. Bu panel yalnızca yansıtma ekranıdır; ayarlar Telegram komutlarıyla değiştirilir.</p>
        </div>
        <div id="settings-table" class="divide-y divide-slate-800/60 text-xs font-mono">
          <div class="py-6 text-center text-slate-500">Ayarlar yükleniyor…</div>
        </div>
      </div>
    </div>

    <!-- ═══════════════ TAB 6: API & WEBHOOK ═══════════════ -->
    <div id="tab-integration" class="hidden space-y-6">
      <div class="glass-panel p-6 rounded-lg space-y-5 max-w-4xl">
        <div>
          <h2 class="text-base font-bold text-white tracking-tight">Harici Telegram Botlarınızı Bu Panele Bağlama</h2>
          <p class="text-xs text-slate-400 mt-1 leading-relaxed">
            Diğer GitHub depolarınızda çalışan Telegram botlarını bu panele bağlamak için tek yapmanız gereken aşağıdaki JSON'u göndermektir. Botunuzda bir hata meydana geldiğinde <code>"error": "hata mesajı"</code> alanını doldurursanız paneldeki <b>Hata Günlüğü</b> otomatik olarak kırmızı alarm verir.
            Uç nokta yetki ister: sunucuda en az 16 karakterlik <code>EXTERNAL_BOT_KEY</code> tanımlayıp isteğe <code>X-Bot-Key</code> başlığıyla ekleyin.
          </p>
        </div>

        <div class="bg-obsidian-950 p-4 rounded border hairline-border text-xs font-mono">
          <div class="text-slate-400 text-[11px] uppercase tracking-wider mb-1 font-semibold">Heartbeat & Hata Raporlama Uç Noktası</div>
          <div class="text-amber-400 font-bold select-all">POST <span id="webhook-url">http://HOST:PORT/api/external-bots/heartbeat</span></div>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="font-bold text-white font-mono">Python Örneği (Hata Bildirimi Dahil):</span>
            <button onclick="copyCode('code-python')" class="text-slate-400 hover:text-white font-mono text-[11px]">Kopyala</button>
          </div>
          <pre id="code-python" class="bg-obsidian-950 p-4 rounded border hairline-border text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">import requests

HUB_URL = "http://YOUR_SERVER_ADDRESS:3000/api/external-bots/heartbeat"
BOT_KEY = "EXTERNAL_BOT_KEY değeri"

def report_status(error_msg=None):
    payload = {
        "id": "trend-follower-bot",
        "name": "BTC Trend Botu",
        "telegram": "@BtcTrendBot",
        "status": "error" if error_msg else "online",
        "error": error_msg,
        "lastSignal": "BTC LONG @ 64,200",
        "metrics": { "Açık İşlem": "2", "Kâr": "+%4.2" }
    }
    try:
        requests.post(HUB_URL, json=payload, headers={"X-Bot-Key": BOT_KEY}, timeout=5)
    except Exception as e:
        print("Heartbeat gönderilemedi:", e)

# Hata yakalandığında paneli haberdar edin:
# report_status(error_msg="Binance API 451 Bölge Hatası")</pre>
        </div>
      </div>
    </div>

  </main>


  <script>
    window.__ADMIN_TOKEN__ = ${JSON.stringify(currentToken).replace(/</g, '\\u003c')};
    let allCardsData = [];
    let currentLogLevel = 'all';
    let allLogsData = [];
    let logDay = '';          // '' = canlı akış, aksi halde geçmiş gün (YYYY-MM-DD)

    function showToast(msg, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      const colors = {
        success: 'bg-emerald-950/95 border-emerald-500/60 text-emerald-200',
        error: 'bg-rose-950/95 border-rose-500/60 text-rose-200',
        warn: 'bg-amber-950/95 border-amber-500/60 text-amber-200',
        info: 'bg-slate-900/95 border-slate-700 text-slate-200',
      };
      toast.className = 'pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-xl text-xs backdrop-blur-md transition-all duration-300 ' + (colors[type] || colors.info);
      toast.innerHTML = '<span class="flex-1 leading-relaxed font-mono">' + escapeHtml(msg) + '</span>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-8px)';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }
    window.alert = function(msg) { showToast(msg, 'info'); };

    let confirmCallback = null;
    function openConfirm(msg, onConfirm) {
      const modal = document.getElementById('confirm-modal');
      const text = document.getElementById('confirm-modal-msg');
      if (text) text.textContent = msg;
      confirmCallback = onConfirm;
      if (modal) modal.classList.remove('hidden');
    }
    function closeConfirmModal(accepted) {
      const modal = document.getElementById('confirm-modal');
      if (modal) modal.classList.add('hidden');
      if (accepted && typeof confirmCallback === 'function') {
        confirmCallback();
      }
      confirmCallback = null;
    }

    function getAuthHeaders() {
      const token = (typeof window !== 'undefined' && window.__ADMIN_TOKEN__) ||
                    (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('scalp_token')) ||
                    (typeof localStorage !== 'undefined' && localStorage.getItem('scalp_token')) || '';
      return token ? { 'Authorization': 'Bearer ' + token, 'x-session-token': token } : {};
    }

    if (typeof window !== 'undefined' && window.__ADMIN_TOKEN__) {
      try {
        sessionStorage.setItem('scalp_token', window.__ADMIN_TOKEN__);
        localStorage.setItem('scalp_token', window.__ADMIN_TOKEN__);
      } catch (e) {}
    }

    const urlParams = new URLSearchParams(window.location.search);
    const qToken = urlParams.get('token');
    if (qToken) {
      try {
        sessionStorage.setItem('scalp_token', qToken);
        localStorage.setItem('scalp_token', qToken);
      } catch (e) {}
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    async function logoutAdmin() {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { ...getAuthHeaders() } });
      } catch (e) {}
      try {
        sessionStorage.removeItem('scalp_token');
        localStorage.removeItem('scalp_token');
      } catch (e) {}
      location.reload();
    }

    function switchTab(tabId) {
      const tabs = ['tab-hub', 'tab-terminal', 'tab-logs', 'tab-levels', 'tab-settings', 'tab-integration'];
      tabs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      const target = document.getElementById(tabId);
      if (target) target.classList.remove('hidden');

      tabs.forEach(id => {
        const btn = document.getElementById('nav-' + id);
        if (btn) {
          btn.className = "px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent select-none cursor-pointer";
        }
      });
      const activeBtn = document.getElementById('nav-' + tabId);
      if (activeBtn) {
        activeBtn.className = "px-3.5 py-1.5 rounded text-xs font-semibold whitespace-nowrap shrink-0 flex items-center gap-1.5 transition bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm select-none cursor-pointer";
      }
    }

    async function fetchData() {
      try {
        const authH = getAuthHeaders();
        const fetchOpts = { headers: authH, credentials: 'same-origin' };
        const [resBots, resStatus, resSettings, resCards, resTouches, resLogs] = await Promise.all([
          fetch('/api/external-bots', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/status', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/settings', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/cards?limit=30', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/touches', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/logs', fetchOpts).then(r => r.json()).catch(() => ({ ok: false })),
        ]);

        if (resBots.ok && resBots.bots) {
          renderBots(resBots.bots);
          document.getElementById('bot-count-nav').textContent = '(' + resBots.bots.length + ')';
        }

        if (resLogs.ok) {
          if (!logDay) {
            allLogsData = resLogs.logs || [];
            document.getElementById('log-count-badge').textContent = resLogs.total + ' kayıt';
            renderLogs(allLogsData);
          }

          const errs = resLogs.errorCount || 0;
          const warns = resLogs.warnCount || 0;
          const navBadge = document.getElementById('nav-error-badge');
          const quickText = document.getElementById('quick-err-text');
          const quickDot = document.getElementById('quick-err-dot');
          const statErr = document.getElementById('stat-err-count');
          const statWarn = document.getElementById('stat-warn-count');

          statWarn.textContent = '· ' + warns + ' Uyarı';

          if (errs > 0) {
            navBadge.textContent = errs;
            navBadge.classList.remove('hidden');
            quickText.textContent = errs + ' Hata';
            quickText.className = 'text-rose-400 font-bold';
            quickDot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
            statErr.textContent = errs + ' Hata';
            statErr.className = 'text-rose-400 font-bold';
          } else {
            navBadge.classList.add('hidden');
            quickText.textContent = '0 Hata';
            quickText.className = 'text-slate-300';
            quickDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            statErr.textContent = '0 Hata';
            statErr.className = 'text-emerald-400';
          }
        }

        if (resStatus.ok) {
          document.getElementById('stat-pairs').textContent = resStatus.market?.totalPairs || 0;
          document.getElementById('stat-ready').textContent = (resStatus.market?.readyPairs || 0) + ' hazır';
          document.getElementById('stat-closes').textContent = (resStatus.stats?.closes || 0).toLocaleString();
          document.getElementById('stat-cards').textContent = resStatus.stats?.cardsToday || resStatus.stats?.cards || 0;
          document.getElementById('stat-queue').textContent = (resStatus.telegram?.stats?.queued || 0) + ' bekleyen';
          document.getElementById('stat-tg-dropped').textContent = ((resStatus.telegram?.stats?.droppedOverflow || 0) + (resStatus.telegram?.stats?.droppedExpired || 0)) + ' düşen';
          document.getElementById('stat-mem').textContent = (resStatus.memory?.rssMb || '—') + ' MB';

          const up = resStatus.uptimeSeconds || 0;
          const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60);
          document.getElementById('val-uptime').textContent = (h > 0 ? h + 's ' : '') + m + 'dk';

          if (resStatus.telegram?.stats) {
            document.getElementById('tg-sent').textContent = resStatus.telegram.stats.sent || 0;
            document.getElementById('tg-429').textContent = resStatus.telegram.stats.retried429 || 0;
            document.getElementById('tg-overflow').textContent = resStatus.telegram.stats.droppedOverflow || 0;
            document.getElementById('tg-expired').textContent = resStatus.telegram.stats.droppedExpired || 0;
          }
        }

        if (resStatus.ok) renderHealth(resStatus);

        if (resSettings.ok && resSettings.settings) {
          const s = resSettings.settings;
          document.getElementById('cfg-rsi').textContent = '≥ ' + s.rsiMin + ' (' + s.minTFs + '/3 TF)';
          document.getElementById('cfg-level').textContent = '≤ %' + s.levelMaxPct;
          document.getElementById('cfg-burst').textContent = '%' + s.burstPct1 + ' / %' + s.burstPct2 + ' (×' + s.volMult + ')';
          document.getElementById('cfg-vol').textContent = '≥ ' + s.minVolumeM + 'M $';

          renderSettings(s, resSettings.defs || []);
        }

        if (resCards.ok && resCards.cards) {
          allCardsData = resCards.cards;
          renderCards(allCardsData);
        }

        if (resTouches.ok && resTouches.touches) {
          renderTouches(resTouches.touches);
        }
      } catch (err) {
        console.error('Veri senkronizasyon hatası:', err);
      }
    }

    function renderLogs(logs) {
      const container = document.getElementById('log-stream-container');
      const searchQ = (document.getElementById('log-search')?.value || '').toLowerCase();
      
      let list = logs;
      if (currentLogLevel !== 'all') {
        list = list.filter(l => l.level === currentLogLevel);
      }
      if (searchQ) {
        list = list.filter(l => (l.message || '').toLowerCase().includes(searchQ) || (l.tag || '').toLowerCase().includes(searchQ));
      }

      if (!list.length) {
        container.innerHTML = '<div class="text-slate-600 py-8 text-center">Filtreye uygun log veya hata kaydı bulunamadı.</div>';
        return;
      }

      container.innerHTML = list.map(l => {
        const timeStr = new Date(l.t).toLocaleTimeString('tr-TR');
        let levelColor = 'text-slate-400 bg-slate-800/60 border-slate-700';
        let levelLabel = 'INFO';
        if (l.level === 'error') {
          levelColor = 'text-rose-400 bg-rose-500/10 border-rose-500/30';
          levelLabel = 'HATA';
        } else if (l.level === 'warn') {
          levelColor = 'text-amber-400 bg-amber-500/10 border-amber-500/30';
          levelLabel = 'UYARI';
        }

        return '<div class="py-1 px-2 rounded hover:bg-slate-900/60 transition flex items-start gap-2.5 leading-relaxed font-mono text-[11px] border border-transparent hover:border-slate-800">' +
          '<span class="text-slate-600 shrink-0 select-none">' + timeStr + '</span>' +
          '<span class="text-[10px] px-1.5 py-0.2 rounded border shrink-0 font-bold ' + levelColor + '">' + levelLabel + '</span>' +
          '<span class="text-sky-400 font-semibold shrink-0">[' + escapeHtml(l.tag) + ']</span>' +
          '<span class="text-slate-200 break-all">' + escapeHtml(l.message) + '</span>' +
        '</div>';
      }).join('');
    }

    async function loadLogDays() {
      try {
        const r = await fetch('/api/logs/days', { headers: getAuthHeaders(), credentials: 'same-origin' }).then(x => x.json());
        const sel = document.getElementById('log-day');
        if (!r.ok || !sel) return;
        const keep = sel.value;
        sel.innerHTML = '<option value="">Canlı (son kayıtlar)</option>' + (r.days || []).map(d =>
          '<option value="' + escapeHtml(d.day) + '">' + escapeHtml(d.day + ' · ' + d.errors + ' hata · ' + d.warnings + ' uyarı · ' + d.total + ' kayıt') + '</option>').join('');
        sel.value = keep;
        if (!r.persistent) sel.title = 'Kalıcı kayıt kapalı (disk yazılamıyor)';
      } catch (e) {}
    }

    async function selectLogDay(day) {
      logDay = day;
      const dot = document.getElementById('log-mode-dot');
      const label = document.getElementById('log-mode-label');
      if (!day) {
        dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        label.textContent = 'Canlı Log Akışı';
        fetchData();
        return;
      }
      dot.className = 'w-2 h-2 rounded-full bg-sky-500';
      label.textContent = 'Kayıtlı günlük · ' + day;
      try {
        const r = await fetch('/api/logs/history?limit=5000&day=' + encodeURIComponent(day), { headers: getAuthHeaders(), credentials: 'same-origin' }).then(x => x.json());
        allLogsData = r.ok ? (r.entries || []) : [];
        document.getElementById('log-count-badge').textContent = (r.total || 0) + ' kayıt';
        renderLogs(allLogsData);
      } catch (e) {
        showToast('Günlük okunamadı: ' + e.message, 'error');
      }
    }

    async function downloadLogDay() {
      const day = logDay || new Date().toISOString().slice(0, 10);
      try {
        const res = await fetch('/api/logs/export?day=' + encodeURIComponent(day), { headers: getAuthHeaders(), credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'İndirilemedi');
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url; a.download = 'scalp-log-' + day + '.jsonl';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        showToast('Günlük indirilemedi: ' + e.message, 'error');
      }
    }

    function setLogLevel(lvl) {
      currentLogLevel = lvl;
      ['all', 'error', 'warn', 'info'].forEach(k => {
        const b = document.getElementById('log-filter-' + k);
        if (b) b.className = "px-2.5 py-1 rounded text-slate-400 hover:text-white transition font-medium";
      });
      const activeBtn = document.getElementById('log-filter-' + lvl);
      if (activeBtn) activeBtn.className = "px-2.5 py-1 rounded bg-slate-800 text-white transition font-medium shadow-sm";
      renderLogs(allLogsData);
    }

    function filterLogView() {
      renderLogs(allLogsData);
    }


    function copyAllLogs() {
      const text = allLogsData.map(l => '[' + new Date(l.t).toLocaleTimeString('tr-TR') + '] [' + l.level.toUpperCase() + '] [' + l.tag + '] ' + l.message).join('\\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
      showToast('Tüm loglar panoya kopyalandı!', 'success');
    }

    function escapeHtml(str) {
      return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function renderBots(bots) {
      const container = document.getElementById('bots-grid');
      container.innerHTML = bots.map(b => {
        const isOnline = b.isOnline;
        const statusBadge = isOnline
          ? '<span class="text-[11px] font-mono text-emerald-400 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Çevrimiçi</span>'
          : '<span class="text-[11px] font-mono text-rose-400 flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Çevrimdışı</span>';

        const lastSeenText = b.lastSeen === 0 ? 'Bağlantı bekleniyor' : (b.lastSeenSecondsAgo < 60 ? b.lastSeenSecondsAgo + ' sn önce' : Math.floor(b.lastSeenSecondsAgo / 60) + ' dk önce');
        const metricsHtml = Object.entries(b.metrics || {}).map(([k, v]) => '<div class="text-[11px] flex justify-between py-0.5"><span class="text-slate-400">' + escapeHtml(k) + ':</span> <span class="font-mono text-slate-200">' + escapeHtml(v) + '</span></div>').join('');

        return '<div class="glass-panel rounded-lg p-5 space-y-4 hover:border-slate-600 transition">' +
          '<div class="flex items-start justify-between">' +
            '<div>' +
              '<h3 class="font-bold text-white text-sm tracking-tight flex items-center gap-2">' + escapeHtml(b.name) +
                (b.type === 'local' ? '<span class="text-[10px] text-amber-400 font-mono">[Yerel]</span>' : '') +
              '</h3>' +
              '<div class="text-xs text-sky-400 font-mono mt-0.5">' + escapeHtml(b.telegram || '—') + '</div>' +
            '</div>' +
            statusBadge +
          '</div>' +
          '<div class="bg-obsidian-950 p-3 rounded border hairline-border text-xs space-y-1">' +
            '<div class="text-slate-500 text-[10px] uppercase font-mono tracking-wider font-semibold">Son Sinyal / Durum</div>' +
            '<div class="text-slate-200 font-mono truncate">' + escapeHtml(b.lastSignal || '—') + '</div>' +
          '</div>' +
          (b.lastError ? '<div class="text-[11px] text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20 font-mono">Hata: ' + escapeHtml(b.lastError) + '</div>' : '') +
          (metricsHtml ? '<div class="space-y-0.5 pt-2 border-t hairline-border">' + metricsHtml + '</div>' : '') +
          '<div class="flex items-center justify-between text-[11px] text-slate-500 pt-2 border-t hairline-border font-mono">' +
            '<span>Son nabız: ' + lastSeenText + '</span>' +
            '<span class="text-slate-600">' + (b.type === 'local' ? 'Sistem Servisi' : 'Harici Bot') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderCards(cards) {
      const container = document.getElementById('cards-container');
      document.getElementById('cards-count').textContent = cards.length;
      if (!cards.length) {
        container.innerHTML = '<div class="p-12 text-center text-slate-500 glass-panel rounded-lg"><div class="text-sm font-medium text-slate-400">Piyasa taranıyor</div><div class="text-xs text-slate-600 mt-1">Koşullar sağlandığında kartlar burada belirecektir.</div></div>';
        return;
      }
      container.innerHTML = cards.map(c => {
        const d = c.data ? (typeof c.data === 'string' ? JSON.parse(c.data || '{}') : c.data) : c;
        const sym = c.symbol || d.symbol || 'PARİTE';
        const price = c.price || d.price || '—';
        const grade = Math.max(1, Math.min(4, Number(d.grade) || 1));
        const timeStr = c.t ? new Date(c.t).toLocaleTimeString('tr-TR') : '';
        const isBuy = d.burst?.dir === 'buy';

        return '<div class="glass-panel rounded-lg p-4 hover:border-slate-600 transition space-y-3">' +
          '<div class="flex items-center justify-between">' +
            '<div class="flex items-center gap-3">' +
              '<span class="font-bold text-white text-base font-mono">' + escapeHtml(sym) + '</span>' +
              '<span class="text-xs font-mono ' + (isBuy ? 'text-emerald-400' : 'text-amber-400') + '">' + (isBuy ? '● ALIM PATLAMASI' : '● SATIŞ / DİRENÇ') + '</span>' +
              '<span class="text-xs text-slate-500 font-mono tracking-widest">' + '●'.repeat(grade) + '</span>' +
            '</div>' +
            '<div class="text-right">' +
              '<div class="font-mono text-sm text-white font-bold tabular">' + escapeHtml(price != null ? '$' + price : '—') + '</div>' +
              '<div class="text-[10px] text-slate-500 font-mono">' + timeStr + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="grid grid-cols-3 gap-3 text-xs font-mono bg-obsidian-950 p-2.5 rounded border hairline-border">' +
            '<div><span class="text-slate-500">RSI:</span> <span class="text-amber-400 font-semibold">' + escapeHtml(d.rsi?.val || d.rsi15 || '—') + '</span></div>' +
            '<div><span class="text-slate-500">Direnç:</span> <span class="text-sky-400 font-semibold truncate">' + escapeHtml(d.level?.name || 'Tespit Edildi') + '</span></div>' +
            '<div><span class="text-slate-500">EMA Gap:</span> <span class="text-slate-200">' + escapeHtml(d.emaGap != null ? '%' + d.emaGap : '—') + '</span></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function filterCards() {
      const q = document.getElementById('filter-search').value.trim().toUpperCase();
      if (!q) { renderCards(allCardsData); return; }
      const filtered = allCardsData.filter(c => (c.symbol || '').toUpperCase().includes(q));
      renderCards(filtered);
    }

    function renderTouches(touches) {
      const tbody = document.getElementById('touches-table-body');
      document.getElementById('touches-count').textContent = touches.length + ' kayıt';
      if (!touches.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-500">Kayıtlı temas yok.</td></tr>';
        return;
      }
      tbody.innerHTML = touches.slice(0, 25).map(t => {
        const timeStr = t.t ? new Date(t.t).toLocaleTimeString('tr-TR') : '—';
        const heldBadge = t.held
          ? '<span class="text-emerald-400 font-semibold">TUTUNDU</span>'
          : '<span class="text-rose-400 font-semibold">KIRILDI</span>';

        return '<tr class="hover:bg-slate-900/50 transition">' +
          '<td class="py-2.5 px-3 font-bold text-white">' + escapeHtml(t.symbol) + '</td>' +
          '<td class="py-2.5 px-3 text-slate-300">' + escapeHtml(t.name) + '</td>' +
          '<td class="py-2.5 px-3 tabular text-slate-400">$' + (Number.isFinite(Number(t.value)) && t.value != null ? Number(t.value).toFixed(4) : '—') + '</td>' +
          '<td class="py-2.5 px-3 tabular text-slate-400">' + (Math.floor(Number(t.hits)) || 1) + '</td>' +
          '<td class="py-2.5 px-3 text-right tabular text-slate-300">%' + (Number.isFinite(Number(t.pb)) ? Number(t.pb).toFixed(2) : '0.00') + '</td>' +
          '<td class="py-2.5 px-3 text-right">' + heldBadge + '</td>' +
          '<td class="py-2.5 px-3 text-right text-slate-500">' + timeStr + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderHealth(st) {
      const box = document.getElementById('health-rows');
      const badge = document.getElementById('hl-badge');
      const h = st.health;
      if (!box) return;
      if (!h) { box.innerHTML = '<div class="text-slate-500">Motor henüz başlamadı.</div>'; return; }
      const ws = st.websocket || {};
      const sec = ms => ms == null ? '—' : (ms / 1000).toFixed(1) + ' sn';
      const lat = (h.latency.last5m && h.latency.last5m.candles) ? h.latency.last5m : h.latency.current;
      const g = h.gapFill || {}, sd = h.seed || {};
      const row = (label, value, cls) => '<div class="flex justify-between gap-3 py-1 border-b border-slate-800/40"><span class="text-slate-400">' + escapeHtml(label) +
        '</span><span class="font-semibold tabular text-right ' + (cls || 'text-white') + '">' + escapeHtml(value) + '</span></div>';
      const bad = h.stale.count > 0 || h.recovery.blocked > 0 || (ws.connections && ws.open < ws.connections);
      if (badge) { badge.textContent = bad ? '⚠ Dikkat' : '● Sağlıklı'; badge.className = 'text-[10px] font-mono ' + (bad ? 'text-amber-400' : 'text-emerald-400'); }
      box.innerHTML =
        row('WebSocket:', (ws.open ?? 0) + '/' + (ws.connections ?? 0) + ' bağlı · ' + (ws.streams ?? 0) + ' stream', ws.connections && ws.open < ws.connections ? 'text-rose-400' : 'text-emerald-400') +
        row('Yeniden bağlanma:', String(ws.reconnects ?? 0), ws.reconnects ? 'text-amber-400' : 'text-slate-300') +
        row('1m mum gecikmesi (ort / maks):', sec(lat.lagAvgMs) + ' / ' + sec(lat.lagMaxMs), lat.lagMaxMs > 60000 ? 'text-rose-400' : (lat.lagMaxMs > 20000 ? 'text-amber-400' : 'text-slate-200')) +
        row('Hazır / izlenen coin:', h.ready + ' / ' + h.coins + (h.loading ? ' · ' + h.loading + ' yükleniyor' : '')) +
        row('Geride (3 dk mum yok):', h.stale.count + (h.stale.count ? ' · ' + h.stale.sample.slice(0, 4).join(', ') : ''), h.stale.count ? 'text-amber-400' : 'text-emerald-400') +
        row('Kurtarmada (sinyal kilidi):', String(h.recovery.blocked), h.recovery.blocked ? 'text-amber-400' : 'text-emerald-400') +
        row('Son boşluk doldurma:', g.runs ? (g.lastRecoveredCandles + ' mum · ' + (g.lastIncomplete || 0) + ' eksik · ' + (g.lastStale || 0) + ' eski · ' + (g.lastFailures || 0) + ' hata') : 'yok', (g.lastIncomplete || g.lastStale || g.lastFailures) ? 'text-amber-400' : 'text-slate-300') +
        row('Son tohumlama:', sd.runs ? (sd.lastSymbols + ' coin · ' + Math.round((sd.lastDurationMs || 0) / 1000) + ' sn · ' + (sd.lastFailures || 0) + ' hata') : 'yok', sd.lastFailures ? 'text-amber-400' : 'text-slate-300');
    }

    function renderSettings(s, defs) {
      const box = document.getElementById('settings-table');
      if (!box) return;
      const known = new Set(defs.map(d => d.key));
      const rows = defs.filter(d => d.key in s).map(d => [d.label, s[d.key], d.type])
        .concat(Object.keys(s).filter(k => !known.has(k)).map(k => [k, s[k], typeof s[k]]));
      box.innerHTML = rows.map(([label, v, type]) => {
        const shown = type === 'bool' || typeof v === 'boolean' ? (v ? 'açık' : 'kapalı') : (v && typeof v === 'object' ? JSON.stringify(v) : v);
        return '<div class="flex justify-between gap-4 py-1.5"><span class="text-slate-400">' + escapeHtml(label) + '</span>' +
          '<span class="text-white font-semibold text-right">' + escapeHtml(shown) + '</span></div>';
      }).join('');
    }


    function copyCode(id) {
      const text = document.getElementById(id).textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      }
      showToast('Kod panoya kopyalandı!', 'success');
    }

    const wh = document.getElementById('webhook-url');
    if (wh) wh.textContent = window.location.origin + '/api/external-bots/heartbeat';

    fetchData();
    setInterval(fetchData, 3000);
    loadLogDays();
    setInterval(loadLogDays, 60000);
  </script>
</body>
</html>
`);
});

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
