'use strict';

/**
 * Kart geçmişi — gönderilen her kart ve hareket uyarısı SQLite'a yazılır, sonrasında fiyat izlenir.
 *
 *   Dosya : <DB_PATH klasörü>/cards.db  (Fly'da /data → deploy sonrası korunur)
 *   Takip : karttan sonraki 15 / 60 / 240 dk'da fiyatın en düşük / en yüksek / kapanış değişimi (%),
 *           kart anındaki fiyata göre. Kazanç/kayıp hesabı YOK — sınıfları zamanla kıyaslamak için.
 *   Yeniden başlatma: yarım kalan takipler "eksik" işaretlenip kapatılır (kopukluk verisi uydurulmaz).
 *   Saklama: 90 gün.
 *   Seviye tepkisi (src/levelTouch.js): dirence alttan temas + sonraki 60 dk özeti, `touches` tablosu, 60 gün.
 *   Düşüş defteri (src/eventLog.js): pompa tepesinden düşüş (kartlı/kartsız) + tepe anındaki tüm göstergeler, `events`, 60 gün.
 *
 * Hata olursa bot durmaz: yazma hataları loglanır, kart gönderimi etkilenmez.
 */

const path = require('path');
const fs   = require('fs');

const MIN = 60_000;
const WINDOWS = [15, 60, 240];
const KEEP_DAYS = 90;
const TOUCH_KEEP_DAYS = 60;
const EVENT_KEEP_DAYS = 60;
const EVENT_WINDOWS = [5, 15, 60, 240];

function defaultFile() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'signals.db');
  return process.env.CARDS_DB_PATH || path.join(path.dirname(dbPath), 'cards.db');
}

/**
 * @param {object} o
 * @param {boolean} [o.recover=true]  açılışta yarım takipleri "eksik" kapat (yalnız bot; dışa aktarma gibi yan araçlar false)
 */
