const { query } = require('../../lib/db');
const { json, methodNotAllowed } = require('../../lib/util');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { rows } = await query('select * from notifications order by created_at desc limit 60');
  return json(res, 200, rows);
};
