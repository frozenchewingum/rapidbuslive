// One route's geometry per direction ("branch"): line and ordered stops. ?k=<category>|<route_id>
// Round-trip loops are split into their outbound/return stretches (see buildBranches in _lib/gtfs.js).
const { CATS, full, geom } = require('./_lib/gtfs');

function pointAt(line, g, along) {
  if (along <= 0) return line[0];
  for (let i = 1; i < g.cum.length; i++) {
    if (g.cum[i] >= along) {
      const t = (along - g.cum[i - 1]) / ((g.cum[i] - g.cum[i - 1]) || 1);
      return [+(line[i - 1][0] + t * (line[i][0] - line[i - 1][0])).toFixed(5), +(line[i - 1][1] + t * (line[i][1] - line[i - 1][1])).toFixed(5)];
    }
  }
  return line[line.length - 1];
}
function sliceLine(dir, L) {
  const line = dir.line || [], g = geom(dir);
  if (line.length < 2) return line;
  const total = g.cum[g.cum.length - 1];
  const a = Math.max(0, isFinite(L.startAlong) ? L.startAlong : 0), b = Math.min(total, isFinite(L.endAlong) ? L.endAlong : total);
  const out = [pointAt(line, g, a)];
  for (let i = 0; i < line.length; i++) if (g.cum[i] > a && g.cum[i] < b) out.push(line[i]);
  out.push(pointAt(line, g, b));
  return out;
}

module.exports = async (req, res) => {
  const [cat, ...rest] = String(req.query.k || '').split('|');
  const id = rest.join('|');
  if (!CATS.includes(cat) || !id) return res.status(400).json({ error: 'Unknown route' });
  try {
    const s = await full(cat);
    const r = s.routes.get(id);
    if (!r) return res.status(404).json({ error: 'Route not found' });
    const stopOut = (st) => [st.name, +st.lat.toFixed(5), +st.lon.toFixed(5), `${cat}|${st.id}`];
    const dirs = r.branches && r.branches.length
      ? r.branches.map((L) => {
          const dir = r.dirs.get(L.d);
          return { d: L.bi, to: L.to, loop: dir.legs.length > 1 || undefined, line: sliceLine(dir, L), stops: dir.stops.slice(L.from, L.end + 1).map(stopOut) };
        })
      : [...r.dirs].sort((a, b) => a[0] - b[0]).map(([d, dir]) => ({ d, to: dir.headsign, line: dir.line || [], stops: (dir.stops || []).map(stopOut) }));
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({ k: req.query.k, short: r.short, long: r.long, color: r.color, dirs });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
};
