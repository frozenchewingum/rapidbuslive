// Live Rapid KL bus positions: fetches the GTFS-Realtime protobuf from
// api.data.gov.my, decodes it (no dependencies) and returns JSON.

const ALLOWED = new Set(['rapid-bus-kl', 'rapid-bus-mrtfeeder']);

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf; this.pos = start; this.end = end;
  }
  varint() {
    let result = 0, mult = 1, b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mult;
      mult *= 128;
    } while (b & 0x80);
    return result;
  }
  tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; }
  bytes() { const len = this.varint(); const s = this.pos; this.pos += len; return [s, this.pos]; }
  string() { const [s, e] = this.bytes(); return this.buf.toString('utf8', s, e); }
  float() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  double() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error('Unsupported wire type ' + wire);
  }
  sub([s, e]) { return new Reader(this.buf, s, e); }
}

function parse(r, handlers) {
  const out = {};
  while (r.pos < r.end) {
    const [field, wire] = r.tag();
    const h = handlers[field];
    if (h) h(r, out, wire); else r.skip(wire);
  }
  return out;
}

const tripH = {
  1: (r, o) => (o.tripId = r.string()),
  2: (r, o) => (o.startTime = r.string()),
  3: (r, o) => (o.startDate = r.string()),
  5: (r, o) => (o.routeId = r.string()),
};
const posH = {
  1: (r, o) => (o.lat = r.float()),
  2: (r, o) => (o.lon = r.float()),
  3: (r, o) => (o.bearing = r.float()),
  4: (r, o) => (o.odometer = r.double()),
  5: (r, o) => (o.speed = r.float()),
};
const vehDescH = {
  1: (r, o) => (o.id = r.string()),
  2: (r, o) => (o.label = r.string()),
  3: (r, o) => (o.plate = r.string()),
};
const vehPosH = {
  1: (r, o) => (o.trip = parse(r.sub(r.bytes()), tripH)),
  2: (r, o) => (o.position = parse(r.sub(r.bytes()), posH)),
  5: (r, o) => (o.timestamp = r.varint()),
  7: (r, o) => (o.stopId = r.string()),
  8: (r, o) => (o.vehicle = parse(r.sub(r.bytes()), vehDescH)),
};
const entityH = {
  1: (r, o) => (o.id = r.string()),
  4: (r, o) => (o.vp = parse(r.sub(r.bytes()), vehPosH)),
};
const headerH = { 3: (r, o) => (o.timestamp = r.varint()) };

function decodeFeed(buf) {
  const r = new Reader(buf);
  const feed = { header: {}, entities: [] };
  while (r.pos < r.end) {
    const [field, wire] = r.tag();
    if (field === 1 && wire === 2) feed.header = parse(r.sub(r.bytes()), headerH);
    else if (field === 2 && wire === 2) feed.entities.push(parse(r.sub(r.bytes()), entityH));
    else r.skip(wire);
  }
  return feed;
}

module.exports = async (req, res) => {
  const category = ALLOWED.has(req.query.category) ? req.query.category : 'rapid-bus-kl';
  const url = `https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=${category}`;
  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'RapidBusLive/1.0' } });
    if (!upstream.ok) throw new Error(`data.gov.my responded ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const feed = decodeFeed(buf);
    const buses = [];
    for (const e of feed.entities) {
      const vp = e.vp;
      if (!vp || !vp.position || !vp.position.lat) continue;
      buses.push({
        id: (vp.vehicle && (vp.vehicle.id || vp.vehicle.label)) || e.id,
        plate: (vp.vehicle && (vp.vehicle.plate || vp.vehicle.label)) || '',
        route: (vp.trip && vp.trip.routeId) || '',
        trip: (vp.trip && vp.trip.tripId) || '',
        lat: vp.position.lat,
        lon: vp.position.lon,
        bearing: vp.position.bearing ?? null,
        speedKmh: vp.position.speed != null ? Math.round(vp.position.speed * 3.6) : null,
        ts: vp.timestamp || null,
      });
    }
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(200).json({ category, feedTimestamp: feed.header.timestamp || null, count: buses.length, buses });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
};
