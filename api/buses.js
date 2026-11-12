// All live Rapid KL buses (incl. MRT feeder), labelled with route, direction and destination.
const { liveBuses } = require('./_lib/gtfs');

module.exports = async (req, res) => {
  try {
    const data = await liveBuses();
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.status(data.buses.length || !data.errors.length ? 200 : 502).json({ ...data, count: data.buses.length });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String(e.message || e), buses: [], errors: [String(e.message || e)] });
  }
};
