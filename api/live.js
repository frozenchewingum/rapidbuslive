// Live buses for one route, open feed + MyRapid Kiosk merged. ?k=<category>|<route_id>
const { CATS } = require('./_lib/gtfs');
const { routeLive } = require('./_lib/merge');

module.exports = async (req, res) => {
  const k = String(req.query.k || '');
  if (!CATS.includes(k.split('|')[0]) || !k.includes('|')) return res.status(400).json({ error: 'Unknown route' });
  try {
    const data = await routeLive(k);
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    res.status(200).json(data);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e) });
  }
};
