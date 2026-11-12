// MyRapid Bus Kiosk live feed (Socket.IO). Per-route snapshot:
// connect → emit "onFts-reload" {sid, uid, provider, route} → first "onFts-client" payload
// (base64 of gzipped JSON array) → disconnect. No dependencies (Node 22 WebSocket + zlib).
const zlib = require('zlib');

const SOCKET_BASE = process.env.KIOSK_SOCKET_BASE || 'wss://rapidbus-socketio-avl.prasarana.com.my';
const SID = process.env.KIOSK_SID || 'veminbhagau60up1v3k12mnvjpxne5fj';
const PROVIDER = process.env.KIOSK_PROVIDER || 'RKL';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const CACHE_MS = 15000;

// Kiosk route codes: numeric routes get a "U" prefix (590 → U590); T/BET/etc. stay as-is.
const kioskCode = (short) => (/^\d/.test(String(short)) ? 'U' + short : String(short)).toUpperCase();

function decodePayload(p) {
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') return p.data ? decodePayload(p.data) : [];
  if (typeof p !== 'string') return [];
  const s = p.trim();
  if (s.startsWith('[') || s.startsWith('{')) return decodePayload(JSON.parse(s));
  const buf = Buffer.from(s, 'base64');
  let text;
  try { text = zlib.gunzipSync(buf).toString('utf8'); }
  catch { text = zlib.inflateSync(buf).toString('utf8'); }
  return decodePayload(JSON.parse(text));
}

// One-shot Socket.IO exchange (Engine.IO v4, falls back to v3).
function exchange(params, { eio = 4, waitMs = 7000 } = {}) {
  return new Promise((resolve) => {
    const log = [];
    let done = false, ws;
    const finish = (why, payload) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ why, payload, eio, log });
    };
    const timer = setTimeout(() => finish('timeout'), waitMs);
    try {
      ws = new WebSocket(`${SOCKET_BASE}/socket.io/?EIO=${eio}&transport=websocket`, {
        headers: { Origin: 'https://myrapidbus.prasarana.com.my', 'User-Agent': UA },
      });
    } catch (e) { log.push('ctor ' + e.message); return finish('error'); }
    ws.addEventListener('message', (ev) => {
      const msg = typeof ev.data === 'string' ? ev.data : '';
      if (log.length < 12) log.push(msg.slice(0, 120));
      if (msg[0] === '0') { if (eio === 4) ws.send('40'); }
      else if (msg.startsWith('40')) ws.send('42' + JSON.stringify(['onFts-reload', params]));
      else if (msg === '2') ws.send('3');
      else if (msg.startsWith('44')) finish('connect_error');
      else if (msg.startsWith('42')) {
        try {
          const [event, ...args] = JSON.parse(msg.slice(2));
          if (event === 'onFts-client') finish('ok', args[0]);
        } catch { log.push('bad frame'); }
      }
    });
    ws.addEventListener('error', () => finish('error'));
    ws.addEventListener('close', (e) => finish('closed ' + e.code));
  });
}

const cache = new Map(); // code -> { at, p }
function snapshot(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const p = (async () => {
    const params = { sid: SID, uid: '', provider: PROVIDER, route: code };
    let r = await exchange(params, { eio: 4 });
    if (r.why !== 'ok' && r.why !== 'timeout') r = await exchange(params, { eio: 3 });
    let rows = [];
    if (r.why === 'ok') {
      try { rows = decodePayload(r.payload); } catch (e) { r.why = 'decode_error'; r.log.push(String(e.message)); }
    }
    return { code, ok: r.why === 'ok', why: r.why, eio: r.eio, log: r.log, rows: Array.isArray(rows) ? rows : [] };
  })();
  cache.set(code, { at: Date.now(), p });
  p.then((r) => { if (!r.ok) cache.set(code, { at: Date.now() - CACHE_MS + 5000, p }); });
  return p;
}

// "2026-11-12 13:41:17" (Malaysia time) → unix seconds
function myt(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + '+08:00');
  return isNaN(t) ? null : Math.floor(t / 1000);
}

module.exports = { kioskCode, snapshot, decodePayload, myt };
