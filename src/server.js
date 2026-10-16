'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const infoBot = require('./infoBot');
const binance = require('./binanceClient');
const telegram = require('./telegram');
const cfg = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());

const { createAdminAuth } = require('./adminAuth');
const adminAuth = createAdminAuth({ telegram });
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const result = await adminAuth.requestCode(String(req.body?.userId || ''));
    res.status(result.ok ? 202 : 503).json(result);
  } catch (err) {
    console.error('[AUTH] Telegram doğrulama kodu gönderilemedi:', err.message);
    res.status(503).json({ ok: false, error: 'Telegram üzerinden kod gönderilemedi. Yapılandırmayı kontrol edin.' });
  }
});
app.post('/api/auth/verify', (req, res) => {
  const result = await adminAuth.verifyCode(String(req.body?.userId || ''), String(req.body?.code || ''));
  if (!result) return res.status(401).json({ ok: false, error: 'Kod geçersiz, süresi dolmuş veya kullanım sınırına ulaşmış.' });
  adminAuth.setCookie(res, result.token);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, userId: result.userId, expiresAt: result.expiresAt });
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
app.use(adminAuth.middleware);

const startedAt = Date.now();
let botStarted = false;
let botError = null;

// ── Sistem Hata & Günlük Kayıt Deposu ───────────────────────────────────────
const logsBuffer = [];
const MAX_LOGS = 500;
let errorCount = 0;
let warnCount = 0;

