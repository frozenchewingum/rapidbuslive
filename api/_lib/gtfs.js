// Shared GTFS helpers: unzip, CSV, static timetable cache, realtime decoder.
// No dependencies. Static data is cached in memory per warm function instance.
const zlib = require('zlib');

const CATS = ['rapid-bus-kl', 'rapid-bus-mrtfeeder'];
const STATIC_URL = (cat) => `https://api.data.gov.my/gtfs-static/prasarana?category=${cat}`;
const RT_URL = (cat) => `https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=${cat}`;
const STATIC_TTL = 6 * 3600 * 1000;

/* ---------- zip ---------- */
function unzip(zip, wanted) {
  const want = new Set(wanted);
  const out = {};
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Static GTFS is not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen).split('/').pop();
    if (want.has(name)) {
      const ln = zip.readUInt16LE(local + 26), le = zip.readUInt16LE(local + 28);
      const start = local + 30 + ln + le;
      const data = zip.subarray(start, start + compSize);
      out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------- csv ---------- */
function splitQuoted(line) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}
// Calls fn(row, col) for each data row; col(name) gives the column index (-1 if absent).
function eachRow(text, fn) {
  if (!text) return;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const head = splitQuoted(lines[0]).map((h) => h.trim());
  const idx = {}; head.forEach((h, i) => (idx[h] = i));
  const col = (n) => (n in idx ? idx[n] : -1);
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    fn(l.indexOf('"') >= 0 ? splitQuoted(l) : l.split(','), col);
  }
}
const get = (row, i) => (i >= 0 && row[i] != null ? row[i].trim() : '');

// "HAB PASAR SENI" → "Hab Pasar Seni"; keeps codes (PJ445, KJ477) and known acronyms upper-case.
const ACRONYMS = new Set(['KL', 'KLCC', 'MRT', 'LRT', 'KTM', 'BRT', 'UIA', 'SOGO', 'PPR', 'TTDI', 'UTAR', 'UM', 'UKM', 'UPM', 'UITM', 'IKEA',
  'KPJ', 'PJ', 'SS', 'USJ', 'HKL', 'KLIA', 'TBS', 'JPN', 'PKNS', 'MBPJ', 'MBSA', 'DBKL', 'IOI', 'UCSI', 'MSU', 'MMU', 'AEON', 'NU', 'KLCC/', 'TRX', 'PWTC', 'MATRADE', 'MITEC', 'IJN', 'IPD', 'JKR', 'PPUM', 'UNITEN']);
