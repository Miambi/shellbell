export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS computer (
  fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  phone_fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  name TEXT NOT NULL,
  push_token TEXT,
  push_platform TEXT,
  push_enabled INTEGER NOT NULL DEFAULT 1,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS pending_unpairs (
  phone_fp TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gate_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  admitted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ring_limits (
  session_id TEXT PRIMARY KEY,
  last_ring_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_limits (
  phone_fp TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`;
