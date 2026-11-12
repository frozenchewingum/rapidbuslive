// Merge the open GTFS-R feed with the MyRapid Kiosk feed for one route.
// Buses are matched by number plate; Kiosk buses get direction from the open feed when matched,
// otherwise from their heading compared with each direction's route line.
const { full, base, liveBuses, geom, project } = require('./gtfs');
const { kioskCode, snapshot, myt } = require('./kiosk');

const MAX_AGE = 20 * 60;
const plateKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360) + 360) % 360; return d > 180 ? 360 - d : d; };

function segBearing(g, seg) {
  const a = g.pts[Math.max(0, seg - 1)], b = g.pts[Math.max(1, seg)];
  if (!a || !b) return null;
  return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360; // x=east, y=north
}

// Learned mapping from Kiosk "dir" codes to GTFS direction, per route (votes from confident inferences).
const dirVotes = new Map();
function vote(rk, code, d) {
  const k = rk + '|' + code;
  const v = dirVotes.get(k) || [0, 0];
  v[d]++; dirVotes.set(k, v);
}
function voted(rk, code) {
  const v = dirVotes.get(rk + '|' + code);
  if (!v) return null;
  const n = v[0] + v[1];
  if (n < 3) return null;
  if (v[0] / n >= 0.8) return 0;
  if (v[1] / n >= 0.8) return 1;
  return null;
}

function inferDir(route, lat, lon, angle) {
  if (!route || angle == null || !route.dirs) return null;
  let best = null;
  for (const [d, dir] of route.dirs) {
    if (!dir.line || dir.line.length < 2) continue;
    const g = geom(dir);
    const pr = project(g, lat, lon);
    if (pr.dist > 200) continue;
    const sb = segBearing(g, pr.seg);
    if (sb == null) continue;
    const diff = angDiff(angle, sb);
    if (diff < 70 && (!best || diff < best.diff)) best = { d, diff };
  }
  return best ? best.d : null;
}

async function routeLive(rk) {
  const [cat, ...rest] = String(rk).split('|');
  const id = rest.join('|');
  const [liveR, staticR] = await Promise.allSettled([liveBuses(), full(cat).catch(() => base(cat))]);
  const live = liveR.status === 'fulfilled' ? liveR.value : { now: Math.floor(Date.now() / 1000), buses: [] };
  const s = staticR.status === 'fulfilled' ? staticR.value : null;
  const route = s && s.routes.get(id);
  const short = route ? route.short : id;
  const open = live.buses.filter((b) => b.rk === rk);
  const byPlate = new Map(open.filter((b) => b.plate).map((b) => [plateKey(b.plate), b]));

  const code = kioskCode(short);
  const k = await snapshot(code);
  let rows = k.rows.filter((r) => r && isFinite(+r.latitude) && isFinite(+r.longitude) && +r.latitude);
  const onRoute = rows.filter((r) => !r.route || String(r.route).toUpperCase().startsWith(code));
  if (onRoute.length) rows = onRoute;

  const now = live.now;
  const used = new Set(), out = [];
  for (const r of rows) {
    const ts = myt(r.dt_gps) || myt(r.dt_received);
    if (ts && now - ts > MAX_AGE) continue;
    const lat = +(+r.latitude).toFixed(6), lon = +(+r.longitude).toFixed(6);
    const angle = r.angle != null && r.angle !== '' ? Math.round(+r.angle) : null;
    const pk = plateKey(r.bus_no);
    const match = pk && byPlate.get(pk);
    if (match) used.add(match.id);
    // Prefer whichever source reported more recently for position.
    if (match && match.ts && ts && match.ts > ts) { out.push({ ...match, src: 'both' }); continue; }
    let d = match && match.d != null ? match.d : inferDir(route, lat, lon, angle);
    const dirCode = r.dir != null ? String(r.dir) : null;
    if (d != null && dirCode != null && (!match || match.d == null)) vote(rk, dirCode, d);
    if (d == null && dirCode != null) d = voted(rk, dirCode);
    if (d == null && route && route.dirs.size === 1) d = [...route.dirs.keys()][0];
    const dir = route && d != null ? route.dirs.get(d) : null;
    out.push({
      id: match ? match.id : 'K' + (pk || `${lat},${lon}`),
      plate: r.bus_no || (match && match.plate) || '',
      rk, route: short, d,
      to: dir ? dir.headsign : '',
      lat, lon,
      bearing: angle,
      kmh: r.speed != null && r.speed !== '' ? Math.round(+r.speed) : null,
      ts: ts || (match && match.ts) || null,
      src: match ? 'both' : 'kiosk',
      off: String(r.engine_status) === '0' || undefined,   // engine off = not in service
    });
  }
  for (const b of open) if (!used.has(b.id)) out.push({ ...b, src: 'open' });
  return {
    now, buses: out,
    kiosk: { code, ok: k.ok, why: k.why, rows: k.rows.length },
    open: open.length,
  };
}

module.exports = { routeLive, inferDir };
