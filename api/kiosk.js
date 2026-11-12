// Check the MyRapid Kiosk live feed for one route: ?route=590 (or ?code=U590)
const { kioskCode, snapshot, myt } = require('./_lib/kiosk');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = req.query.code ? String(req.query.code).toUpperCase() : kioskCode(String(req.query.route || '590'));
  const t0 = Date.now();
  try {
    const k = await snapshot(code);
    const now = Date.now() / 1000;
    res.status(200).json({
      code, ok: k.ok, why: k.why, eio: k.eio, ms: Date.now() - t0,
      buses: k.rows.length,
      routesInPayload: [...new Set(k.rows.map((r) => r.route))].slice(0, 20),
      dirs: [...new Set(k.rows.map((r) => r.dir))],
      ages: k.rows.slice(0, 10).map((r) => { const t = myt(r.dt_gps); return t ? Math.round(now - t) + 's' : null; }),
      sample: k.rows.slice(0, 3),
      log: k.ok ? undefined : k.log,
    });
  } catch (e) {
    res.status(502).json({ code, error: String(e.message || e) });
  }
};
