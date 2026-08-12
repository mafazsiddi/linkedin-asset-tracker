function json(res, status, data) {
  if (data === null || data === undefined) {
    res.status(status).end();
    return;
  }
  res.status(status).json(data);
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  json(res, 405, { error: 'Method not allowed' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// First/last day of the current month, in YYYY-MM-DD, used to sum "current month, updated daily" totals.
function currentMonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

module.exports = { json, methodNotAllowed, todayISO, currentMonthRange };
