// Probe the MyRapid Bus Kiosk for one route: ?route=590   (or ?list=1 for the route list)
const { listRoutes, findRoute, routeMeta, liveSnapshot, inspect } = require('./_lib/kiosk');

const trim = (v, n = 600) => { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : v; };
function shape(p) {
  if (Array.isArray(p)) return { type: 'array', length: p.length, first: p.slice(0, 2) };
  if (p && typeof p === 'object') {
    const arr = Object.entries(p).find(([, v]) => Array.isArray(v));
    return { type: 'object', keys: Object.keys(p).slice(0, 30), arrayKey: arr && arr[0], arrayLength: arr && arr[1].length, first: arr ? arr[1].slice(0, 2) : trim(p, 1500) };
  }
  return { type: typeof p, value: trim(p) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  try {
    if (req.query.inspect) {
      const path = String(req.query.inspect);
      const url = path.startsWith('/') ? 'https://myrapidbus.prasarana.com.my' + path : 'https://myrapidbus.prasarana.com.my/kiosk';
      return res.status(200).json(await inspect(url));
    }
    if (req.query.list) {
      const list = await listRoutes();
      return res.status(200).json({ count: list.length, routes: list.slice(0, 400) });
    }
    const q = String(req.query.route || '590');
    const route = await findRoute(q);
    if (!route) { const list = await listRoutes(); return res.status(404).json({ error: `Route ${q} not in kiosk list`, count: list.length, sample: list.slice(0, 15) }); }
    const page = await routeMeta(route.value);
    const live = await liveSnapshot(page.meta);
    res.status(200).json({
      ms: Date.now() - t0,
      route,
      meta: page.meta,
      stops: { count: page.stops.length, first: page.stops.slice(0, 3) },
      live: { eio: live.eio, why: live.why, payloads: live.payloads.length, shape: live.payloads[0] !== undefined ? shape(live.payloads[0]) : null, log: live.log, firstTry: live.firstTry && { why: live.firstTry.why, log: live.firstTry.log } },
      pageVars: page.varNames.slice(0, 60),
      code: page.code,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e), ms: Date.now() - t0 });
  }
};
