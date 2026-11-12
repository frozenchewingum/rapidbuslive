// One route's geometry: line and ordered stops for each direction. ?k=<category>|<route_id>
const { CATS, full } = require('./_lib/gtfs');

module.exports = async (req, res) => {
  const [cat, ...rest] = String(req.query.k || '').split('|');
  const id = rest.join('|');
  if (!CATS.includes(cat) || !id) return res.status(400).json({ error: 'Unknown route' });
  try {
    const s = await full(cat);
    const r = s.routes.get(id);
    if (!r) return res.status(404).json({ error: 'Route not found' });
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      k: req.query.k, short: r.short, long: r.long, color: r.color,
      dirs: [...r.dirs].sort((a, b) => a[0] - b[0]).map(([d, dir]) => ({
        d, to: dir.headsign, line: dir.line || [],
        stops: (dir.stops || []).map((st) => [st.name, +st.lat.toFixed(5), +st.lon.toFixed(5), `${cat}|${st.id}`]),
      })),
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
};