function createCardStore({ file = defaultFile(), logger = console, recover = true } = {}) {
  let db = null;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, symbol TEXT NOT NULL, t INTEGER NOT NULL,
        seq INTEGER, price REAL NOT NULL, data TEXT,
        low15 REAL, high15 REAL, close15 REAL,
        low60 REAL, high60 REAL, close60 REAL,
        low240 REAL, high240 REAL, close240 REAL,
        done INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS cards_t ON cards(t);
      CREATE INDEX IF NOT EXISTS cards_sym_t ON cards(symbol, t);
      CREATE TABLE IF NOT EXISTS touches (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, t INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT, value REAL,
        hits INTEGER, rsiok INTEGER, card INTEGER, emagap REAL,
        pb REAL, pbmin INTEGER, emamin INTEGER, brokemin INTEGER, brokeafterema INTEGER, held INTEGER,
        up REAL, dn REAL, c60 REAL
      );
      CREATE INDEX IF NOT EXISTS touches_t ON touches(t);
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL, dropt INTEGER, dropmin INTEGER,
        card INTEGER, cardgrade INTEGER, rsiok INTEGER, hits INTEGER, data TEXT,
        ${EVENT_WINDOWS.map(w => `low${w} REAL, high${w} REAL, close${w} REAL`).join(', ')}
      );
      CREATE INDEX IF NOT EXISTS events_t ON events(t);`);
    // Sonradan eklenen sütunlar (eski veritabanı): dibin indiği ortalama
    const tcols = new Set(db.prepare('PRAGMA table_info(touches)').all().map(c => c.name));
    for (const [c, type] of [['stop', 'TEXT'], ['stopdepth', 'REAL'], ['falling', 'INTEGER'], ['lvtouches', 'INTEGER']]) {
      if (!tcols.has(c)) db.exec(`ALTER TABLE touches ADD COLUMN ${c} ${type}`);
    }
    const n = recover ? db.prepare('UPDATE cards SET done = 1, partial = 1 WHERE done = 0').run().changes : 0;
    if (n) logger.log(`[GEÇMİŞ] Yeniden başlatma: ${n} yarım takip "eksik" olarak kapatıldı`);
  } catch (err) {
    logger.error(`[GEÇMİŞ] ${file} açılamadı (${err.message}) — kart geçmişi KAPALI, bot çalışmaya devam ediyor`);
    db = null;
  }

  const st = db && {
    insert: db.prepare('INSERT OR IGNORE INTO cards (id, kind, symbol, t, seq, price, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    upd: Object.fromEntries(WINDOWS.map(w => [w, db.prepare(`UPDATE cards SET low${w} = ?, high${w} = ?, close${w} = ?, done = ?, partial = ? WHERE id = ?`)])),
    close: db.prepare('UPDATE cards SET done = 1, partial = 1 WHERE id = ?'),
    recent: db.prepare('SELECT * FROM cards WHERE symbol = ? ORDER BY t DESC LIMIT ?'),
    since: db.prepare('SELECT * FROM cards WHERE t >= ? ORDER BY t'),
    prune: db.prepare('DELETE FROM cards WHERE t < ?'),
    tIns: db.prepare(`INSERT OR IGNORE INTO touches (id, symbol, t, name, kind, value, hits, rsiok, card, emagap, pb, pbmin, emamin, brokemin, brokeafterema, held, up, dn, c60, stop, stopdepth, falling, lvtouches)
      VALUES (@id, @symbol, @t, @name, @kind, @value, @hits, @rsiok, @card, @emagap, @pb, @pbmin, @emamin, @brokemin, @brokeafterema, @held, @up, @dn, @c60, @stop, @stopdepth, @falling, @lvtouches)`),
    tSince: db.prepare('SELECT * FROM touches WHERE t >= ? ORDER BY t'),
    eIns: db.prepare(`INSERT OR IGNORE INTO events (id, symbol, t, price, dropt, dropmin, card, cardgrade, rsiok, hits, data, ${EVENT_WINDOWS.map(w => `low${w}, high${w}, close${w}`).join(', ')})
      VALUES (@id, @symbol, @t, @price, @dropt, @dropmin, @card, @cardgrade, @rsiok, @hits, @data, ${EVENT_WINDOWS.map(w => `@low${w}, @high${w}, @close${w}`).join(', ')})`),
    eSince: db.prepare('SELECT * FROM events WHERE t >= ? ORDER BY t'),
    ePrune: db.prepare('DELETE FROM events WHERE t < ?'),
    tPrune: db.prepare('DELETE FROM touches WHERE t < ?'),
  };

  const open = new Map();   // symbol → [{ id, t, price, lo, hi, last, rec }]
  let openN = 0;

  function safe(fn, label) {
    if (!db) return null;
    try { return fn(); } catch (err) { logger.error(`[GEÇMİŞ] ${label}: ${err.message}`); return null; }
  }

  function track(id, symbol, t, price) {
    if (!open.has(symbol)) open.set(symbol, []);
    open.get(symbol).push({ id, t, price, lo: Infinity, hi: -Infinity, last: null, rec: {} });
    openN++;
  }

  return {
    enabled: () => Boolean(db),

    /** @param {object} row  { id, kind:'card'|'move', symbol, t, seq, price, data } */
    add(row) {
      const r = safe(() => st.insert.run(row.id, row.kind, row.symbol, row.t, row.seq ?? null, row.price, JSON.stringify(row.data ?? {})), 'kayıt');
      if (r && r.changes) track(row.id, row.symbol, row.t, row.price);
    },

    /** Kapanmış her 1m mumda çağrılır (takipteki kartların sonrası) */
    onCandle(symbol, c) {
      const arr = open.get(symbol);
      if (!arr || !arr.length) return;
      for (let k = arr.length - 1; k >= 0; k--) {
        const e = arr[k];
        if (c.t < e.t) continue;                           // kart anından önceki mum
        if (c.l < e.lo) e.lo = c.l;
        if (c.h > e.hi) e.hi = c.h;
        e.last = c.c;
        const elapsed = c.t + MIN - e.t;
        for (const w of WINDOWS) {
          if (e.rec[w] || elapsed < w * MIN) continue;
          const p = e.price;
          e.rec[w] = true;
          const done = w === WINDOWS[WINDOWS.length - 1] ? 1 : 0;
          safe(() => st.upd[w].run((e.lo - p) / p * 100, (e.hi - p) / p * 100, (e.last - p) / p * 100, done, 0, e.id), 'takip');
        }
        if (e.rec[WINDOWS[WINDOWS.length - 1]]) { arr.splice(k, 1); openN--; }
      }
      if (!arr.length) open.delete(symbol);
    },

    /** Mum gelmeyen (evrenden çıkan) coinlerin süresi dolan takiplerini kapatır */
    sweep(now = Date.now()) {
      for (const [sym, arr] of open) {
        for (let k = arr.length - 1; k >= 0; k--) {
          if (now - arr[k].t > (WINDOWS[WINDOWS.length - 1] + 15) * MIN) {
            safe(() => st.close.run(arr[k].id), 'kapatma');
            arr.splice(k, 1); openN--;
          }
        }
        if (!arr.length) open.delete(sym);
      }
      safe(() => st.prune.run(now - KEEP_DAYS * 86_400_000), 'temizlik');
      safe(() => st.tPrune.run(now - TOUCH_KEEP_DAYS * 86_400_000), 'temizlik');
      safe(() => st.ePrune.run(now - EVENT_KEEP_DAYS * 86_400_000), 'temizlik');
    },

    /** Seviye tepkisi olayı (src/levelTouch.js finish() çıktısı) */
    addTouch(e) {
      safe(() => st.tIns.run({
        id: e.id, symbol: e.symbol, t: e.t, name: e.name, kind: e.kind ?? null, value: e.value,
        hits: e.hits, rsiok: e.rsiOk ? 1 : 0, card: e.card ? 1 : 0, emagap: e.emaGap ?? null,
        pb: e.pb, pbmin: e.pbMin, emamin: e.emaMin ?? null, brokemin: e.brokeMin ?? null, brokeafterema: e.brokeAfterEma ? 1 : 0,
        held: e.held ? 1 : 0, up: e.up, dn: e.dn, c60: e.c60,
        stop: e.stop ?? null, stopdepth: e.stopDepth ?? null, falling: e.falling ? 1 : 0, lvtouches: e.lvTouches ?? null,
      }), 'seviye kaydı');
    },
    /** Düşüş olayı (src/eventLog.js finish() çıktısı) */
    addEvent(e) {
      const row = { id: e.id, symbol: e.symbol, t: e.t, price: e.price, dropt: e.dropT, dropmin: e.dropMin, card: e.card ? 1 : 0,
        cardgrade: e.cardGrade ?? null, rsiok: e.feat?.rsiOk ? 1 : 0, hits: e.feat?.hits ?? null, data: JSON.stringify(e.feat ?? {}) };
      for (const w of EVENT_WINDOWS) for (const k of ['low', 'high', 'close']) row[`${k}${w}`] = e.out?.[w]?.[k] ?? null;
      safe(() => st.eIns.run(row), 'düşüş kaydı');
    },
    /**
     * Haftalık rapordan sonra: cutoff'tan önceki kartlar, temaslar ve düşüşler silinir; disk VACUUM ile geri alınır.
     * Bellekteki takipte olan (cutoff'tan önceki) kartlar da bırakılır.
     */
    purgeBefore(cutoff) {
      const r = safe(() => ({
        cards: db.prepare('DELETE FROM cards WHERE t < ?').run(cutoff).changes,
        touches: db.prepare('DELETE FROM touches WHERE t < ?').run(cutoff).changes,
        events: db.prepare('DELETE FROM events WHERE t < ?').run(cutoff).changes,
      }), 'silme');
      for (const [sym, arr] of open) {
        for (let k = arr.length - 1; k >= 0; k--) if (arr[k].t < cutoff) { arr.splice(k, 1); openN--; }
        if (!arr.length) open.delete(sym);
      }
      safe(() => { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); }, 'vacuum');
      return r;
    },
    eventsSince: t => (safe(() => st.eSince.all(t), 'sorgu') || []).map(rowToEvent),
    touchesSince: t => (safe(() => st.tSince.all(t), 'sorgu') || []).map(rowToTouch),

    recent: (symbol, n = 10) => safe(() => st.recent.all(symbol, n), 'sorgu') || [],
    since: t => safe(() => st.since.all(t), 'sorgu') || [],
    openCount: () => openN,
    close: () => { try { db?.close(); } catch { /* yok */ } },
  };
}

/** DB satırı → istatistik (infoStats.classTable) biçimi */
function rowToStat(r) {
  let d = {};
  try { d = JSON.parse(r.data || '{}'); } catch { d = {}; }
  const fwd = {};
  for (const w of WINDOWS) if (r[`low${w}`] != null) fwd[w] = { low: r[`low${w}`], high: r[`high${w}`], close: r[`close${w}`] };
  return { ...d, kind: r.kind, symbol: r.symbol, t: r.t, seq: r.seq, price: r.price, fwd, partial: Boolean(r.partial), done: Boolean(r.done) };
}

/** events satırı → eventLog olay biçimi */
function rowToEvent(r) {
  let feat = {};
  try { feat = JSON.parse(r.data || '{}'); } catch { feat = {}; }
  const out = {};
  for (const w of EVENT_WINDOWS) if (r[`low${w}`] != null) out[w] = { low: r[`low${w}`], high: r[`high${w}`], close: r[`close${w}`] };
  return { id: r.id, symbol: r.symbol, t: r.t, price: r.price, dropT: r.dropt, dropMin: r.dropmin, card: Boolean(r.card), cardGrade: r.cardgrade, feat, out };
}

/** touches satırı → levelTouch olay biçimi */
function rowToTouch(r) {
  return {
    id: r.id, symbol: r.symbol, t: r.t, name: r.name, kind: r.kind, value: r.value, hits: r.hits, rsiOk: Boolean(r.rsiok), card: Boolean(r.card),
    emaGap: r.emagap, pb: r.pb, pbMin: r.pbmin, emaMin: r.emamin, brokeMin: r.brokemin, brokeAfterEma: Boolean(r.brokeafterema),
    held: Boolean(r.held), up: r.up, dn: r.dn, c60: r.c60,
    stop: r.stop ?? null, stopDepth: r.stopdepth ?? null, falling: Boolean(r.falling), lvTouches: r.lvtouches ?? null,
  };
}

module.exports = { createCardStore, rowToStat, rowToTouch, rowToEvent, WINDOWS, EVENT_WINDOWS };