function addLog(level, args) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');

  const tagMatch = msg.match(/^\[([A-Za-z0-9#_.-]+)\]/);
  const tag = tagMatch ? tagMatch[1] : (level === 'error' ? 'HATA' : (level === 'warn' ? 'UYARI' : 'SİSTEM'));

  if (level === 'error') errorCount++;
  if (level === 'warn') warnCount++;

  logsBuffer.unshift({
    id: Date.now() + Math.random(),
    t: Date.now(),
    level,
    tag,
    message: msg
  });
  if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();
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

app.post('/api/external-bots/heartbeat', (req, res) => {
  const { id, name, telegram: tg, status, lastSignal, metrics, error } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: 'id alanı zorunludur' });

  if (error) {
    console.error(`[HARİCİ BOT] ${name || id} hatası: ${error}`);
  }

  const existing = externalBots.get(id) || { id, type: 'remote', registeredAt: Date.now() };
  externalBots.set(id, {
    ...existing,
    id,
    name: name || existing.name || id,
    telegram: tg || existing.telegram || '—',
    status: error ? 'error' : (status || 'online'),
    lastSignal: lastSignal || existing.lastSignal || '—',
    metrics: metrics || existing.metrics || {},
    lastError: error || null,
    lastSeen: Date.now()
  });

  res.json({ ok: true, message: 'Heartbeat kaydedildi' });
});

app.post('/api/external-bots/register', (req, res) => {
  const { id, name, telegram: tg, type = 'remote' } = req.body;
  if (!id || !name) return res.status(400).json({ ok: false, error: 'id ve name zorunludur' });

  externalBots.set(id, {
    id,
    name,
    type,
    telegram: tg || '—',
    status: 'pending',
    lastSeen: 0,
    lastSignal: 'Bağlantı bekleniyor...',
    metrics: {},
    registeredAt: Date.now()
  });

  res.json({ ok: true, bot: externalBots.get(id) });
});

app.delete('/api/external-bots/:id', (req, res) => {
  if (req.params.id === 'scalp-primary') {
    return res.status(400).json({ ok: false, error: 'Yerel bot kaldırılamaz' });
  }
  externalBots.delete(req.params.id);
  res.json({ ok: true });
});

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

app.post('/api/logs/clear', (req, res) => {
  logsBuffer.length = 0;
  errorCount = 0;
  warnCount = 0;
  res.json({ ok: true });
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
  res.json({ ok: true, settings: s });
});

app.post('/api/settings', (req, res) => {
  const internal = infoBot._internal || {};
  if (!internal.settings) return res.status(500).json({ ok: false, error: 'Ayar motoru henüz yüklenmedi' });
  try {
    const s = internal.settings.set(req.body);
    res.json({ ok: true, settings: s });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
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
    const limit = Math.min(Number(req.query.limit || 50), 100);
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

app.post('/api/run-tests', (req, res) => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', TELEGRAM_OPTIONAL: '1' },
  });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  child.on('close', code => {
    if (code !== 0) {
      console.error(`[TEST] Test paketi başarısız oldu (Çıkış kodu: ${code})`);
    } else {
      console.log('[TEST] Tüm testler başarıyla geçti');
    }
    res.json({
      ok: code === 0,
      exitCode: code,
      output,
    });
  });
});

app.post('/api/notify-panel', async (req, res) => {
  try {
    const { notifyWebPanelToAdmins } = require('./webUrl');
    const note = req.body?.note || 'Web Yönetici Paneli Üzerinden İletildi';
    const result = await notifyWebPanelToAdmins(telegram, {
      note,
      triggeredBy: 'Web Paneli (Admin Arayüzü)'
    });
    res.json({
      ok: true,
      message: `Web paneli adresi (${result.url}) Telegram grubuna ve ${result.adminCount} yöneticiye başarıyla iletildi!`,
      ...result
    });
  } catch (err) {
    console.error('[API] /api/notify-panel hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HTML Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
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
  </style>
</head>
<body class="min-h-screen flex flex-col font-sans selection:bg-amber-500/20 selection:text-amber-300">

  <!-- Top Bar Contract -->
  <header class="border-b hairline-border glass-panel sticky top-0 z-50">
    <div class="max-w-[1520px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
      
      <!-- Zone 1: Brand Wordmark -->
      <div class="flex items-center gap-3 shrink-0">
        <div class="w-8 h-8 rounded bg-gradient-to-br from-amber-500/20 to-amber-600/5 border border-amber-500/30 flex items-center justify-center text-amber-400 font-mono font-bold text-sm shadow-sm">
          ⚡
        </div>
        <div>
          <span class="text-sm font-bold tracking-tight text-white font-mono uppercase">Scalp Engine</span>
          <span class="hidden sm:inline text-xs text-slate-500 ml-2">Terminal v2.5</span>
        </div>
      </div>

      <!-- Zone 2: Navigation Links -->
      <nav class="hidden md:flex items-center gap-6 text-xs font-semibold tracking-wide text-slate-400">
        <button onclick="switchTab('tab-hub')" id="nav-tab-hub" class="text-white border-b-2 border-amber-500 pb-1 pt-1 transition whitespace-nowrap shrink-0">
          Bot Merkezi (<span id="bot-count-nav" class="font-mono">1</span>)
        </button>
        <button onclick="switchTab('tab-terminal')" id="nav-tab-terminal" class="hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0">
          Sinyal Akışı & Kartlar
        </button>
        <button onclick="switchTab('tab-levels')" id="nav-tab-levels" class="hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0">
          Direnç Kayıtları
        </button>
        <button onclick="switchTab('tab-integration')" id="nav-tab-integration" class="hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0">
          API & Webhook
        </button>
        <button onclick="switchTab('tab-settings')" id="nav-tab-settings" class="hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0">
          Ayarlar
        </button>
        <button onclick="switchTab('tab-logs')" id="nav-tab-logs" class="hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0 flex items-center gap-1.5">
          <span>Hata & Olay Günlüğü</span>
          <span id="nav-error-badge" class="hidden text-[10px] font-mono px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30">0</span>
        </button>
      </nav>

      <!-- Zone 3: Primary Actions -->
      <div class="flex items-center gap-2.5 shrink-0">
        <button onclick="switchTab('tab-logs')" id="status-quick-btn" class="hidden sm:flex items-center gap-2 text-[11px] font-mono bg-obsidian-900 border hairline-border px-2.5 py-1.5 rounded hover:border-slate-600 transition">
          <span id="quick-err-dot" class="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span id="quick-err-text">0 Hata</span>
        </button>
        <button onclick="notifyTelegramPanel()" id="btn-notify-tg" class="text-xs font-semibold px-3 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white font-mono tracking-tight transition flex items-center gap-1.5 shadow-sm whitespace-nowrap shrink-0 border border-sky-400/30" title="Web paneli adresini Telegram grubuna ve adminlere ilet">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
          <span id="btn-notify-tg-text">Telegram'a İlet</span>
        </button>
        <button onclick="runTests()" class="text-xs font-semibold px-3.5 py-2 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-mono tracking-tight transition flex items-center gap-1.5 shadow-sm whitespace-nowrap shrink-0">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path></svg>
          Testleri Çalıştır
        </button>
      </div>

    </div>
  </header>

  <!-- Mobile Secondary Navigation -->
  <div class="md:hidden border-b hairline-border bg-obsidian-900 px-4 py-2.5 flex items-center justify-between text-xs overflow-x-auto gap-4">
    <button onclick="switchTab('tab-hub')" class="text-amber-400 font-semibold whitespace-nowrap">Bot Merkezi</button>
    <button onclick="switchTab('tab-terminal')" class="text-slate-400 whitespace-nowrap">Sinyaller</button>
    <button onclick="switchTab('tab-levels')" class="text-slate-400 whitespace-nowrap">Dirençler</button>
    <button onclick="switchTab('tab-integration')" class="text-slate-400 whitespace-nowrap">API</button>
    <button onclick="switchTab('tab-settings')" class="text-slate-400 whitespace-nowrap">Ayarlar</button>
    <button onclick="switchTab('tab-logs')" class="text-rose-400 whitespace-nowrap font-semibold">Hata Logları</button>
  </div>

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
        <div class="flex items-center gap-3">
          <button onclick="openAddBotModal()" class="text-xs font-semibold px-3.5 py-2 rounded bg-slate-800 hover:bg-slate-700 text-white border hairline-border transition flex items-center gap-1.5 whitespace-nowrap">
            <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
            Harici Bot Ekle
          </button>
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
              <button onclick="switchTab('tab-settings')" class="text-[11px] text-amber-400 hover:text-amber-300">Düzenle</button>
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
              <button onclick="setLogLevel('all')" id="log-filter-all" class="px-2.5 py-1 rounded bg-slate-800 text-white font-bold transition">Tümü</button>
              <button onclick="setLogLevel('error')" id="log-filter-error" class="px-2.5 py-1 rounded text-rose-400 hover:text-white transition">Hatalar</button>
              <button onclick="setLogLevel('warn')" id="log-filter-warn" class="px-2.5 py-1 rounded text-amber-400 hover:text-white transition">Uyarılar</button>
              <button onclick="setLogLevel('info')" id="log-filter-info" class="px-2.5 py-1 rounded text-slate-400 hover:text-white transition">Sistem</button>
            </div>

            <!-- Search in logs -->
            <input type="text" id="log-search" oninput="filterLogView()" placeholder="Loglarda ara..." class="w-40 bg-obsidian-950 border hairline-border rounded px-2.5 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500/50 font-mono">

            <button onclick="clearLogs()" class="text-xs font-mono px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border hairline-border transition">
              Temizle
            </button>
            <button onclick="copyAllLogs()" class="text-xs font-mono px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border hairline-border transition">
              Kopyala
            </button>
          </div>
        </div>

        <!-- Terminal Console View -->
        <div class="bg-obsidian-950 border hairline-border rounded-lg p-3 font-mono text-xs overflow-hidden flex flex-col">
          <div class="flex items-center justify-between text-[11px] text-slate-500 border-b hairline-border pb-2 mb-2 px-1">
            <span class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>Canlı Log Akışı</span>
            </span>
            <span class="text-slate-600">Maksimum 500 olay tamponlanır</span>
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
      <div class="glass-panel p-6 rounded-lg max-w-3xl space-y-6">
        <div>
          <h2 class="text-sm font-bold text-white uppercase font-mono tracking-tight">Scalp Motoru Parametre Yapılandırması</h2>
          <p class="text-xs text-slate-400 mt-1">Bu ayarlar çalışan motorda anında güncellenir ve yeni sinyallere derhal yansıtılır.</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
          <div>
            <label class="block text-slate-400 mb-1 font-medium">Asgari RSI Eşiği</label>
            <input type="number" id="setting-rsi" min="70" max="95" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
            <span class="text-[11px] text-slate-500 mt-1 block">3m, 5m veya 15m dilimlerinde aranan eşik (Varsayılan: 85).</span>
          </div>

          <div>
            <label class="block text-slate-400 mb-1 font-medium">Direnç Uzaklığı Maks %</label>
            <input type="number" step="0.1" id="setting-level" min="0.5" max="5.0" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
            <span class="text-[11px] text-slate-500 mt-1 block">Fiyatın direnç seviyesine olan azami mesafesi (Varsayılan: 2.5).</span>
          </div>

          <div>
            <label class="block text-slate-400 mb-1 font-medium">Patlama Yüzdesi (% kademe 1)</label>
            <input type="number" step="0.1" id="setting-burst1" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
            <span class="text-[11px] text-slate-500 mt-1 block">Hacimli 1 dakikalık mum boyutu (Varsayılan: 1.0).</span>
          </div>

          <div>
            <label class="block text-slate-400 mb-1 font-medium">Asgari 24s Hacim (Milyon $)</label>
            <input type="number" id="setting-vol" min="1" max="50" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
            <span class="text-[11px] text-slate-500 mt-1 block">Evrene alınacak pariteler için filtre (Varsayılan: 3).</span>
          </div>
        </div>

        <div class="flex items-center justify-between pt-4 border-t hairline-border">
          <span id="save-status" class="text-xs font-mono text-emerald-400"></span>
          <button onclick="saveSettings()" class="text-xs font-semibold px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-mono transition">
            Ayarları Kaydet
          </button>
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
        requests.post(HUB_URL, json=payload, timeout=5)
    except Exception as e:
        print("Heartbeat gönderilemedi:", e)

# Hata yakalandığında paneli haberdar edin:
# report_status(error_msg="Binance API 451 Bölge Hatası")</pre>
        </div>
      </div>
    </div>

  </main>

  <!-- Add Bot Modal -->
  <div id="add-bot-modal" class="hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="glass-panel border hairline-border rounded-lg max-w-md w-full p-6 space-y-4 shadow-2xl">
      <div class="flex items-center justify-between border-b hairline-border pb-3">
        <h3 class="font-bold text-white text-sm font-mono uppercase tracking-tight">Yeni Harici Bot Ekle</h3>
        <button onclick="closeAddBotModal()" class="text-slate-400 hover:text-white">&times;</button>
      </div>
      <div class="space-y-3.5 text-xs">
        <div>
          <label class="block text-slate-400 mb-1 font-medium">Bot Kimliği (ID)</label>
          <input id="input-bot-id" placeholder="ornek: trend-bot-1" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
        </div>
        <div>
          <label class="block text-slate-400 mb-1 font-medium">Bot Adı</label>
          <input id="input-bot-name" placeholder="Örn: BTC Trend Takipçisi" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white focus:border-amber-500/50 outline-none">
        </div>
        <div>
          <label class="block text-slate-400 mb-1 font-medium">Telegram Kullanıcı Adı</label>
          <input id="input-bot-tg" placeholder="@BtcTrendBot" class="w-full bg-obsidian-950 border hairline-border rounded p-2.5 text-white font-mono focus:border-amber-500/50 outline-none">
        </div>
      </div>
      <div class="flex justify-end gap-2.5 pt-3 border-t hairline-border">
        <button onclick="closeAddBotModal()" class="px-3.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-white">İptal</button>
        <button onclick="saveNewBot()" class="px-4 py-1.5 rounded bg-amber-500 hover:bg-amber-400 font-bold text-xs text-slate-950 font-mono">Kaydet</button>
      </div>
    </div>
  </div>

  <!-- Test Modal -->
  <div id="test-modal" class="hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="glass-panel border hairline-border rounded-lg max-w-2xl w-full p-6 space-y-4 shadow-2xl">
      <div class="flex items-center justify-between border-b hairline-border pb-3">
        <h3 class="font-bold text-white text-sm font-mono flex items-center gap-2">
          <span>Test Paketi Yürütücüsü (test/run.js)</span>
          <span id="test-spinner" class="hidden w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></span>
        </h3>
        <button onclick="closeTestModal()" class="text-slate-400 hover:text-white">&times;</button>
      </div>
      <div class="bg-obsidian-950 rounded p-4 font-mono text-xs text-slate-300 max-h-96 overflow-y-auto whitespace-pre-wrap leading-relaxed" id="test-output">
        Test başlatılıyor...
      </div>
      <div class="flex justify-end">
        <button onclick="closeTestModal()" class="px-4 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-white font-mono">Kapat</button>
      </div>
    </div>
  </div>

  <script>
    let allCardsData = [];
    let currentLogLevel = 'all';
    let allLogsData = [];

    function switchTab(tabId) {
      ['tab-hub', 'tab-terminal', 'tab-logs', 'tab-levels', 'tab-settings', 'tab-integration'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
      });
      document.getElementById(tabId).classList.remove('hidden');

      ['nav-tab-hub', 'nav-tab-terminal', 'nav-tab-logs', 'nav-tab-levels', 'nav-tab-settings', 'nav-tab-integration'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.className = "hover:text-slate-200 border-b-2 border-transparent pb-1 pt-1 transition whitespace-nowrap shrink-0 flex items-center gap-1.5";
      });
      const activeBtn = document.getElementById('nav-' + tabId);
      if (activeBtn) activeBtn.className = "text-white border-b-2 border-amber-500 pb-1 pt-1 transition whitespace-nowrap shrink-0 font-bold flex items-center gap-1.5";
    }

    async function fetchData() {
      try {
        const [resBots, resStatus, resSettings, resCards, resTouches, resLogs] = await Promise.all([
          fetch('/api/external-bots').then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/status').then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/settings').then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/cards?limit=30').then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/touches').then(r => r.json()).catch(() => ({ ok: false })),
          fetch('/api/logs').then(r => r.json()).catch(() => ({ ok: false })),
        ]);

        if (resBots.ok && resBots.bots) {
          renderBots(resBots.bots);
          document.getElementById('bot-count-nav').textContent = resBots.bots.length;
        }

        if (resLogs.ok) {
          allLogsData = resLogs.logs || [];
          document.getElementById('log-count-badge').textContent = resLogs.total + ' kayıt';
          renderLogs(allLogsData);

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

        if (resSettings.ok && resSettings.settings) {
          const s = resSettings.settings;
          document.getElementById('cfg-rsi').textContent = '≥ ' + s.rsiMin + ' (' + s.minTFs + '/3 TF)';
          document.getElementById('cfg-level').textContent = '≤ %' + s.levelMaxPct;
          document.getElementById('cfg-burst').textContent = '%' + s.burstPct1 + ' / %' + s.burstPct2 + ' (×' + s.volMult + ')';
          document.getElementById('cfg-vol').textContent = '≥ ' + s.minVolumeM + 'M $';

          if (!document.getElementById('setting-rsi').value) {
            document.getElementById('setting-rsi').value = s.rsiMin;
            document.getElementById('setting-level').value = s.levelMaxPct;
            document.getElementById('setting-burst1').value = s.burstPct1;
            document.getElementById('setting-vol').value = s.minVolumeM;
          }
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

    function setLogLevel(lvl) {
      currentLogLevel = lvl;
      ['all', 'error', 'warn', 'info'].forEach(k => {
        const b = document.getElementById('log-filter-' + k);
        if (b) b.className = "px-2.5 py-1 rounded text-slate-400 hover:text-white transition";
      });
      const activeBtn = document.getElementById('log-filter-' + lvl);
      if (activeBtn) activeBtn.className = "px-2.5 py-1 rounded bg-slate-800 text-white font-bold transition";
      renderLogs(allLogsData);
    }

    function filterLogView() {
      renderLogs(allLogsData);
    }

    async function clearLogs() {
      await fetch('/api/logs/clear', { method: 'POST' });
      allLogsData = [];
      renderLogs([]);
      fetchData();
    }

    function copyAllLogs() {
      const text = allLogsData.map(l => '[' + new Date(l.t).toLocaleTimeString('tr-TR') + '] [' + l.level.toUpperCase() + '] [' + l.tag + '] ' + l.message).join('\\n');
      navigator.clipboard.writeText(text);
      alert('Tüm loglar panoya kopyalandı!');
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
            (b.type !== 'local' ? '<button type="button" data-delete-bot="' + escapeHtml(b.id) + '" class="text-rose-400 hover:text-rose-300">Kaldır</button>' : '<span class="text-slate-600">Sistem Servisi</span>') +
          '</div>' +
        '</div>';
      }).join('');
      container.querySelectorAll('[data-delete-bot]').forEach(button => {
        button.addEventListener('click', () => deleteBot(button.dataset.deleteBot));
      });
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
              '<div class="font-mono text-sm text-white font-bold tabular">
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
          '<td class="py-2.5 px-3 tabular text-slate-400">$' + (t.value ? t.value.toFixed(4) : '—') + '</td>' +
          '<td class="py-2.5 px-3 tabular text-slate-400">' + (t.hits || 1) + '</td>' +
          '<td class="py-2.5 px-3 text-right tabular text-slate-300">%' + (t.pb ? t.pb.toFixed(2) : '0.00') + '</td>' +
          '<td class="py-2.5 px-3 text-right">' + heldBadge + '</td>' +
          '<td class="py-2.5 px-3 text-right text-slate-500">' + timeStr + '</td>' +
        '</tr>';
      }).join('');
    }

    async function saveSettings() {
      const rsi = Number(document.getElementById('setting-rsi').value);
      const level = Number(document.getElementById('setting-level').value);
      const burst1 = Number(document.getElementById('setting-burst1').value);
      const vol = Number(document.getElementById('setting-vol').value);
      const statusEl = document.getElementById('save-status');

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rsiMin: rsi, levelMaxPct: level, burstPct1: burst1, minVolumeM: vol })
        }).then(r => r.json());

        if (res.ok) {
          statusEl.textContent = '✓ Ayarlar başarıyla güncellendi';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
          fetchData();
        } else {
          statusEl.textContent = 'Hata: ' + res.error;
        }
      } catch (err) {
        statusEl.textContent = 'İletişim hatası';
      }
    }

    function openAddBotModal() { document.getElementById('add-bot-modal').classList.remove('hidden'); }
    function closeAddBotModal() { document.getElementById('add-bot-modal').classList.add('hidden'); }

    async function saveNewBot() {
      const id = document.getElementById('input-bot-id').value.trim();
      const name = document.getElementById('input-bot-name').value.trim();
      const tg = document.getElementById('input-bot-tg').value.trim();
      if (!id || !name) return alert('Lütfen ID ve Ad giriniz');

      await fetch('/api/external-bots/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, telegram: tg })
      });
      closeAddBotModal();
      fetchData();
    }

    async function deleteBot(id) {
      if (!confirm('Bu harici botu kaldırmak istediğinize emin misiniz?')) return;
      await fetch('/api/external-bots/' + id, { method: 'DELETE' });
      fetchData();
    }

    async function runTests() {
      const modal = document.getElementById('test-modal');
      const out = document.getElementById('test-output');
      const spinner = document.getElementById('test-spinner');
      modal.classList.remove('hidden');
      spinner.classList.remove('hidden');
      out.textContent = 'Test paketi yürütülüyor (test/run.js)... Lütfen bekleyin...\\n';

      try {
        const res = await fetch('/api/run-tests', { method: 'POST' }).then(r => r.json());
        spinner.classList.add('hidden');
        out.textContent = res.output || (res.ok ? 'Tüm testler başarıyla geçti!' : 'Testler başarısız oldu.');
      } catch (err) {
        spinner.classList.add('hidden');
        out.textContent = 'Hata: ' + err.message;
      }
    }
    function closeTestModal() { document.getElementById('test-modal').classList.add('hidden'); }

    function copyCode(id) {
      const text = document.getElementById(id).textContent;
      navigator.clipboard.writeText(text);
      alert('Kod panoya kopyalandı!');
    }

    async function notifyTelegramPanel() {
      const btn = document.getElementById('btn-notify-tg');
      const txt = document.getElementById('btn-notify-tg-text');
      const origText = txt.textContent;
      btn.disabled = true;
      txt.textContent = 'İletiliyor...';
      try {
        const res = await fetch('/api/notify-panel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Web Paneli Üzerinden İletildi' })
        }).then(r => r.json());
        if (res.ok) {
          alert('✅ Başarılı!\nWeb paneli adresi (' + res.url + ') Telegram grubuna ve ' + res.adminCount + ' yöneticiye iletildi.');
        } else {
          alert('Hata: ' + (res.error || 'İletilemedi'));
        }
      } catch (err) {
        alert('Ağ Hatası: ' + err.message);
      } finally {
        btn.disabled = false;
        txt.textContent = origText;
      }
    }

    document.getElementById('webhook-url').textContent = window.location.origin + '/api/external-bots/heartbeat';

    fetchData();
    setInterval(fetchData, 3000);
  </script>
