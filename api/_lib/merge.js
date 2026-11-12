// Merge the open GTFS-R feed with the MyRapid Kiosk feed for one route.
// Buses are matched by number plate; Kiosk buses get direction from the open feed when matched,
// otherwise from their heading compared with each direction's route line.
const { full, base, liveBuses, assignBranch } = require('./gtfs');
const { kioskCode, snapshot, myt } = require('./kiosk');

const MAX_AGE = 20 * 60;
const plateKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Learned mapping from Kiosk "dir" codes to GTFS direction, per route (votes from confident inferences).
const dirVotes = new Map();
function vote(rk, code, d) {
  const k = rk + '|' + code;
  const v = dirVotes.get(k) || {};
  v[d] = (v[d] || 0) + 1; dirVotes.set(k, v);
}
function voted(rk, code) {
  const v = dirVotes.get(rk + '|' + code);
  if (!v) return null;
  const n = Object.values(v).reduce((a, b) => a + b, 0);
  if (n < 3) return null;
  for (const [bi, c] of Object.entries(v)) if (c / n >= 0.8) return +bi;
  return null;
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
    // Direction ("branch") and destination: from the open feed when matched, else from position + heading.
    let a = match && match.d != null ? { rd: match.rd, bi: match.d, to: match.to } : assignBranch(route, lat, lon, angle, null);
    const dirCode = r.dir != null ? String(r.dir) : null;
    if (a.bi != null && dirCode != null && !(match && match.d != null)) vote(rk, dirCode, a.bi);
    if (a.bi == null && dirCode != null) {
      const bi = voted(rk, dirCode);
      if (bi != null && route && route.branches && route.branches[bi]) a = { rd: route.branches[bi].d, bi, to: route.branches[bi].to };
    }
    out.push({
      id: match ? match.id : 'K' + (pk || `${lat},${lon}`),
      plate: r.bus_no || (match && match.plate) || '',
      rk, route: short, d: a.bi, rd: a.rd,
      to: a.to || '',
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

module.exports = { routeLive };
