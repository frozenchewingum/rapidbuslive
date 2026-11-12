// Estimated arrivals at a stop (or a group of same-name stops on both sides of the road).
// ?s=<category>|<stop_id>[,<category>|<stop_id>...]
// Estimate = distance along the route line from the bus to the stop, at a typical KL bus pace.
const { CATS, full, liveBuses, geom, project } = require('./_lib/gtfs');

const PACE_M_PER_MIN = 250;   // ~15 km/h average including stops and traffic
const OFF_ROUTE_M = 400;      // ignore buses this far from the route line
const MAX_AHEAD_M = 25000;    // ignore buses more than 25 km away along the route
const STALE_SEC = 120;

module.exports = async (req, res) => {
  const ids = String(req.query.s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
  if (!ids.length) return res.status(400).json({ error: 'No stop given' });
  try {
    const live = await liveBuses();
    const byRoute = new Map();
    for (const b of live.buses) {
      if (!byRoute.has(b.rk)) byRoute.set(b.rk, []);
      byRoute.get(b.rk).push(b);
    }
    const arrivals = [], served = new Map(), seenBus = new Set();
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
        const rk = `${cat}|${rid}`;
        for (const [d, dir] of route.dirs) {
          const idx = (dir.stops || []).indexOf(stop);
          if (idx < 0) continue;
          const key = rk + '#' + d;
          if (!served.has(key)) served.set(key, { rk, route: route.short, feeder: cat === 'rapid-bus-mrtfeeder', d, to: dir.headsign, next: null, last: idx === dir.stops.length - 1 });
          const g = geom(dir);
          if (g.pts.length < 2) continue;
          const stopAlong = g.stopAlong[idx];
          for (const b of byRoute.get(rk) || []) {
            if (b.d !== d || seenBus.has(b.id + key)) continue;
            const pr = project(g, b.lat, b.lon);
            if (pr.dist > OFF_ROUTE_M) continue;
            const ahead = stopAlong - pr.along;
            if (ahead < -60 || ahead > MAX_AHEAD_M) continue;
            seenBus.add(b.id + key);
            const meters = Math.max(0, Math.round(ahead));
            const stale = b.ts ? live.now - b.ts > STALE_SEC : false;
            const a = { rk, route: route.short, feeder: cat === 'rapid-bus-mrtfeeder', d, to: dir.headsign, bus: b.id, plate: b.plate, meters, mins: Math.round(meters / PACE_M_PER_MIN), stale, ts: b.ts, ends: idx === dir.stops.length - 1 };
            arrivals.push(a);
            const sv = served.get(key);
            if (!stale && (!sv.next || a.meters < sv.next.meters)) sv.next = a;
          }
        }
      }
    }
    arrivals.sort((a, b) => a.stale - b.stale || a.meters - b.meters);
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json({
      now: live.now, stop: stopName,
      arrivals: arrivals.slice(0, 30),
      routes: [...served.values()].map(({ next, ...r }) => ({ ...r, hasLive: !!next })),
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
};
