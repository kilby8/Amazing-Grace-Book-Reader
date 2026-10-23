// Database-backed express-session store.
//
// The default MemoryStore drops every session when the process restarts,
// which signs everyone out on each deploy or reboot (and on serverless
// hosts, between any two requests that land on different instances). This
// store keeps sessions in the same database as the rest of the app (see
// db.js) and prunes expired rows on a timer.
//
// Table:
//   sessions: sid (pk), sess (JSON), expires (ms epoch)

const session = require("express-session");
const { query, queryOne } = require("./db");

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

// Adapts a promise to express-session's optional node-style callback.
function done(promise, cb, map = () => undefined) {
  promise.then(
    (v) => cb && cb(null, map(v)),
    (e) => cb && cb(e)
  );
}

class DbSessionStore extends session.Store {
  constructor() {
    super();
    this.prune();
    this._pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Don't keep the process alive just for pruning.
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  prune() {
    query("DELETE FROM sessions WHERE expires <= ?", [Date.now()]).catch((e) =>
      console.error("session prune failed:", e)
    );
  }

  get(sid, cb) {
    done(
      queryOne("SELECT sess FROM sessions WHERE sid = ? AND expires > ?", [sid, Date.now()]),
      cb,
      (row) => (row ? JSON.parse(row.sess) : null)
    );
  }

  set(sid, sess, cb) {
    done(
      query(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        [sid, JSON.stringify(sess), expiryFor(sess)]
      ),
      cb
    );
  }

  touch(sid, sess, cb) {
    done(query("UPDATE sessions SET expires = ? WHERE sid = ?", [expiryFor(sess), sid]), cb);
  }

  destroy(sid, cb) {
    done(query("DELETE FROM sessions WHERE sid = ?", [sid]), cb);
  }

  close() {
    clearInterval(this._pruneTimer);
  }
}

module.exports = { DbSessionStore };
