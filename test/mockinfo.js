'use strict';
// Sahte Binance (REST + WS) — bilgi botu testleri için. 1m tabanlı seriler, üst TF'ler 1m'den.
const http = require('http');
const WebSocket = require('ws');
const { agg, MIN } = require('./gen');
const TFMS = { '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN };

function buildMarket(defs) {
  // defs: { SYM: { m1: [...], histUntil: t (exclusive), vol, base } }
  const mk = {};
  for (const [s, d] of Object.entries(defs)) {
    const hist = d.m1.filter(c => c.t < d.histUntil);
    const tfs = { '1m': hist };
    for (const tf of ['3m', '5m', '15m', '1h', '4h', '1d']) tfs[tf] = agg(hist, TFMS[tf], d.histUntil);
    mk[s] = { ...d, tfs, future: d.m1.filter(c => c.t >= d.histUntil) };
  }
  return mk;
}

const row = (c, ms) => [c.t, String(c.o), String(c.h), String(c.l), String(c.c), String(c.v), c.t + ms - 1, String(c.q), 10, String(c.tb), String(c.tq), '0'];

function startRest(port, market, hits = []) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams);
    const key = u.pathname.split('/').pop();
    hits.push(`${key}${q.symbol ? ' ' + q.symbol : ''}${q.interval ? ' ' + q.interval : ''}${q.limit ? ' ' + q.limit : ''}`);
    let body;
    if (key === 'exchangeInfo') body = { symbols: Object.entries(market).map(([s, m]) => ({ symbol: s, contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', baseAsset: m.base || s.replace(/USDT$/, '') })) };
    else if (key === '24hr') body = Object.entries(market).map(([s, m]) => ({ symbol: s, quoteVolume: String(m.vol ?? 1e9) }));
    else if (key === 'premiumIndex') body = Object.keys(market).map(s => ({ symbol: s, lastFundingRate: '-0.00012', nextFundingTime: Date.now() + 2 * 3600e3 }));
    else if (key === 'openInterestHist') body = Array.from({ length: 13 }, (_, i) => ({ symbol: q.symbol, sumOpenInterest: String(1000 + i * 3) }));
    else if (key === 'klines') {
      const m = market[q.symbol]; if (!m) { res.writeHead(400); return res.end(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' })); }
      const ms = TFMS[q.interval], lim = Number(q.limit || 500), arr = m.tfs[q.interval];
      if (q.startTime) {
        const st = Number(q.startTime), en = q.endTime ? Number(q.endTime) : Infinity;
        body = arr.filter(c => c.t >= st && c.t <= en).slice(0, lim).map(c => row(c, ms));
      } else {
        const en = q.endTime ? Number(q.endTime) : Infinity;
        body = arr.filter(c => c.t <= en).slice(-lim).map(c => row(c, ms));
      }
    } else { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  }).listen(port);
  return srv;
}

function startWs(port) {
  const conns = [];
  const wss = new WebSocket.Server({ port });
  wss.on('connection', (ws, req) => {
    const c = { ws, path: req.url, subs: new Set(), log: [] };
    conns.push(c);
    ws.on('message', raw => {
      const m = JSON.parse(raw); c.log.push(m.method);
      if (m.method === 'SUBSCRIBE') m.params.forEach(p => c.subs.add(p));
      if (m.method === 'UNSUBSCRIBE') m.params.forEach(p => c.subs.delete(p));
      ws.send(JSON.stringify({ result: null, id: m.id }));
    });
  });
  function push(sym, c, final = true) {
    const st = `${sym.toLowerCase()}@kline_1m`;
    const msg = { stream: st, data: { e: 'kline', E: Date.now(), s: sym, k: { t: c.t, T: c.t + MIN - 1, s: sym, i: '1m', o: String(c.o), c: String(c.c), h: String(c.h), l: String(c.l), v: String(c.v), q: String(c.q), V: String(c.tb), Q: String(c.tq), x: final } } };
    const s = JSON.stringify(msg);
    let n = 0;
    for (const cn of conns) if (cn.ws.readyState === 1 && cn.subs.has(st)) { cn.ws.send(s); n++; }
    return n;
  }
  return { wss, conns, push };
}

function startTelegram(port, { admins = [] } = {}) {
  const sent = [], answers = [], edits = [], updates = [], myCommands = [], privates = [], docs = [], blockedPrivate = new Set();
  let uid = 1000;
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      let body = {};
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/')) {
        const fd = await new Response(raw, { headers: { 'content-type': ct } }).formData();
        for (const [k, v] of fd.entries()) {
          if (typeof v === 'string') { try { body[k] = /^[\[{]/.test(v) ? JSON.parse(v) : v; } catch { body[k] = v; } }
          else { body[k + 'Bytes'] = (await v.arrayBuffer()).byteLength; body[k + 'Name'] = v.name; if (k === 'document') body.documentText = await v.text(); }
        }
        body.text = body.caption; body.photo = true;
        if (body.disable_notification === 'true') body.disable_notification = true;
      } else body = raw.length ? JSON.parse(raw.toString()) : {};
      const method = req.url.split('/').pop();
      const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (method === 'getMe') return reply({ ok: true, result: { id: 1, username: 'info_test_bot' } });
      if (method === 'getUpdates') {
        const give = () => { const u = updates.splice(0); reply({ ok: true, result: u }); };
        if (updates.length) return give();
        return setTimeout(give, 200);
      }
      if (method === 'sendMessage' && blockedPrivate.has(Number(body.chat_id))) return reply({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
      if (method === 'sendMessage' && Number(body.chat_id) > 0) { body.method = method; privates.push(body); return reply({ ok: true, result: { message_id: ++uid, chat: { id: body.chat_id } } }); }
      if (method === 'sendMessage' || method === 'sendPhoto') { body.method = method; sent.push(body); return reply({ ok: true, result: { message_id: ++uid, chat: { id: body.chat_id } } }); }
      if (method === 'sendDocument') {
        if (blockedPrivate.has(Number(body.chat_id))) return reply({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
        docs.push(body); return reply({ ok: true, result: { message_id: ++uid, chat: { id: body.chat_id } } });
      }
      if (method === 'answerCallbackQuery') { answers.push(body); return reply({ ok: true, result: true }); }
      if (method === 'editMessageText') { edits.push(body); return reply({ ok: true, result: true }); }
      if (method === 'setMyCommands') { myCommands.push(body); return reply({ ok: true, result: true }); }
      if (method === 'getChatMember') return reply({ ok: true, result: { status: admins.includes(body.user_id) ? 'administrator' : body.user_id === 777 ? 'left' : 'member' } });
      reply({ ok: false, error_code: 404, description: 'Not Found' });
    });
  }).listen(port);
  let upd = 1;
  const now = () => Math.floor(Date.now() / 1000);
  return {
    srv, sent, answers, edits, myCommands, privates, docs, blockedPrivate,
    privateMsg(from, text) { updates.push({ update_id: upd++, message: { message_id: upd, date: now(), chat: { id: from, type: 'private' }, from: { id: from }, text } }); },
    command(chat, from, text, thread = null, title = null) { updates.push({ update_id: upd++, message: { message_id: upd, date: now(), chat: { id: Number(chat), ...(title ? { title, is_forum: true } : {}) }, from: { id: from }, text, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) } }); },
    click(chat, from, data, messageId = 5) { updates.push({ update_id: upd++, callback_query: { id: 'cb' + upd, from: { id: from }, data, message: { message_id: messageId, chat: { id: Number(chat) } } } }); },
  };
}

module.exports = { buildMarket, startRest, startWs, startTelegram, TFMS };
