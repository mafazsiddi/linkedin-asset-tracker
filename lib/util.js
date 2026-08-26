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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(v) {
  return typeof v === 'string' && ISO_DATE.test(v);
}

// Inclusive list of YYYY-MM-DD strings from start to end. Pure UTC arithmetic so it can't drift
// with the host's timezone the way `new Date('2026-08-11')` + local getters would.
function eachDay(startISO, endISO) {
  const out = [];
  let t = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

function addDaysISO(dateISO, delta) {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}

// Every handler is wrapped in this. Without it, any throw (a dead DB credential, a missing env
// var) escapes into the serverless runtime and the caller gets an opaque, bodyless
// FUNCTION_INVOCATION_FAILED page — which is indistinguishable from "the whole app is down" and
// tells nobody what actually broke. Returning structured JSON means the UI can surface the real
// reason instead of a generic "could not reach the backend".
function withHandler(fn) {
  return async function wrapped(req, res) {
    try {
      return await fn(req, res);
    } catch (e) {
      console.error(`[${req.method} ${req.url}]`, e);
      if (res.headersSent) return undefined;
      const isConfig = /POSTGRES_URL|DATABASE_URL/.test(e.message || '');
      const isAuth = e.code === '28P01' || e.code === '28000';
      const isMissingTable = e.code === '42P01';
      let hint;
      if (isConfig) hint = 'POSTGRES_URL is not set on this deployment.';
      else if (isAuth) hint = 'The database rejected the credentials — POSTGRES_URL is stale. Rotate it in the Vercel project and redeploy.';
      else if (isMissingTable) hint = 'The database is reachable but the schema is missing. Run db/schema.sql against it.';
      return json(res, 500, { error: e.message || 'Internal error', code: e.code || undefined, hint });
    }
  };
}

module.exports = {
  json, methodNotAllowed, todayISO, currentMonthRange,
  isISODate, eachDay, addDaysISO, withHandler, ISO_DATE
};
