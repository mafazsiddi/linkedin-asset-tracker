const { query } = require('../../lib/db');
const { json, methodNotAllowed, withHandler } = require('../../lib/util');

module.exports = withHandler(async function handler(req, res) {
  if (req.method === 'GET') {
    const { rows } = await query('select * from markets order by name');
    return json(res, 200, rows);
  }

  if (req.method === 'POST') {
    const { name, pocName, channel, driveFolderLink, notes } = req.body || {};
    if (!name) return json(res, 400, { error: 'name is required' });
    const { rows } = await query(
      `insert into markets (name, poc_name, channel, drive_folder_link, notes)
       values ($1, $2, $3, $4, $5) returning *`,
      [name, pocName || null, channel || null, driveFolderLink || null, notes || null]
    );
    return json(res, 201, rows[0]);
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