</body>
</html>
`);
});

// Sunucuyu 0.0.0.0:3000 üzerinde dinle
const server = app.listen(PORT, HOST, () => {
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

module.exports = app;
 + escapeHtml(price) + '</div>' +
              '<div class="text-[10px] text-slate-500 font-mono">' + timeStr + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="grid grid-cols-3 gap-3 text-xs font-mono bg-obsidian-950 p-2.5 rounded border hairline-border">' +
            '<div><span class="text-slate-500">RSI:</span> <span class="text-amber-400 font-semibold">' + (d.rsi?.val || d.rsi15 || '—') + '</span></div>' +
            '<div><span class="text-slate-500">Direnç:</span> <span class="text-sky-400 font-semibold truncate">' + (d.level?.name || 'Tespit Edildi') + '</span></div>' +
            '<div><span class="text-slate-500">EMA Gap:</span> <span class="text-slate-200">' + (d.emaGap != null ? '%' + d.emaGap : '—') + '</span></div>' +
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
          '<td class="py-2.5 px-3 font-bold text-white">' + t.symbol + '</td>' +
          '<td class="py-2.5 px-3 text-slate-300">' + t.name + '</td>' +
          '<td class="py-2.5 px-3 tabular text-slate-400">$' + (t.value ? t.value.toFixed(4) : '—') + '</td>' +
          '<td class="py-2.5 px-3 tabular text-slate-400">' + (t.hits || 1) + '</td>' +
          '<td class="py-2.5 px-3 text-right tabular text-slate-300">%' + (t.pb ? t.pb.toFixed(2) : '0.00') + '</td>' +
          '<td class="py-2.5 px-3 text-right">' + heldBadge + '</td>' +
          '<td class="py-2.5 px-3 text-right text-slate-500">' + timeStr + '</td>' +
        '</tr>';
      }).join('');
    }

    async function saveSettings() {
      const rsi = Number(document.getElementById('setting-rsi').value);
      const level = Number(document.getElementById('setting-level').value);
      const burst1 = Number(document.getElementById('setting-burst1').value);
      const vol = Number(document.getElementById('setting-vol').value);
      const statusEl = document.getElementById('save-status');

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rsiMin: rsi, levelMaxPct: level, burstPct1: burst1, minVolumeM: vol })
        }).then(r => r.json());

        if (res.ok) {
          statusEl.textContent = '✓ Ayarlar başarıyla güncellendi';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
          fetchData();
        } else {
          statusEl.textContent = 'Hata: ' + res.error;
        }
      } catch (err) {
        statusEl.textContent = 'İletişim hatası';
      }
    }

    function openAddBotModal() { document.getElementById('add-bot-modal').classList.remove('hidden'); }
    function closeAddBotModal() { document.getElementById('add-bot-modal').classList.add('hidden'); }

    async function saveNewBot() {
      const id = document.getElementById('input-bot-id').value.trim();
      const name = document.getElementById('input-bot-name').value.trim();
      const tg = document.getElementById('input-bot-tg').value.trim();
      if (!id || !name) return alert('Lütfen ID ve Ad giriniz');

      await fetch('/api/external-bots/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, telegram: tg })
      });
      closeAddBotModal();
      fetchData();
    }

    async function deleteBot(id) {
      if (!confirm('Bu harici botu kaldırmak istediğinize emin misiniz?')) return;
      await fetch('/api/external-bots/' + id, { method: 'DELETE' });
      fetchData();
    }

    async function runTests() {
      const modal = document.getElementById('test-modal');
      const out = document.getElementById('test-output');
      const spinner = document.getElementById('test-spinner');
      modal.classList.remove('hidden');
      spinner.classList.remove('hidden');
      out.textContent = 'Test paketi yürütülüyor (test/run.js)... Lütfen bekleyin...\\n';

      try {
        const res = await fetch('/api/run-tests', { method: 'POST' }).then(r => r.json());
        spinner.classList.add('hidden');
        out.textContent = res.output || (res.ok ? 'Tüm testler başarıyla geçti!' : 'Testler başarısız oldu.');
      } catch (err) {
        spinner.classList.add('hidden');
        out.textContent = 'Hata: ' + err.message;
      }
    }
    function closeTestModal() { document.getElementById('test-modal').classList.add('hidden'); }

    function copyCode(id) {
      const text = document.getElementById(id).textContent;
      navigator.clipboard.writeText(text);
      alert('Kod panoya kopyalandı!');
    }

    async function notifyTelegramPanel() {
      const btn = document.getElementById('btn-notify-tg');
      const txt = document.getElementById('btn-notify-tg-text');
      const origText = txt.textContent;
      btn.disabled = true;
      txt.textContent = 'İletiliyor...';
      try {
        const res = await fetch('/api/notify-panel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Web Paneli Üzerinden İletildi' })
        }).then(r => r.json());
        if (res.ok) {
          alert('✅ Başarılı!\nWeb paneli adresi (' + res.url + ') Telegram grubuna ve ' + res.adminCount + ' yöneticiye iletildi.');
        } else {
          alert('Hata: ' + (res.error || 'İletilemedi'));
        }
      } catch (err) {
        alert('Ağ Hatası: ' + err.message);
      } finally {
        btn.disabled = false;
        txt.textContent = origText;
      }
    }

    document.getElementById('webhook-url').textContent = window.location.origin + '/api/external-bots/heartbeat';

    fetchData();
    setInterval(fetchData, 3000);
  </script>
</body>
</html>
`);
});

// Sunucuyu 0.0.0.0:3000 üzerinde dinle
const server = app.listen(PORT, HOST, () => {
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

module.exports = app;
