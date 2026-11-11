// Route names from the GTFS Static zip (routes.txt), unzipped without dependencies.
const zlib = require('zlib');

const ALLOWED = new Set(['rapid-bus-kl', 'rapid-bus-mrtfeeder']);

function extract(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip');
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
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.split('/').pop() === wanted) {
      const ln = zip.readUInt16LE(local + 26), le = zip.readUInt16LE(local + 28);
      const data = zip.subarray(local + 30 + ln + le, local + 30 + ln + le + compSize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(wanted + ' not found');
}

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

module.exports = async (req, res) => {
  const category = ALLOWED.has(req.query.category) ? req.query.category : 'rapid-bus-kl';
  try {
    const r = await fetch(`https://api.data.gov.my/gtfs-static/prasarana?category=${category}`);
    if (!r.ok) throw new Error(`data.gov.my responded ${r.status}`);
    const rows = parseCsv(extract(Buffer.from(await r.arrayBuffer()), 'routes.txt'));
    const head = rows.shift().map((h) => h.trim());
    const col = (n) => head.indexOf(n);
    const routes = {};
    for (const row of rows) {
      const id = row[col('route_id')];
      if (!id) continue;
      routes[id] = {
        short: row[col('route_short_name')] || id,
        long: row[col('route_long_name')] || '',
      };
    }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json({ category, routes });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(err.message || err) });
  }
};
