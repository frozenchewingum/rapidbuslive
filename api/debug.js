// Diagnostics: what the live feed actually contains vs the timetable. ?q=590 to look up one route.
const { CATS, base, realtime } = require('./_lib/gtfs');

module.exports = async (req, res) => {
  const q = String(req.query.q || '').trim().toUpperCase();
  const t0 = Date.now();
  const out = { now: new Date().toISOString(), q: q || undefined, categories: {} };
  await Promise.all(CATS.map(async (cat) => {
    const c = (out.categories[cat] = {});
    const [rt, st] = await Promise.allSettled([realtime(cat), base(cat)]);
    c.staticOk = st.status === 'fulfilled';
    if (!c.staticOk) c.staticError = String(st.reason && st.reason.message);
    if (rt.status === 'rejected') { c.liveError = String(rt.reason && rt.reason.message); return; }
    const s = c.staticOk ? st.value : null;
    const ents = rt.value.entities.filter((e) => e.vp);
    const nowS = Date.now() / 1000;
    c.feedAgeSec = rt.value.ts ? Math.round(nowS - rt.value.ts) : null;
    c.vehicles = ents.length;
    c.staticRoutes = s ? s.routes.size : null;
    let noRoute = 0, tripMatched = 0, routeMatched = 0, fresh = 0;
    const byRoute = {};
    for (const e of ents) {
      const tr = e.vp.trip || {};
      const rid = tr.routeId || '';
      if (!rid) noRoute++;
      if (s && tr.tripId && s.trips.has(tr.tripId)) tripMatched++;
      if (s && rid && (s.routes.has(rid) || s.byShort.has(rid.toUpperCase()))) routeMatched++;
      if (e.vp.ts && nowS - e.vp.ts < 120) fresh++;
      const key = rid || '(none)';
      byRoute[key] = (byRoute[key] || 0) + 1;
    }
    Object.assign(c, { fresh2min: fresh, noRouteId: noRoute, tripIdMatched: tripMatched, routeIdMatched: routeMatched });
    c.unmatchedRouteIds = s ? Object.keys(byRoute).filter((r) => r !== '(none)' && !s.routes.has(r) && !s.byShort.has(r.toUpperCase())).slice(0, 50) : undefined;
    c.liveRouteCounts = Object.fromEntries(Object.entries(byRoute).sort((a, b) => b[1] - a[1]));
    c.sample = ents.slice(0, 3).map((e) => ({ trip: e.vp.trip, veh: e.vp.veh, ts: e.vp.ts }));
    if (q) {
      c.query = {
        inTimetable: s ? [...s.routes.values()].filter((r) => r.short.toUpperCase().includes(q) || r.id.toUpperCase().includes(q)).map((r) => ({ id: r.id, short: r.short, long: r.long })) : null,
        liveMatches: ents.filter((e) => JSON.stringify(e.vp.trip || {}).toUpperCase().includes(q) || JSON.stringify(e.vp.veh || {}).toUpperCase().includes(q))
          .map((e) => ({ trip: e.vp.trip, veh: e.vp.veh, ageSec: e.vp.ts ? Math.round(nowS - e.vp.ts) : null, lat: e.vp.pos.lat, lon: e.vp.pos.lon })),
      };
    }
  }));
  out.ms = Date.now() - t0;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
