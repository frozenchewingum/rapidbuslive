// Temporary: fetch the rapid-track endpoints server-side and show status + a sample of each response.
// ?route=590
const BASE = 'https://rapid-track.vercel.app';

async function sample(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { headers: { Accept: 'application/json', 'User-Agent': 'RapidBusLive/1.0' } });
    const text = await r.text();
    let shape = null;
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : Object.values(j).find(Array.isArray);
      shape = {
        type: Array.isArray(j) ? 'array' : typeof j,
        topKeys: Array.isArray(j) ? undefined : Object.keys(j).slice(0, 20),
        items: arr ? arr.length : undefined,
        first: arr ? arr.slice(0, 2) : undefined,
      };
    } catch {}
    return { path, status: r.status, ms: Date.now() - t0, contentType: r.headers.get('content-type'), shape, body: shape ? undefined : text.slice(0, 2500) };
  } catch (e) {
    return { path, error: String(e.message || e), ms: Date.now() - t0 };
  }
}

module.exports = async (req, res) => {
  const route = encodeURIComponent(String(req.query.route || '590'));
  const results = await Promise.all([
    sample(`/api/track/raw?route=${route}`),
    sample('/api/data?query=routes'),
    sample(`/api/data?query=stops&route=${route}`),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ now: new Date().toISOString(), results });
};
