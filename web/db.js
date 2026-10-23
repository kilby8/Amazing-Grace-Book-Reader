// Database access for the Amazing Grace Reader library.
//
// Two backends behind one small async API:
//   - Postgres when DATABASE_URL is set (the hosted deploy uses Supabase
//     through its connection pooler; the tables live in the `reader`
//     schema, see supabase/migrations/).
//   - SQLite via Node's built-in `node:sqlite` otherwise (local use: no
//     server, no native compilation). The file lives at data/library.db at
//     the repo root, overridable via DB_PATH.
//
// SQL is written once with `?` placeholders and the SQLite/Postgres common
// subset (ON CONFLICT, RETURNING). query() returns an array of row objects.
//
// Tables:
//   users:  id, username (unique), password_hash (bcrypt), created_at
//   books:  id, user_id (fk), title, author, kind ('pdf'|'epub'),
//           filename (storage key: on-disk name, or object path in Supabase
//           Storage), size, added_at, last_opened_at,
//           visibility ('private'|'public'), shared_at (ms; null while private)
//   reading_progress: (user_id, book_id) pk, page (1-based), char_offset
//           (into the page's chunked text, see app.js), total_pages,
//           updated_at. Per reader, so a public book keeps each reader's
//           own place.
//   sessions: login sessions, see session-store.js
//   storage_tickets (Postgres only): short-lived Storage capabilities, see
//           storage.js
//
// Per-user isolation: every book query is scoped by user_id. The requireAuth
// middleware ensures the session is present; controllers additionally filter
// by user_id on the WHERE clause so a session for one user can never see
// another user's books even if the URL is guessed.

const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "library.db");
const IS_POSTGRES = Boolean(process.env.DATABASE_URL);

let _sqlite = null;
let _pool = null;

// ----- SQLite -----

function sqlite() {
  if (_sqlite) return _sqlite;
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _sqlite = new DatabaseSync(dbPath);
  // WAL for better concurrent reads; foreign keys for the ON DELETE CASCADE
  _sqlite.exec("PRAGMA journal_mode = WAL");
  _sqlite.exec("PRAGMA foreign_keys = ON");
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE IF NOT EXISTS books (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      author          TEXT,
      kind            TEXT NOT NULL CHECK (kind IN ('pdf','epub')),
      filename        TEXT NOT NULL,
      size            INTEGER NOT NULL,
      added_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      last_opened_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS books_user_id_idx ON books(user_id);
  `);
  // ----- Migrations -----
  // Idempotent: skip columns that already exist so re-opening is safe.
  const bookCols = new Set(_sqlite.prepare("PRAGMA table_info(books)").all().map((c) => c.name));
  if (!bookCols.has("visibility")) {
    _sqlite.exec(
      "ALTER TABLE books ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public'))"
    );
  }
  if (!bookCols.has("shared_at")) {
    _sqlite.exec("ALTER TABLE books ADD COLUMN shared_at INTEGER");
  }
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS reading_progress (
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      page        INTEGER NOT NULL,
      char_offset INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
  `);
  // Partial index for the public feed (only rows where it matters).
  _sqlite.exec(
    "CREATE INDEX IF NOT EXISTS books_public_shared_idx ON books(visibility, shared_at DESC) WHERE visibility = 'public'"
  );
  return _sqlite;
}

// ----- Postgres -----

function pool() {
  if (_pool) return _pool;
  const pg = require("pg");
  // BIGINT columns (ids, ms timestamps) come back as strings by default;
  // every value we store fits in a JS number.
  pg.types.setTypeParser(20, (v) => Number(v));
  _pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // One connection per serverless instance; the pooler fans out.
    max: Number(process.env.PG_POOL_MAX || 1),
    idleTimeoutMillis: 10_000,
    // The Supabase pooler requires TLS. Its certificate chains to
    // Supabase's own CA, not a public one, so PG_SSL_CA (PEM) enables
    // full verification; without it the link is encrypted but unverified.
    ssl: process.env.PG_SSL === "off"
      ? false
      : process.env.PG_SSL_CA
        ? { ca: process.env.PG_SSL_CA }
        : { rejectUnauthorized: false },
  });
  return _pool;
}

function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// ----- Public API -----

async function query(sql, params = []) {
  if (IS_POSTGRES) {
    try {
      const res = await pool().query(toPg(sql), params);
      return res.rows;
    } catch (e) {
      if (e.code === "23505") e.isUniqueViolation = true;
      throw e;
    }
  }
  try {
    // all() works for statements with or without RETURNING.
    return sqlite().prepare(sql).all(...params);
  } catch (e) {
    if (/UNIQUE constraint failed/.test(e.message)) e.isUniqueViolation = true;
    throw e;
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
  }
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

module.exports = { query, queryOne, closeDb, IS_POSTGRES };
