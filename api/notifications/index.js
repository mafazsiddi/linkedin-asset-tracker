const { query } = require('../../lib/db');
const { json, methodNotAllowed, withHandler } = require('../../lib/util');

// GET  /api/notifications        -> list
// POST /api/notifications/read   -> {} marks all read, {"clear":true} deletes all
//
// The two used to be separate function files. Vercel's Hobby plan allows 12 Serverless Functions
// per deployment and this project sits exactly on that limit, so the read/clear action is folded
// in here and vercel.json rewrites the /read path onto this function — the public API is unchanged.
module.exports = withHandler(async function handler(req, res) {
  if (req.method === 'GET') {
    const { rows } = await query('select * from notifications order by created_at desc limit 60');
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const { clear } = req.body || {};
    if (clear) {
      await query('delete from notifications');
    } else {
      await query('update notifications set read = true where read = false');
    }
    return json(res, 200, { ok: true });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
