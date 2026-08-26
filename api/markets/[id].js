const { query } = require('../../lib/db');
const { json, methodNotAllowed, withHandler } = require('../../lib/util');

module.exports = withHandler(async function handler(req, res) {
  const id = Number(req.query.id);

  if (req.method === 'PUT') {
    const { name, pocName, channel, driveFolderLink, notes } = req.body || {};
    const { rows } = await query(
      `update markets set
         name = coalesce($2, name),
         poc_name = coalesce($3, poc_name),
         channel = coalesce($4, channel),
         drive_folder_link = coalesce($5, drive_folder_link),
         notes = coalesce($6, notes)
       where id = $1 returning *`,
      [id, name, pocName, channel, driveFolderLink, notes]
    );
    if (!rows.length) return json(res, 404, { error: 'Not found' });
    return json(res, 200, rows[0]);
  }

  if (req.method === 'DELETE') {
    await query('delete from markets where id = $1', [id]);
    return json(res, 204, null);
  }

  return methodNotAllowed(res, ['PUT', 'DELETE']);
});
