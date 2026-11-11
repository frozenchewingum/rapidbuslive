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
  const parts = String(long || '').split(/\s+(?:-|–|to|ke)\s+/i).map((x) => x.trim()).filter(Boolean);
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
        const h = get(r, c('trip_headsign')), shape = get(r, c('shape_id'));
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
        if (id && isFinite(lat) && isFinite(lon)) stops.set(id, { id, name: get(r, c('stop_name')) || id, lat, lon, routes: new Set() });
      });
      const repTrips = new Map(), repShapes = new Map();
      for (const route of b.routes.values()) for (const [d, dir] of route.dirs) {
        if (dir.repTrip) repTrips.set(dir.repTrip, { route, d, seq: [] });
        if (dir.shape) repShapes.set(dir.shape, []);
      }
      eachRow(f['stop_times.txt'], (r, c) => {
        const rt = repTrips.get(get(r, c('trip_id')));
        if (rt) rt.seq.push([parseInt(get(r, c('stop_sequence')), 10) || 0, get(r, c('stop_id'))]);
      });
      eachRow(f['shapes.txt'], (r, c) => {
        const pts = repShapes.get(get(r, c('shape_id')));
        if (pts) pts.push([parseInt(get(r, c('shape_pt_sequence')), 10) || 0, +(+get(r, c('shape_pt_lat'))).toFixed(5), +(+get(r, c('shape_pt_lon'))).toFixed(5)]);
      });
      for (const { route, d, seq } of repTrips.values()) {
        const dir = route.dirs.get(d);
        seq.sort((a, b2) => a[0] - b2[0]);
        dir.stops = seq.map(([, sid]) => stops.get(sid)).filter(Boolean);
        for (const st of dir.stops) st.routes.add(route.id);
        if (!dir.headsign && dir.stops.length) dir.headsign = dir.stops[dir.stops.length - 1].name;
        const pts = repShapes.get(dir.shape);
        dir.line = pts && pts.length > 1
          ? pts.sort((a, b2) => a[0] - b2[0]).map((p) => [p[1], p[2]])
          : dir.stops.map((st) => [+st.lat.toFixed(5), +st.lon.toFixed(5)]);
      }
      return { ...b, stops };
    });
    s.full.catch(() => { delete s.full; });
  }
  return s.full;
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

module.exports = { CATS, base, full, realtime, eachRow, unzip };
