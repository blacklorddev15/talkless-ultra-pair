// Database layer for the TALKLESS ULTRA pairing portal.
//
// This is the `talkless_` variant of the shared portal: the Neon database it points at is
// shared with the other brand portals, which is why every table name is prefixed and why
// the prefix must never be inferred.
//
// The site keeps a CONTROL pool on the original DATABASE_URL DB; the ACTIVE database can be
// switched at runtime from the admin panel by storing a connection string in the control DB
// settings row (key: active_database_url). No redeploy needed.
const { Pool } = require('pg');

const PREFIX = 'talkless_';
const CONTROL_URL = String(process.env.DATABASE_URL || '');

function makePool(url) {
  return new Pool({
    connectionString: String(url).split('?')[0],
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    max: 3,
  });
}

const controlPool = CONTROL_URL ? makePool(CONTROL_URL) : null;
const poolCache = new Map(); // activeUrl -> Pool

function poolFor(url) {
  if (!poolCache.has(url)) poolCache.set(url, makePool(url));
  return poolCache.get(url);
}

// Schema to create when switching to an empty database. Deliberately run ONLY on that
// explicit action: the read paths must not issue DDL against a live shared database.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${PREFIX}pairing_requests (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pairing_code TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE TABLE IF NOT EXISTS ${PREFIX}sessions (
  id TEXT PRIMARY KEY,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}server_heartbeats (
  server_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}premium_keys (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused',
  used_phone TEXT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${PREFIX}settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Seed the three tracked servers. last_seen starts an hour in the past so a freshly created
// table never fakes "online" before a bot has actually pinged.
const SEED_SERVERS_SQL = `
INSERT INTO ${PREFIX}server_heartbeats (server_id, name, last_seen)
  SELECT gs, 'Server ' || gs, now() - interval '1 hour' FROM generate_series(1, 3) gs
  ON CONFLICT (server_id) DO NOTHING;
`;

async function readControl() {
  if (!controlPool) throw new Error('DATABASE_URL is not set on this deployment.');
  return controlPool;
}

// Give a database the portal schema + the control row, and return its pool.
async function ensureTarget(url) {
  const pool = poolFor(url);
  await pool.query(SCHEMA_SQL);
  await pool.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  await pool.query(SEED_SERVERS_SQL);
  return pool;
}

// Resolve the ACTIVE database URL (control DB settings row, falling back to the env var).
async function activeUrl() {
  const control = await readControl();
  try {
    const { rows } = await control.query(
      `SELECT value FROM ${PREFIX}settings WHERE key = 'active_database_url'`
    );
    if (rows[0] && rows[0].value) return rows[0].value;
  } catch (e) {
    // Settings table missing on a fresh database: fall back to the env DB.
    console.error('[db] activeUrl:', e && e.message);
  }
  return CONTROL_URL;
}

async function query(text, params) {
  const pool = poolFor(await activeUrl());
  return pool.query(text, params);
}

async function getSetting(key) {
  const { rows } = await query(`SELECT value FROM ${PREFIX}settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function switchActiveDatabase(newUrl) {
  if (!/^postgres(ql)?:\/\//i.test(String(newUrl || ''))) {
    throw new Error('Invalid connection string.');
  }
  const url = String(newUrl).trim();
  await ensureTarget(url); // validate + create the schema if the target is empty
  const control = await readControl();
  await control.query(
    `INSERT INTO ${PREFIX}settings (key, value) VALUES ('active_database_url', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [url]
  );
  return url;
}

module.exports = {
  PREFIX,
  controlPool,
  query,
  getSetting,
  setSetting,
  switchActiveDatabase,
  activeUrl,
  ensureTarget,
};
