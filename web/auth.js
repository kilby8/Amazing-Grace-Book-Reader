// Auth helpers: user creation, password verification, and middleware.
//
// Password storage: bcrypt with cost 12. Verification uses the constant-time
// compare that bcrypt.compare provides. Username is case-folded on
// insert/lookup so "Alice" and "alice" resolve to the same account (and
// the unique index prevents collisions).
//
// requireAuth is a route middleware that 401s if there's no user_id on
// the session. It does NOT check ownership - that's the caller's job.

const bcrypt = require("bcrypt");
const { getDb } = require("./db");

const BCRYPT_COST = 12;
const MIN_USERNAME_LEN = 3;
const MAX_USERNAME_LEN = 32;
const MIN_PASSWORD_LEN = 6;

function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

async function createUser(username, password) {
  const u = normalizeUsername(username);
  if (u.length < MIN_USERNAME_LEN || u.length > MAX_USERNAME_LEN) {
    throw new Error("Username must be 3-32 characters");
  }
  if (!/^[a-z0-9._-]+$/.test(u)) {
    throw new Error("Username may only contain letters, digits, dots, underscores, dashes");
  }
  const p = String(password || "");
  if (p.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const hash = await bcrypt.hash(p, BCRYPT_COST);
  const db = getDb();
  try {
    const info = db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(u, hash);
    return { id: info.lastInsertRowid, username: u };
  } catch (e) {
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new Error("That username is already taken");
    }
    throw e;
  }
}

async function verifyUser(username, password) {
  const u = normalizeUsername(username);
  const db = getDb();
  const row = db
    .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(u);
  if (!row) return null;
  const ok = await bcrypt.compare(String(password || ""), row.password_hash);
  if (!ok) return null;
  return { id: row.id, username: row.username };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

module.exports = {
  createUser,
  verifyUser,
  requireAuth,
  normalizeUsername,
};
