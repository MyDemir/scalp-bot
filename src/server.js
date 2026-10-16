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

const startedAt = Date.now();
let botStarted = false;
let botError = null;

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

// ── API Uç Noktaları ────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const internal = infoBot._internal || {};
  const tgStats = telegram.takeStats();
  const wsStats = binance.takeWsStats();
  const seriesMap = internal.series;
  const readyCount = seriesMap ? [...seriesMap.values()].filter(s => s.ready()).length : 0;
  const totalCount = seriesMap ? seriesMap.size : 0;

  const mem = process.memoryUsage();

  res.json({
    ok: true,
    botStarted,
    botError,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    statusText: internal.statusText ? internal.statusText() : 'Hazırlanıyor...',
    stats: internal.stats || {},
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
  if (!internal.settings) return res.status(500).json({ ok: false, error: 'Ayar motoru hazır değil' });
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
    // SQLite kapalıysa telegram dispatches veya boş dön
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
    res.json({
      ok: code === 0,
      exitCode: code,
      output,
    });
  });
});

// ── HTML Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scalp Sinyal Motoru — Canlı İzleme & Yönetim Paneli</title>
  <meta name="description" content="Binance USDT-M Futures bilgi/sınıflandırma botu (RSI + seviye + hacim sayacı) canlı paneli">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#f59e0b', 600: '#d97706' },
            darkbg: '#0f172a',
            darkcard: '#1e293b'
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body class="bg-[#0b0f19] text-slate-100 min-h-screen">
  <!-- Header -->
  <header class="border-b border-slate-800 bg-[#0f172a]/80 backdrop-blur sticky top-0 z-40">
    <div class="max-w-7xl mx-auto px-4 py-3 sm:px-6 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-lg border border-amber-500/30">
          ⚡
        </div>
        <div>
          <h1 class="text-lg font-bold tracking-tight text-white flex items-center gap-2">
            Scalp Sinyal Motoru
            <span id="badge-status" class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Canlı</span>
          </h1>
          <p class="text-xs text-slate-400">Binance USDT-M Futures · RSI & Seviye Motoru</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="runTests()" id="btn-tests" class="text-xs px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition">
          <svg class="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          Testleri Çalıştır
        </button>
        <button onclick="fetchData()" class="text-xs px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-600 text-slate-950 font-semibold transition">
          Yenile
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="max-w-7xl mx-auto px-4 py-6 sm:px-6 space-y-6">
    <!-- Stat Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">İzlenen Pariteler</div>
        <div class="text-xl font-bold text-white flex items-baseline gap-1.5">
          <span id="stat-pairs">-</span>
          <span class="text-xs text-emerald-400 font-normal" id="stat-ready">- hazır</span>
        </div>
      </div>
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">İşlenen Mumlar</div>
        <div class="text-xl font-bold text-white" id="stat-closes">-</div>
      </div>
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">Bugünkü Kartlar</div>
        <div class="text-xl font-bold text-amber-400" id="stat-cards">-</div>
      </div>
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">Tepe Uyarıları</div>
        <div class="text-xl font-bold text-sky-400" id="stat-peaks">-</div>
      </div>
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">Telegram Kuyruk</div>
        <div class="text-xl font-bold text-white flex items-baseline gap-1.5">
          <span id="stat-queue">0</span>
          <span class="text-xs text-slate-400 font-normal" id="stat-tg-dropped">0 düşen</span>
        </div>
      </div>
      <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5">
        <div class="text-xs text-slate-400 mb-1">Bellek (RSS)</div>
        <div class="text-xl font-bold text-slate-200" id="stat-mem">- MB</div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
        <span class="text-slate-300 font-medium">Sistem Durumu:</span>
        <span class="mono text-slate-400" id="system-status">Yükleniyor...</span>
      </div>
      <div class="flex items-center gap-4 text-slate-400">
        <div>Çalışma Süresi: <span id="val-uptime" class="text-slate-200 mono">-</span></div>
        <div>WebSocket: <span id="val-ws" class="text-emerald-400 mono">Aktif</span></div>
        <div>Telegram: <span id="val-tg" class="text-slate-200 mono">-</span></div>
      </div>
    </div>

    <!-- 2 Column Layout: Signals / Settings & Touches -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left 2 Cols: Live Cards & Signals -->
      <div class="lg:col-span-2 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <span>Canlı Sinyal & Kart Akışı</span>
            <span id="cards-count" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">0</span>
          </h2>
          <span class="text-xs text-slate-500">Otomatik yenilenir (5 sn)</span>
        </div>

        <div id="cards-container" class="space-y-3">
          <div class="p-8 text-center text-slate-500 bg-slate-900/50 rounded-xl border border-slate-800/80">
            Sinyal bekleniyor veya piyasa taranıyor...
          </div>
        </div>
      </div>

      <!-- Right 1 Col: Parameters & Recent Touches -->
      <div class="space-y-6">
        <!-- Parameters Widget -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <h3 class="text-xs font-bold uppercase tracking-wider text-slate-300">Aktif Parametreler</h3>
            <span class="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">RSI + Seviye</span>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs" id="settings-grid">
            <div class="bg-slate-800/50 p-2 rounded">
              <span class="text-slate-400 block text-[10px]">RSI Eşiği</span>
              <span class="font-bold text-white mono" id="cfg-rsi">-</span>
            </div>
            <div class="bg-slate-800/50 p-2 rounded">
              <span class="text-slate-400 block text-[10px]">Direnç Mesafesi</span>
              <span class="font-bold text-white mono" id="cfg-level">-</span>
            </div>
            <div class="bg-slate-800/50 p-2 rounded">
              <span class="text-slate-400 block text-[10px]">Patlama Çarpanı</span>
              <span class="font-bold text-white mono" id="cfg-burst">-</span>
            </div>
            <div class="bg-slate-800/50 p-2 rounded">
              <span class="text-slate-400 block text-[10px]">Min 24s Hacim</span>
              <span class="font-bold text-white mono" id="cfg-vol">-</span>
            </div>
          </div>
        </div>

        <!-- Resistance Touches Widget -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <h3 class="text-xs font-bold uppercase tracking-wider text-slate-300">Direnç Temasları & Tepkiler</h3>
            <span id="touches-count" class="text-[10px] text-slate-400">0</span>
          </div>
          <div id="touches-container" class="space-y-2 max-h-72 overflow-y-auto text-xs pr-1">
            <div class="text-slate-500 text-center py-4">Kayıtlı temas yok</div>
          </div>
        </div>

        <!-- Telegram Queue & Health -->
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <h3 class="text-xs font-bold uppercase tracking-wider text-slate-300">Telegram Bildirim Sağlığı</h3>
            <span class="text-[10px] text-sky-400">Kuyruk Koruma</span>
          </div>
          <div class="space-y-1.5 text-xs text-slate-300">
            <div class="flex justify-between py-1 border-b border-slate-800/50">
              <span class="text-slate-400">Gönderilen:</span>
              <span class="mono font-semibold" id="tg-sent">0</span>
            </div>
            <div class="flex justify-between py-1 border-b border-slate-800/50">
              <span class="text-slate-400">429 Hız Sınırı Yenileme:</span>
              <span class="mono text-amber-400 font-semibold" id="tg-429">0</span>
            </div>
            <div class="flex justify-between py-1 border-b border-slate-800/50">
              <span class="text-slate-400">Kuyruk Taşması Düşen (OOM koruması):</span>
              <span class="mono text-rose-400 font-semibold" id="tg-overflow">0</span>
            </div>
            <div class="flex justify-between py-1">
              <span class="text-slate-400">Zaman Aşımı Düşen (TTL):</span>
              <span class="mono text-slate-400 font-semibold" id="tg-expired">0</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Test Modal -->
    <div id="test-modal" class="hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full p-5 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="font-bold text-white flex items-center gap-2">
            <span>Test Paketi Çalıştırma</span>
            <span id="test-spinner" class="hidden w-3.5 h-3.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></span>
          </h3>
          <button onclick="closeTestModal()" class="text-slate-400 hover:text-white">&times;</button>
        </div>
        <div class="bg-slate-950 rounded-lg p-3 font-mono text-xs text-slate-300 max-h-96 overflow-y-auto whitespace-pre-wrap" id="test-output">
          Test başlatılıyor...
        </div>
        <div class="flex justify-end">
          <button onclick="closeTestModal()" class="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white">Kapat</button>
        </div>
      </div>
    </div>
  </main>

  <script>
    async function fetchData() {
      try {
        const [resStatus, resSettings, resCards, resTouches] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/settings').then(r => r.json()),
          fetch('/api/cards?limit=20').then(r => r.json()),
          fetch('/api/touches').then(r => r.json()),
        ]);

        if (resStatus.ok) {
          document.getElementById('stat-pairs').textContent = resStatus.market.totalPairs || 0;
          document.getElementById('stat-ready').textContent = (resStatus.market.readyPairs || 0) + ' hazır';
          document.getElementById('stat-closes').textContent = (resStatus.stats.closes || 0).toLocaleString();
          document.getElementById('stat-cards').textContent = resStatus.stats.cardsToday || resStatus.stats.cards || 0;
          document.getElementById('stat-peaks').textContent = resStatus.stats.peakAlerts || 0;
          document.getElementById('stat-queue').textContent = resStatus.telegram?.stats?.queued || 0;
          document.getElementById('stat-tg-dropped').textContent = ((resStatus.telegram?.stats?.droppedOverflow || 0) + (resStatus.telegram?.stats?.droppedExpired || 0)) + ' düşen';
          document.getElementById('stat-mem').textContent = (resStatus.memory?.rssMb || '-') + ' MB';
          document.getElementById('system-status').textContent = resStatus.statusText || 'Normal';

          const up = resStatus.uptimeSeconds || 0;
          const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = up % 60;
          document.getElementById('val-uptime').textContent = (h > 0 ? h + 's ' : '') + m + 'd ' + s + 'sn';
          document.getElementById('val-tg').textContent = resStatus.telegram?.username ? '@' + resStatus.telegram.username : (resStatus.telegram?.polling ? 'Aktif' : 'Web/Yerel');

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
          document.getElementById('cfg-level').textContent = '≤ %' + s.levelMaxPct + (s.levelRequired ? ' (zorunlu)' : '');
          document.getElementById('cfg-burst').textContent = '%' + s.burstPct1 + ' / %' + s.burstPct2 + ' (×' + s.volMult + ')';
          document.getElementById('cfg-vol').textContent = '≥ ' + s.minVolumeM + 'M $';
        }

        if (resCards.ok && resCards.cards) {
          renderCards(resCards.cards);
        }

        if (resTouches.ok && resTouches.touches) {
          renderTouches(resTouches.touches);
        }
      } catch (err) {
        console.error('Veri çekilemedi:', err);
      }
    }

    function renderCards(cards) {
      const container = document.getElementById('cards-container');
      document.getElementById('cards-count').textContent = cards.length;
      if (!cards.length) {
        container.innerHTML = '<div class="p-8 text-center text-slate-500 bg-slate-900/50 rounded-xl border border-slate-800/80">Henüz üretilen kart yok. Bot piyasayı izliyor...</div>';
        return;
      }

      container.innerHTML = cards.map(c => {
        const d = c.data ? (typeof c.data === 'string' ? JSON.parse(c.data || '{}') : c.data) : c;
        const sym = c.symbol || d.symbol || 'PARİTE';
        const price = c.price || d.price || '-';
        const grade = d.grade || 1;
        const timeStr = c.t ? new Date(c.t).toLocaleTimeString('tr-TR') : '';

        return '<div class="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition space-y-2.5">' +
          '<div class="flex items-center justify-between">' +
            '<div class="flex items-center gap-2">' +
              '<span class="font-bold text-white text-base">' + sym + '</span>' +
              '<span class="text-xs px-2 py-0.5 rounded font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">' + (d.burst?.dir === 'buy' ? '🟢 ALIM PATLAMASI' : '🔴 SATIŞ / DİRENÇ') + '</span>' +
              '<span class="text-xs text-slate-400 mono">' + '●'.repeat(grade) + '</span>' +
            '</div>' +
            '<div class="text-right">' +
              '<div class="font-mono text-sm text-white font-semibold">$' + price + '</div>' +
              '<div class="text-[10px] text-slate-500">' + timeStr + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="text-xs text-slate-300 font-mono bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/60 flex flex-wrap gap-x-4 gap-y-1">' +
            '<div>RSI: <span class="text-amber-400">' + (d.rsi?.val || '-') + '</span></div>' +
            '<div>Seviye: <span class="text-sky-400">' + (d.level?.name || 'Yok') + '</span></div>' +
            '<div>EMA Ayrışma: <span class="text-slate-200">' + (d.emaGap != null ? '%' + d.emaGap : '-') + '</span></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderTouches(touches) {
      const container = document.getElementById('touches-container');
      document.getElementById('touches-count').textContent = touches.length;
      if (!touches.length) {
        container.innerHTML = '<div class="text-slate-500 text-center py-4">Kayıtlı temas yok</div>';
        return;
      }
      container.innerHTML = touches.slice(0, 15).map(t => {
        return '<div class="bg-slate-950/60 border border-slate-800/80 rounded-lg p-2 flex items-center justify-between">' +
          '<div>' +
            '<span class="font-bold text-white">' + t.symbol + '</span> ' +
            '<span class="text-slate-400">→ ' + t.name + '</span>' +
          '</div>' +
          '<div class="text-right text-[11px] mono">' +
            '<span class="' + (t.held ? 'text-emerald-400' : 'text-rose-400') + '">' + (t.held ? 'TUTUNDU' : 'KIRILDI') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    async function runTests() {
      const modal = document.getElementById('test-modal');
      const out = document.getElementById('test-output');
      const spinner = document.getElementById('test-spinner');
      modal.classList.remove('hidden');
      spinner.classList.remove('hidden');
      out.textContent = 'Testler arka planda yürütülüyor (test/run.js)... Lütfen bekleyin...\\n';

      try {
        const res = await fetch('/api/run-tests', { method: 'POST' }).then(r => r.json());
        spinner.classList.add('hidden');
        out.textContent = res.output || (res.ok ? 'Tüm testler başarıyla geçti!' : 'Testler başarısız oldu.');
      } catch (err) {
        spinner.classList.add('hidden');
        out.textContent = 'Test yürütülürken hata oluştu: ' + err.message;
      }
    }

    function closeTestModal() {
      document.getElementById('test-modal').classList.add('hidden');
    }

    fetchData();
    setInterval(fetchData, 5000);
  </script>
</body>
</html>
`);
});

// Sunucuyu 0.0.0.0:3000 üzerinde dinle
const server = app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Scalp bot web paneli http://${HOST}:${PORT} üzerinde çalışıyor`);
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
