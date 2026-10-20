'use strict';

/**
 * Kalıcı olay günlüğü — panelin "Hata & Olay Günlüğü" kayıtlarını diske yazar ki bot yeniden
 * başlasa da hatalar sonradan incelenebilsin.
 *
 *   Dosya : <DB_PATH klasörü>/logs/events-YYYY-MM-DD.jsonl  (Fly'da /data → deploy sonrası korunur)
 *   Biçim : satır başına bir JSON { t, level, tag, message }
 *   Saklama: LOG_RETENTION_DAYS (varsayılan 14) günden eski dosyalar silinir.
 *
 * Yazma tamponlanır (her FLUSH_MS'de bir toplu append) — sıcak yolda senkron disk G/Ç yok.
 */

const fs = require('fs');
const path = require('path');

const FLUSH_MS = 2000;
const MAX_MESSAGE = 4000;        // tek kayıt üst sınırı (yığın izleri dahil)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function defaultDir() {
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'signals.db');
  return path.join(path.dirname(dbPath), 'logs');
}

const dayOf = t => new Date(t).toISOString().slice(0, 10);   // UTC gün

function createLogStore({ dir = defaultDir(), retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 14, now = () => Date.now(), disabled = false } = {}) {
  let enabled = !disabled;
  let pending = [];
  let timer = null;

  try {
    if (enabled) fs.mkdirSync(dir, { recursive: true });
  } catch {
    enabled = false;               // salt okunur dosya sistemi vb. — panel bellekteki günlükle çalışmaya devam eder
  }

  const fileFor = day => path.join(dir, `events-${day}.jsonl`);

  function flushSync() {
    if (!enabled || !pending.length) return;
    const batch = pending;
    pending = [];
    const byDay = new Map();
    for (const e of batch) {
      const d = dayOf(e.t);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(JSON.stringify(e));
    }
    for (const [d, lines] of byDay) {
      try { fs.appendFileSync(fileFor(d), lines.join('\n') + '\n'); } catch { /* disk hatası günlüğü durdurmaz */ }
    }
  }

  function append(entry) {
    if (!enabled) return;
    pending.push({ t: entry.t, level: entry.level, tag: entry.tag, message: String(entry.message ?? '').slice(0, MAX_MESSAGE) });
    if (!timer) {
      timer = setTimeout(() => { timer = null; flushSync(); }, FLUSH_MS);
      timer.unref?.();
    }
  }

  function days() {
    if (!enabled) return [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names
      .map(n => /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n)?.[1])
      .filter(Boolean)
      .sort()
      .reverse();
  }

  function readDay(day) {
    if (!enabled || !DAY_RE.test(String(day))) return [];
    flushSync();
    let text = '';
    try { text = fs.readFileSync(fileFor(day), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* yarım satır */ }
    }
    return out;
  }

  /** Bir günün kayıtları, en yeni önce; level/q filtresi ve limit. */
  function query({ day = dayOf(now()), level = 'all', q = '', limit = 500 } = {}) {
    const needle = String(q || '').toLowerCase();
    let list = readDay(day);
    if (level && level !== 'all') list = list.filter(e => e.level === level);
    if (needle) list = list.filter(e => String(e.message).toLowerCase().includes(needle) || String(e.tag).toLowerCase().includes(needle));
    const total = list.length;
    return { day, total, entries: list.reverse().slice(0, Math.max(1, Math.min(Number(limit) || 500, 5000))) };
  }

  /** Gün başına kayıt / hata / uyarı sayıları (en yeni gün önce). */
  function summary() {
    return days().map(day => {
      const list = readDay(day);
      return { day, total: list.length, errors: list.filter(e => e.level === 'error').length, warnings: list.filter(e => e.level === 'warn').length };
    });
  }

  /** Açılışta son kayıtları geri yükler (en yeni önce). */
  function recent(n = 500) {
    const out = [];
    for (const day of days()) {
      const list = readDay(day);
      for (let i = list.length - 1; i >= 0 && out.length < n; i--) out.push(list[i]);
      if (out.length >= n) break;
    }
    return out;
  }

  function exportDay(day) {
    if (!enabled || !DAY_RE.test(String(day))) return null;
    flushSync();
    try { return fs.readFileSync(fileFor(day)); } catch { return null; }
  }

  function prune() {
    if (!enabled) return 0;
    const cutoff = dayOf(now() - retentionDays * 86_400_000);
    let removed = 0;
    for (const day of days()) {
      if (day < cutoff) {
        try { fs.unlinkSync(fileFor(day)); removed++; } catch { /* yok */ }
      }
    }
    return removed;
  }

  return { append, flush: flushSync, days, query, summary, recent, exportDay, prune, enabled: () => enabled, dir };
}

module.exports = { createLogStore, dayOf };
