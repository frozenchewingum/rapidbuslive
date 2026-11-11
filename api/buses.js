// All live Rapid KL buses (incl. MRT feeder), labelled with route, direction and destination.
const { CATS, base, realtime } = require('./_lib/gtfs');

const MAX_AGE = 20 * 60; // drop buses silent for more than 20 minutes

module.exports = async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const errors = [];
  const results = await Promise.all(CATS.map(async (cat) => {
    const [rt, st] = await Promise.allSettled([realtime(cat), base(cat)]);
    if (rt.status === 'rejected') { errors.push(String(rt.reason.message || rt.reason)); return { buses: [] }; }
    const s = st.status === 'fulfilled' ? st.value : null;
    if (!s) errors.push(String(st.reason.message || st.reason));
    const buses = [];
    for (const e of rt.value.entities) {
      const vp = e.vp;
      if (!vp || !vp.pos || !vp.pos.lat) continue;
      if (vp.ts && now - vp.ts > MAX_AGE) continue;
      const trip = vp.trip || {};
      let routeId = trip.routeId || '', d = null;
      const t = s && trip.tripId && s.trips.get(trip.tripId);
      if (t) { routeId = routeId || t.r; d = t.d; }
      if (s && routeId && !s.routes.has(routeId)) routeId = s.byShort.get(routeId.toUpperCase()) || routeId;
      if (d == null && trip.dir != null) d = trip.dir === 1 ? 1 : 0;
      const route = s && s.routes.get(routeId);
      const dir = route && d != null ? route.dirs.get(d) : null;
      const veh = vp.veh || {};
      buses.push({
        id: veh.id || veh.label || e.id,
        plate: veh.plate || veh.label || '',
        rk: `${cat}|${routeId}`,
        route: route ? route.short : routeId,
        d,
        to: dir ? dir.headsign : '',
        lat: +vp.pos.lat.toFixed(6),
        lon: +vp.pos.lon.toFixed(6),
        bearing: vp.pos.bearing != null ? Math.round(vp.pos.bearing) : null,
        kmh: vp.pos.speed != null ? Math.round(vp.pos.speed * 3.6) : null,
        ts: vp.ts || rt.value.ts || null,
      });
    }
    return { buses, ts: rt.value.ts };
  }));
  const buses = results.flatMap((r) => r.buses);
  const feedTs = Math.max(0, ...results.map((r) => r.ts || 0)) || null;
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
  res.status(buses.length || !errors.length ? 200 : 502).json({ now, feedTs, count: buses.length, errors, buses });
};
