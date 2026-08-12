const { query } = require('../../lib/db');
const { json, methodNotAllowed } = require('../../lib/util');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { clear } = req.body || {};
  if (clear) {
    await query('delete from notifications');
  } else {
    await query('update notifications set read = true where read = false');
  }
  return json(res, 200, { ok: true });
};
