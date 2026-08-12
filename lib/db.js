const { Pool, types } = require('pg');

// pg's default DATE (oid 1082) parser builds `new Date(year, month-1, day)` using the server
// process's LOCAL timezone, which silently shifts the value (e.g. on a UTC+5:30 host, a stored
// '2026-08-11' round-trips as '2026-08-10T18:30:00.000Z'). Keep it as the plain 'YYYY-MM-DD'
// string Postgres already gives us instead.
types.setTypeParser(1082, function(val){ return val; });

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Set POSTGRES_URL (or DATABASE_URL) to your Postgres connection string.');
    }
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: isLocal ? undefined : { rejectUnauthorized: false }
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { query, getPool };
