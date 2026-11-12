// Reads the public MyRapid Bus Kiosk (no login): route list, per-route page variables and stops,
// and a one-shot snapshot from its Socket.IO live feed. No dependencies (uses Node 22's WebSocket).
const KIOSK = 'https://myrapidbus.prasarana.com.my/kiosk';
const SOCKET_HOST = 'rapidbus-socketio-avl.prasarana.com.my';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: KIOSK,
};

let jar = '';
let lastResp = null;
async function getPage(url) {
  const r = await fetch(url, { headers: { ...HEADERS, ...(jar ? { Cookie: jar } : {}) }, redirect: 'follow' });
  lastResp = { status: r.status, url: r.url, server: r.headers.get('server'), type: r.headers.get('content-type') };
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (set.length) {
    const cur = new Map(jar.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    for (const c of set) { const kv = c.split(';')[0]; cur.set(kv.split('=')[0], kv); }
    jar = [...cur.values()].join('; ');
  }
  if (!r.ok) throw new Error(`kiosk HTTP ${r.status}`);
  return r.text();
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

let routesCache = null;
async function listRoutes() {
  if (routesCache && Date.now() - routesCache.at < 6 * 3600e3) return routesCache.list;
  const html = await getPage(KIOSK);
  const sel = html.match(/<select[^>]*id=["']route["'][^>]*>([\s\S]*?)<\/select>/i);
  const list = [];
  if (sel) {
    const re = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = re.exec(sel[1]))) if (m[1]) list.push({ value: decode(m[1]), text: decode(m[2].replace(/<[^>]+>/g, '')) });
  }
  routesCache = { at: Date.now(), list };
  return list;
}

async function findRoute(q) {
  const list = await listRoutes();
  const Q = String(q).trim().toUpperCase();
  return list.find((r) => r.value.toUpperCase() === Q) || list.find((r) => r.text.toUpperCase() === Q)
    || list.find((r) => r.text.toUpperCase().split(/[\s\-–:]+/)[0] === Q) || list.find((r) => r.text.toUpperCase().includes(Q)) || null;
}

// Value of `var name = ...;` in the page's scripts. Handles 'x', "x", cond ? 'x' : '', numbers.
function jsVar(html, name) {
  const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*([^;\\n]*)`));
  if (!m) return null;
  const expr = m[1].trim();
  let t = expr.match(/\?\s*(['"])(.*?)\1\s*:/);
  if (t) return t[2];
  t = expr.match(/^(['"])(.*?)\1/);
  if (t) return t[2];
  return expr;
}
function snippet(html, marker, len = 1500) {
  const i = html.indexOf(marker);
  return i < 0 ? null : html.slice(i, i + len);
}

async function routeMeta(routeValue) {
  const html = await getPage(`${KIOSK}?route=${encodeURIComponent(routeValue)}&bus=`);
  const meta = { sid: jsVar(html, 'sid'), uid: jsVar(html, 'uid'), prm: jsVar(html, 'prm'), no_route: jsVar(html, 'no_route') };
  let stops = [];
  const b = html.match(/var bstp = (.*);/);
  if (b) { try { stops = JSON.parse(b[1]); } catch {} }
  const varNames = [...new Set([...html.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)].map((x) => x[1]))];
  return {
    meta, stops, varNames,
    code: { filter: snippet(html, 'function filter('), setup: snippet(html, 'function setup('), emit: snippet(html, "socket.emit(", 400) },
  };
}

// Minimal Socket.IO client: connect, emit onFts-reload, collect onFts-client payloads, disconnect.
function socketSnapshot(params, { eio = 4, waitMs = 9000, settleMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const log = [], payloads = [];
    let done = false, settleTimer = null, ws;
    const finish = (why) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(settleTimer);
      try { ws.close(); } catch {}
      resolve({ eio, why, payloads, log: log.slice(0, 20) });
    };
    const timer = setTimeout(() => finish('timeout'), waitMs);
    try {
      ws = new WebSocket(`wss://${SOCKET_HOST}/socket.io/?EIO=${eio}&transport=websocket`, {
        headers: { Origin: 'https://myrapidbus.prasarana.com.my', 'User-Agent': UA },
      });
    } catch (e) { log.push('ctor error ' + e.message); return finish('error'); }
    const emit = () => ws.send('42' + JSON.stringify(['onFts-reload', params]));
    ws.addEventListener('message', (ev) => {
      const msg = typeof ev.data === 'string' ? ev.data : '[binary]';
      if (log.length < 20) log.push(msg.slice(0, 160));
      if (msg[0] === '0') { if (eio === 4) ws.send('40'); }
      else if (msg.startsWith('40')) emit();
      else if (msg === '2') ws.send('3');
      else if (msg.startsWith('44')) finish('connect_error');
      else if (msg.startsWith('42')) {
        try {
          const [event, ...args] = JSON.parse(msg.slice(2));
          if (event === 'onFts-client') {
            payloads.push(args.length === 1 ? args[0] : args);
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => finish('ok'), settleMs);
          } else log.push('event ' + event);
        } catch { log.push('bad 42 frame'); }
      }
    });
    ws.addEventListener('error', (e) => { log.push('ws error ' + (e.message || e.type)); finish('error'); });
    ws.addEventListener('close', (e) => { log.push('closed ' + e.code); finish('closed'); });
  });
}

async function liveSnapshot(meta, opts) {
  const params = { sid: meta.sid, uid: meta.uid, provider: meta.prm, route: meta.no_route };
  let r = await socketSnapshot(params, { ...opts, eio: 4 });
  if (!r.payloads.length && r.why !== 'timeout') r = { ...(await socketSnapshot(params, { ...opts, eio: 3 })), firstTry: r };
  return r;
}

// Describe what a page actually contains (for when the expected markup isn't there).
async function inspect(url = KIOSK) {
  const html = await getPage(url);
  const around = (re, n = 220, max = 8) => [...html.matchAll(re)].slice(0, max).map((m) => html.slice(Math.max(0, m.index - 60), m.index + n).replace(/\s+/g, ' '));
  return {
    response: lastResp,
    cookies: jar.split('; ').filter(Boolean).map((c) => c.split('=')[0]),
    length: html.length,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1],
    selects: [...html.matchAll(/<select[^>]*>/gi)].map((m) => m[0]).slice(0, 10),
    optionCount: (html.match(/<option/gi) || []).length,
    scriptSrcs: [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 25),
    urlsInPage: [...new Set([...html.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]+|\/[A-Za-z0-9_\-\/]+(?:\?[^"'`\s]*)?)["'`]/g)].map((m) => m[1]))].filter((u) => !/\.(png|jpe?g|svg|css|ico|woff2?)/.test(u)).slice(0, 60),
    routeMentions: around(/route/gi),
    socketMentions: around(/socket|io\.connect/gi),
    ajaxMentions: around(/\$\.(ajax|get|post|getJSON)|fetch\(|axios/gi, 300),
    head: html.slice(0, 1500),
  };
}

module.exports = { listRoutes, findRoute, routeMeta, liveSnapshot, inspect };