function tidy(name) {
  const t = String(name || '').trim().replace(/\s+/g, ' ');
  if (!t || /[a-z]/.test(t)) return t;            // already mixed case
  return t.split(' ').map((w) => {
    if (ACRONYMS.has(w) || /\d/.test(w) || /^[A-Z]{1,2}$/.test(w) && w !== 'DI') return w;
    if (w === 'VIA' || w === 'KE' || w === 'DI' || w === 'DAN') return w.toLowerCase();
    return w.replace(/[A-Z][A-Z']*/g, (x) => x[0] + x.slice(1).toLowerCase());
  }).join(' ');
}

/* ---------- static cache ---------- */
const cache = {};
function slot(cat) {
  const s = cache[cat];
  if (s && Date.now() - s.at < STATIC_TTL) return s;
  return (cache[cat] = { at: Date.now() });
}
function zipFor(cat) {
  const s = slot(cat);
  if (!s.zip) {
    s.zip = fetch(STATIC_URL(cat)).then(async (r) => {
      if (!r.ok) throw new Error(`static ${cat}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    });
    s.zip.catch(() => { delete s.zip; });
  }
  return s.zip;
}

function headsignFromLongName(long, dir) {
  const parts = String(long || '').split(/\s+(?:-|–|~|to|ke)\s+/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  return dir === 1 ? parts[0] : parts[parts.length - 1];
}
function topKey(counts) {
  let best = '', n = -1;
  for (const [k, v] of counts) if (k && v > n) { best = k; n = v; }
  return best;
}

// Routes + trips: enough to label live buses with direction and destination.
function base(cat) {
  const s = slot(cat);
  if (!s.base) {
    s.base = zipFor(cat).then((zip) => {
      const f = unzip(zip, ['routes.txt', 'trips.txt']);
      const routes = new Map(), byShort = new Map(), trips = new Map();
      eachRow(f['routes.txt'], (r, c) => {
        const id = get(r, c('route_id'));
        if (!id) return;
        const short = get(r, c('route_short_name')) || id;
        const color = get(r, c('route_color'));
        routes.set(id, { id, short, long: get(r, c('route_long_name')), color: /^[0-9a-f]{6}$/i.test(color) ? '#' + color : '', dirs: new Map() });
        byShort.set(short.toUpperCase(), id);
      });
      eachRow(f['trips.txt'], (r, c) => {
        const tid = get(r, c('trip_id')), rid = get(r, c('route_id'));
        const route = routes.get(rid);
        if (!tid || !route) return;
        const d = get(r, c('direction_id')) === '1' ? 1 : 0;
        const h = tidy(get(r, c('trip_headsign'))), shape = get(r, c('shape_id'));
        trips.set(tid, { r: rid, d });
        let dir = route.dirs.get(d);
        if (!dir) route.dirs.set(d, (dir = { heads: new Map(), shapes: new Map(), firstTrip: {} }));
        if (h) dir.heads.set(h, (dir.heads.get(h) || 0) + 1);
        dir.shapes.set(shape, (dir.shapes.get(shape) || 0) + 1);
        if (!(shape in dir.firstTrip)) dir.firstTrip[shape] = tid;
      });
      for (const route of routes.values()) {
        for (const [d, dir] of route.dirs) {
          dir.headsign = topKey(dir.heads) || headsignFromLongName(route.long, d);
          dir.shape = topKey(dir.shapes);
          dir.repTrip = dir.firstTrip[dir.shape] || Object.values(dir.firstTrip)[0];
          delete dir.heads; delete dir.firstTrip; delete dir.shapes;
        }
      }
      return { cat, routes, byShort, trips };
    });
    s.base.catch(() => { delete s.base; });
  }
  return s.base;
}

// Adds stops, stop order per direction and route shapes.
function full(cat) {
  const s = slot(cat);
  if (!s.full) {
    s.full = Promise.all([base(cat), zipFor(cat)]).then(([b, zip]) => {
      const f = unzip(zip, ['stops.txt', 'stop_times.txt', 'shapes.txt']);
      const stops = new Map();
      eachRow(f['stops.txt'], (r, c) => {
        const id = get(r, c('stop_id'));
        const lat = parseFloat(get(r, c('stop_lat'))), lon = parseFloat(get(r, c('stop_lon')));
        if (id && isFinite(lat) && isFinite(lon)) stops.set(id, { id, name: tidy(get(r, c('stop_name'))) || id, lat, lon, routes: new Set() });
      });
      const repTrips = new Map(), repShapes = new Map();
      for (const route of b.routes.values()) for (const [d, dir] of route.dirs) {
        if (dir.repTrip) repTrips.set(dir.repTrip, { route, d, seq: [] });
        if (dir.shape) repShapes.set(dir.shape, []);
      }
      eachRow(f['stop_times.txt'], (r, c) => {
        const rt = repTrips.get(get(r, c('trip_id')));
        if (rt) rt.seq.push([parseInt(get(r, c('stop_sequence')), 10) || 0, get(r, c('stop_id')), tidy(get(r, c('stop_headsign')))]);
      });
      eachRow(f['shapes.txt'], (r, c) => {
        const pts = repShapes.get(get(r, c('shape_id')));
        if (pts) pts.push([parseInt(get(r, c('shape_pt_sequence')), 10) || 0, +(+get(r, c('shape_pt_lat'))).toFixed(5), +(+get(r, c('shape_pt_lon'))).toFixed(5)]);
      });
      for (const { route, d, seq } of repTrips.values()) {
        const dir = route.dirs.get(d);
        seq.sort((a, b2) => a[0] - b2[0]);
        const kept = seq.filter(([, sid]) => stops.has(sid));
        dir.stops = kept.map(([, sid]) => stops.get(sid));
        dir.stopHeads = kept.map(([, , h]) => h);
        for (const st of dir.stops) st.routes.add(route.id);
        if (!dir.headsign && dir.stops.length) dir.headsign = dir.stops[dir.stops.length - 1].name;
        const pts = repShapes.get(dir.shape);
        dir.line = pts && pts.length > 1
          ? pts.sort((a, b2) => a[0] - b2[0]).map((p) => [p[1], p[2]])
          : dir.stops.map((st) => [+st.lat.toFixed(5), +st.lon.toFixed(5)]);
        dir.line = startAtFirstStop(dir.line, dir.stops[0]);
      }
      for (const route of b.routes.values()) buildBranches(route);
      return { ...b, stops };
    });
    s.full.catch(() => { delete s.full; });
  }
  return s.full;
}

// Some loop routes' lines start partway round the loop rather than at the first stop. If the line is a
// closed loop and doesn't start near the first stop, rotate it so it does.
function startAtFirstStop(line, first) {
  if (!first || !line || line.length < 3) return line;
  const m = (a, b) => Math.hypot((a[0] - b[0]) * 110574, (a[1] - b[1]) * 111100);
  const fp = [first.lat, first.lon];
  if (m(line[0], fp) < 150) return line;                       // already starts there
  if (m(line[0], line[line.length - 1]) > 300) return line;   // not a closed loop
  let k = 0, bd = Infinity;
  line.forEach((p, i) => { const d = m(p, fp); if (d < bd) { bd = d; k = i; } });
  if (bd > 300 || k === 0) return line;
  return line.slice(k).concat(line.slice(1, k + 1));
}

/* ---------- branches: what riders think of as "directions" ----------
   Two-direction routes: one branch per direction. Round-trip loops (most Rapid KL routes) have a single
   GTFS direction whose per-stop headsign changes partway (e.g. 590: stops 1–45 "Hab Pasar Seni",
   46–103 "Bandar Sungai Long"); each such stretch becomes its own branch. */
const MIN_LEG_STOPS = 3;
function buildBranches(route) {
  route.branches = [];
  for (const [d, dir] of [...route.dirs].sort((a, b) => a[0] - b[0])) {
    const n = (dir.stops || []).length;
    const heads = (dir.stopHeads || []).slice();
    // fill gaps: blank stop headsigns take the trip headsign, then the last stop's name
    for (let i = 0; i < n; i++) if (!heads[i]) heads[i] = dir.headsign || (n ? dir.stops[n - 1].name : '');
    let legs = [];
    for (let i = 0; i < n; i++) {
      if (!legs.length || legs[legs.length - 1].to !== heads[i]) legs.push({ to: heads[i], from: i, end: i });
      else legs[legs.length - 1].end = i;
    }
    // fold tiny stretches (e.g. a terminus stop carrying the next trip's headsign) into a neighbour
    for (let i = 0; i < legs.length && legs.length > 1;) {
      const L = legs[i];
      if (L.end - L.from + 1 >= MIN_LEG_STOPS) { i++; continue; }
      if (i > 0) legs[i - 1].end = L.end; else legs[1].from = L.from;
      legs.splice(i, 1);
      for (let j = 1; j < legs.length; j++) if (legs[j].to === legs[j - 1].to) { legs[j - 1].end = legs[j].end; legs.splice(j, 1); j--; }
    }
    if (!legs.length) legs = [{ to: dir.headsign || '', from: 0, end: Math.max(0, n - 1) }];
    const g = geom(dir);
    legs.forEach((L, i) => {
      L.startAlong = i === 0 ? -Infinity : g.stopAlong[L.from];
      L.endAlong = i === legs.length - 1 ? Infinity : g.stopAlong[legs[i + 1].from];
      L.bi = route.branches.length;
      L.d = d;
      route.branches.push(L);
    });
    dir.legs = legs;
    dir.heads = heads;
  }
}
// Which branch a point along real direction d belongs to.
function branchAt(route, d, along) {
  const dir = route.dirs.get(d);
  if (!dir || !dir.legs) return null;
  return dir.legs.find((L) => along >= L.startAlong && along < L.endAlong) || dir.legs[dir.legs.length - 1];
}
// Branch serving stop index idx of real direction d.
function branchOfStop(route, d, idx) {
  const dir = route.dirs.get(d);
  if (!dir || !dir.legs) return null;
  return dir.legs.find((L) => idx >= L.from && idx <= L.end) || null;
}
// Locate a bus on a route: real direction, branch, distance along. Uses heading when the route
// doubles back on the same road (loops), so a bus isn't put on the opposite stretch.
function locate(route, lat, lon, angle, dHint) {
  if (!route || !route.dirs) return null;
  let best = null;
  for (const [d, dir] of route.dirs) {
    if (dHint != null && d !== dHint) continue;
    if (!dir.line || dir.line.length < 2) continue;
    const g = geom(dir);
    const pr = projectHeading(g, lat, lon, angle);
    if (!pr || pr.dist > 400) continue;
    const score = pr.dist + (pr.headingOk === false ? 1000 : 0);
    if (!best || score < best.score) best = { d, pr, score };
  }
  if (!best) return null;
  const leg = branchAt(route, best.d, best.pr.along);
  return { d: best.d, along: best.pr.along, dist: best.pr.dist, headingOk: best.pr.headingOk, branch: leg };
}
function projectHeading(g, lat, lon, angle) {
  if (angle == null || !isFinite(angle)) { const p = project(g, lat, lon); return { ...p, headingOk: null }; }
  const [x, y] = xy(lat, lon);
  let best = null, any = null;
  for (let i = 1; i < g.pts.length; i++) {
    const [ax, ay] = g.pts[i - 1], [bx, by] = g.pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const dist = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    const cand = { dist, along: g.cum[i - 1] + t * Math.sqrt(L2), seg: i };
    if (!any || dist < any.dist) any = cand;
    const segB = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    let diff = Math.abs(segB - angle) % 360; if (diff > 180) diff = 360 - diff;
    if (diff <= 75 && dist <= 400 && (!best || dist < best.dist)) best = cand;
  }
  return best ? { ...best, headingOk: true } : any ? { ...any, headingOk: false } : null;
}

/* ---------- realtime protobuf ---------- */
class Reader {
  constructor(buf, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }
  varint() { let r = 0, m = 1, b; do { b = this.buf[this.pos++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return r; }
  tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; }
  bytes() { const len = this.varint(); const s = this.pos; this.pos += len; return [s, this.pos]; }
  string() { const [s, e] = this.bytes(); return this.buf.toString('utf8', s, e); }
  float() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  skip(w) {
    if (w === 0) this.varint(); else if (w === 1) this.pos += 8; else if (w === 2) this.bytes(); else if (w === 5) this.pos += 4;
    else throw new Error('Unsupported wire type ' + w);
  }
  sub(range) { return new Reader(this.buf, range[0], range[1]); }
}
function parse(r, h) {
  const o = {};
  while (r.pos < r.end) { const [f, w] = r.tag(); if (h[f] && (w === 2 || w === 5 || w === 0)) h[f](r, o); else r.skip(w); }
  return o;
}
const H = {
  trip: { 1: (r, o) => (o.tripId = r.string()), 5: (r, o) => (o.routeId = r.string()), 6: (r, o) => (o.dir = r.varint()) },
  pos: { 1: (r, o) => (o.lat = r.float()), 2: (r, o) => (o.lon = r.float()), 3: (r, o) => (o.bearing = r.float()), 5: (r, o) => (o.speed = r.float()) },
  veh: { 1: (r, o) => (o.id = r.string()), 2: (r, o) => (o.label = r.string()), 3: (r, o) => (o.plate = r.string()) },
};
H.vp = {
  1: (r, o) => (o.trip = parse(r.sub(r.bytes()), H.trip)),
  2: (r, o) => (o.pos = parse(r.sub(r.bytes()), H.pos)),
  5: (r, o) => (o.ts = r.varint()),
  8: (r, o) => (o.veh = parse(r.sub(r.bytes()), H.veh)),
};
H.entity = { 1: (r, o) => (o.id = r.string()), 4: (r, o) => (o.vp = parse(r.sub(r.bytes()), H.vp)) };
H.header = { 3: (r, o) => (o.ts = r.varint()) };
H.feed = { 1: (r, o) => (o.header = parse(r.sub(r.bytes()), H.header)), 2: (r, o) => (o.entities || (o.entities = [])).push(parse(r.sub(r.bytes()), H.entity)) };

async function realtime(cat) {
  const r = await fetch(RT_URL(cat), { headers: { 'User-Agent': 'RapidBusLive/1.1' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`live ${cat}: HTTP ${r.status}`);
  const feed = parse(new Reader(Buffer.from(await r.arrayBuffer())), H.feed);
  return { ts: (feed.header && feed.header.ts) || null, entities: feed.entities || [] };
}


/* ---------- labelled live buses (cached briefly per instance) ---------- */
// Real direction (rd), branch index (bi, used by the app as "direction") and destination for a bus.
function assignBranch(route, lat, lon, bearing, dHint) {
  if (!route) return { rd: dHint, bi: dHint, to: '' };
  if (!route.branches || !route.branches.length) {
    const dir = dHint != null ? route.dirs.get(dHint) : null;
    return { rd: dHint, bi: dHint, to: dir ? dir.headsign : '' };
  }
  const loc = locate(route, lat, lon, bearing, dHint);
  if (loc && loc.branch && loc.headingOk !== false) return { rd: loc.d, bi: loc.branch.bi, to: loc.branch.to };
  if (route.branches.length === 1) return { rd: route.branches[0].d, bi: 0, to: route.branches[0].to };
  // Known real direction with a single stretch
  if (dHint != null) {
    const legs = route.dirs.get(dHint) && route.dirs.get(dHint).legs;
    if (legs && legs.length === 1) return { rd: dHint, bi: legs[0].bi, to: legs[0].to };
  }
  return { rd: loc ? loc.d : dHint, bi: null, to: '' };
}

const MAX_AGE = 20 * 60;
let liveCache = null;
function liveBuses() {
  if (liveCache && Date.now() - liveCache.at < 15000) return liveCache.p;
  const p = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const errors = [];
    const results = await Promise.all(CATS.map(async (cat) => {
      const [rt, st] = await Promise.allSettled([realtime(cat), full(cat).catch(() => base(cat))]);
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
        if (d == null && route && route.dirs.size === 1) d = [...route.dirs.keys()][0];
        const bearing = vp.pos.bearing != null ? Math.round(vp.pos.bearing) : null;
        const { rd, bi, to } = assignBranch(route, vp.pos.lat, vp.pos.lon, bearing, d);
        const veh = vp.veh || {};
        buses.push({
          id: veh.id || veh.label || e.id,
          plate: veh.plate || veh.label || '',
          rk: `${cat}|${routeId}`,
          route: route ? route.short : routeId,
          d: bi, rd,
          to,
          lat: +vp.pos.lat.toFixed(6),
          lon: +vp.pos.lon.toFixed(6),
          bearing: vp.pos.bearing != null ? Math.round(vp.pos.bearing) : null,
          kmh: vp.pos.speed != null ? Math.round(vp.pos.speed * 3.6) : null,
          ts: vp.ts || rt.value.ts || null,
        });
      }
      return { buses, ts: rt.value.ts };
    }));
    return {
      now, errors,
      feedTs: Math.max(0, ...results.map((r) => r.ts || 0)) || null,
      buses: results.flatMap((r) => r.buses),
    };
  })();
  liveCache = { at: Date.now(), p };
  p.catch(() => { liveCache = null; });
  return p;
}

/* ---------- geometry: distance along a route line ---------- */
const M_LAT = 110574, M_LON = 111320 * Math.cos(3.1 * Math.PI / 180);
const xy = (lat, lon) => [lon * M_LON, lat * M_LAT];
function geom(dir) {
  if (dir._g) return dir._g;
  const pts = (dir.line || []).map(([la, lo]) => xy(la, lo));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const g = { pts, cum };
  // Stop positions along the line, in order. Each stop is searched for only a short way past the
  // previous one, taking the first segment that passes right by it: on loops the return road often
  // runs alongside the outbound road, and a plain nearest-segment search would jump to it.
  let from = 1, prevAlong = 0;
  g.stopAlong = (dir.stops || []).map((st, k) => {
    const [x, y] = xy(st.lat, st.lon);
    let best = null, firstClose = null;
    // The first stop is at the start of the line. On a loop the line also passes it again at the very
    // end, so only look near the start for it.
    const windowM = k === 0 ? FIRST_STOP_WINDOW_M : STOP_WINDOW_M;
    for (let i = Math.max(1, from); i < pts.length; i++) {
      if (g.cum[i - 1] - prevAlong > windowM && best) break;
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const dist = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      const c = { dist, along: g.cum[i - 1] + t * Math.sqrt(L2), seg: i };
      if (!best || dist < best.dist) best = c;
      if (dist <= STOP_ON_LINE_M) {
        // keep going while still on this stop's stretch of road, to settle on the nearest point
        if (!firstClose || dist < firstClose.dist) firstClose = c;
      } else if (firstClose) break;
    }
    const pick = firstClose || best || { along: prevAlong, seg: from };
    from = pick.seg; prevAlong = Math.max(prevAlong, pick.along);
    return prevAlong;
  });
  return (dir._g = g);
}
const STOP_WINDOW_M = 15000;  // how far past the previous stop to look for the next one (highway stretches can be long)
const STOP_ON_LINE_M = 35;    // a stop this close to the line is "on" it
const FIRST_STOP_WINDOW_M = 1500;
function project(g, lat, lon, from = 0) {
  const [x, y] = xy(lat, lon);
  let best = { dist: Infinity, along: 0, seg: from };
  for (let i = Math.max(1, from); i < g.pts.length; i++) {
    const [ax, ay] = g.pts[i - 1], [bx, by] = g.pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) best = { dist, along: g.cum[i - 1] + t * Math.sqrt(L2), seg: i };
  }
  return best;
}

module.exports = { CATS, base, full, realtime, liveBuses, geom, project, projectHeading, locate, assignBranch, branchOfStop, tidy, eachRow, unzip };
