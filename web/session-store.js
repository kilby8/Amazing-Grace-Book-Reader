// SQLite-backed express-session store.
//
// The default MemoryStore drops every session when the process restarts,
// which signs everyone out on each deploy or reboot. This store keeps
// sessions in the same library.db the rest of the app uses (via node:sqlite,
// so no native modules), and prunes expired rows on a timer.
//
// Table:
//   sessions: sid (pk), sess (JSON), expires (ms epoch)

const session = require("express-session");
const { getDb } = require("./db");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

function expiryFor(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  if (exp) {
    const t = new Date(exp).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now() + ONE_DAY_MS;
}

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
    `);
    this.prune();
    this._pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Don't keep the process alive just for pruning.
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  prune() {
    try {
      getDb().prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    } catch (e) {
      console.error("session prune failed:", e);
    }
  }

  get(sid, cb) {
    try {
      const row = getDb()
        .prepare("SELECT sess FROM sessions WHERE sid = ? AND expires > ?")
        .get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      getDb()
        .prepare(
          `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
        )
        .run(sid, JSON.stringify(sess), expiryFor(sess));
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      getDb()
        .prepare("UPDATE sessions SET expires = ? WHERE sid = ?")
        .run(expiryFor(sess), sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      getDb().prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  close() {
    clearInterval(this._pruneTimer);
  }
}

module.exports = { SqliteSessionStore };
