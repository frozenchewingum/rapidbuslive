// Estimated arrivals at a stop (or a group of same-name stops on both sides of the road).
// ?s=<category>|<stop_id>[,<category>|<stop_id>...]
// Uses the open feed + MyRapid Kiosk feed for each route at the stop.
// Estimate = distance along the route line from the bus to the stop, at a typical KL bus pace.
const { CATS, full, geom, project } = require('./_lib/gtfs');
const { routeLive } = require('./_lib/merge');

const PACE_M_PER_MIN = 250;   // ~15 km/h average including stops and traffic
const OFF_ROUTE_M = 400;      // ignore buses this far from the route line
const MAX_AHEAD_M = 25000;    // ignore buses more than 25 km away along the route
const STALE_SEC = 120;
const MAX_ROUTES = 10;        // cap live lookups per stop
const TERMINAL_M = 400;       // within this distance of the route's first stop counts as "at the terminal"
const MAX_EXTRAP_KMH = 40;    // cap speed used to move a bus forward from its last report

// Remember where each bus was last seen moving (per warm instance), for buses that report no speed.
const lastMove = new Map();   // bus id -> { lat, lon, since }
function stillFor(b, now) {
  const p = lastMove.get(b.id);
  if (!p || Math.hypot((b.lat - p.lat) * 110574, (b.lon - p.lon) * 111100) > 40) {
    lastMove.set(b.id, { lat: b.lat, lon: b.lon, since: b.ts || now });
    return 0;
  }
  return (b.ts || now) - p.since;
}

module.exports = async (req, res) => {
  const ids = String(req.query.s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
  if (!ids.length) return res.status(400).json({ error: 'No stop given' });
  try {
    // 1. Which route+direction pairs serve these stops
    const pairs = [];      // { rk, cat, route, d, dir, idx }
    let stopName = '';
    for (const sid of ids) {
      const [cat, ...rest] = sid.split('|');
      if (!CATS.includes(cat)) continue;
      const s = await full(cat);
      const stop = s.stops.get(rest.join('|'));
      if (!stop) continue;
      stopName = stopName || stop.name;
      for (const rid of stop.routes) {
        const route = s.routes.get(rid);
        for (const [d, dir] of route.dirs) {
          const idx = (dir.stops || []).indexOf(stop);
          if (idx >= 0) pairs.push({ rk: `${cat}|${rid}`, cat, route, d, dir, idx });
        }
      }
    }
    // 2. Live buses for each route (merged feeds), in parallel
    const rks = [...new Set(pairs.map((p) => p.rk))].slice(0, MAX_ROUTES);
    const liveByRk = new Map();
    let now = Math.floor(Date.now() / 1000);
    await Promise.all(rks.map(async (rk) => {
      try { const r = await routeLive(rk); liveByRk.set(rk, r.buses); now = r.now || now; }
      catch { liveByRk.set(rk, []); }
    }));
    // 3. Project each bus onto the line and compare with the stop's position
    const arrivals = [], served = new Map(), seen = new Set();
    for (const { rk, cat, route, d, dir, idx } of pairs) {
      const key = rk + '#' + d;
      if (!served.has(key)) served.set(key, { rk, route: route.short, feeder: cat === 'rapid-bus-mrtfeeder', d, to: dir.headsign, last: idx === dir.stops.length - 1, hasLive: false });
      const g = geom(dir);
      if (g.pts.length < 2) continue;
      const stopAlong = g.stopAlong[idx];
      for (const b of liveByRk.get(rk) || []) {
        if (b.d !== d || seen.has(b.id + key)) continue;
        const pr = project(g, b.lat, b.lon);
        if (pr.dist > OFF_ROUTE_M) continue;
        const rawAhead = stopAlong - pr.along;
        if (rawAhead < -60 || rawAhead > MAX_AHEAD_M) continue;
        seen.add(b.id + key);
        const age = b.ts ? Math.max(0, now - b.ts) : 0;
        if (age > STALE_SEC || b.off) continue;   // only active buses

        // Waiting at the starting terminal: near the first stop and not moving.
        const fromStart = pr.along - (g.stopAlong[0] || 0);
        const still = b.kmh != null ? b.kmh < 3 : stillFor(b, now) >= 120;
        const waiting = fromStart < TERMINAL_M && still && idx > 0;
        const waitingHere = fromStart < TERMINAL_M && still && idx === 0;

        // Move the bus forward by how far it has probably gone since its last report.
        let ahead = rawAhead;
        if (!waiting && !waitingHere && age > 0) {
          const mPerMin = b.kmh != null && b.kmh >= 3 ? Math.min(b.kmh, MAX_EXTRAP_KMH) * 1000 / 60 : PACE_M_PER_MIN;
          ahead -= mPerMin * age / 60;
        }
        const meters = Math.max(0, Math.round(ahead));
        arrivals.push({
          rk, route: route.short, feeder: cat === 'rapid-bus-mrtfeeder', d, to: dir.headsign, bus: b.id, plate: b.plate,
          meters, mins: Math.round(meters / PACE_M_PER_MIN), ts: b.ts, age,
          waiting: waiting || undefined, waitingHere: waitingHere || undefined,
          terminal: waiting || waitingHere ? dir.stops[0].name : undefined,
          ends: idx === dir.stops.length - 1, src: b.src,
        });
        served.get(key).hasLive = true;
      }
    }
    // Moving buses first by distance; buses still waiting at a terminal after them.
    arrivals.sort((a, b) => (!!a.waiting - !!b.waiting) || a.meters - b.meters);
    // The same physical bus can appear under two route entries (e.g. same number in two categories): keep one.
    const once = new Set();
    const unique = arrivals.filter((a) => {
      const k = String(a.plate || a.bus).toUpperCase().replace(/[^A-Z0-9]/g, '') + '#' + a.to;
      if (once.has(k)) return false;
      once.add(k); return true;
    });
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json({ now, stop: stopName, arrivals: unique.slice(0, 30), routes: [...served.values()] });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
};
