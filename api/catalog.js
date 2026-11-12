// Search catalog: every route (with direction names) and every stop (with the routes serving it).
const { CATS, base, full } = require('./_lib/gtfs');

module.exports = async (req, res) => {
  const routes = [], rawStops = [], errors = [];
  await Promise.all(CATS.map(async (cat) => {
    let s;
    try { s = await full(cat); } catch (e) {
      errors.push(String(e.message || e));
      try { s = await base(cat); } catch { return; }
    }
    for (const r of s.routes.values()) {
      if (!r.dirs.size) continue;
      routes.push({
        k: `${cat}|${r.id}`,
        short: r.short,
        long: r.long,
        feeder: cat === 'rapid-bus-mrtfeeder',
        dirs: [...r.dirs].sort((a, b) => a[0] - b[0]).map(([d, dir]) => ({ d, to: dir.headsign })),
      });
    }
    if (s.stops) for (const st of s.stops.values()) {
      if (st.routes.size) rawStops.push([st.name, +st.lat.toFixed(5), +st.lon.toFixed(5), [...st.routes].map((id) => `${cat}|${id}`), `${cat}|${st.id}`]);
    }
  }));
  routes.sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
  const pos = new Map(routes.map((r, i) => [r.k, i]));
  const stops = rawStops.map(([n, la, lo, ks, id]) => [n, la, lo, ks.map((k) => pos.get(k)).filter((i) => i != null), id]);
  res.setHeader('Cache-Control', errors.length ? 's-maxage=300' : 's-maxage=21600, stale-while-revalidate=86400');
  res.status(routes.length ? 200 : 502).json({ routes, stops, errors });
};
