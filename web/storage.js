// Where book files live.
//
//   - local (default): data/books/<user-id>/<filename> on this machine's
//     disk; uploads go through the server (multer) and downloads stream
//     from it.
//   - supabase (SUPABASE_URL + SUPABASE_ANON_KEY set, Postgres required):
//     a private Supabase Storage bucket, "books". Serverless hosts cap
//     request and response bodies (4.5 MB on Vercel), so the browser
//     uploads and downloads the file directly. The server never holds a
//     Storage admin key: it records a short-lived ticket for one object
//     path in reader.storage_tickets, and the bucket's policies let the
//     public anon key act on that path only while the ticket is live (see
//     supabase/migrations/). Object paths contain a random UUID, so a
//     ticket can't be used to reach anyone else's book.

const crypto = require("node:crypto");
const path = require("node:path");
const { query, queryOne, IS_POSTGRES } = require("./db");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const MODE = SUPABASE_URL && SUPABASE_ANON_KEY ? "supabase" : "local";
const BUCKET = "books";
const TICKET_MINUTES = 15;
// Supabase's free plan caps a single object at 50 MB.
const SUPABASE_MAX_BYTES = 50 * 1024 * 1024;

if (MODE === "supabase" && !IS_POSTGRES) {
  throw new Error("Supabase Storage needs DATABASE_URL (tickets live in Postgres)");
}

function safeFilename(originalName) {
  const base = path.basename(originalName || "book");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "book";
}

function objectUrl(kind, objectPath) {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  const prefix = kind === "download" ? "object/authenticated" : "object";
  return `${SUPABASE_URL}/storage/v1/${prefix}/${BUCKET}/${encoded}`;
}

function authHeaders() {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
}

async function issueTicket(objectPath, purpose) {
  // Opportunistic cleanup keeps the table small without a cron job.
  await query("DELETE FROM storage_tickets WHERE expires_at < now() - interval '1 day'");
  await query(
    `INSERT INTO storage_tickets (object_path, purpose, expires_at)
     VALUES (?, ?, now() + make_interval(mins => ?))
     ON CONFLICT (object_path, purpose) DO UPDATE SET expires_at = excluded.expires_at`,
    [objectPath, purpose, TICKET_MINUTES]
  );
}

async function revokeTicket(objectPath, purpose) {
  await query("DELETE FROM storage_tickets WHERE object_path = ? AND purpose = ?", [objectPath, purpose]);
}

// Start a direct-to-Storage upload. Returns where and how the browser
// should POST the file body.
async function createUpload(userId, originalName) {
  const objectPath = `${userId}/${crypto.randomUUID()}-${safeFilename(originalName)}`;
  await issueTicket(objectPath, "upload");
  return {
    objectPath,
    url: objectUrl("upload", objectPath),
    headers: { ...authHeaders(), "x-upsert": "false" },
    maxBytes: SUPABASE_MAX_BYTES,
  };
}

// Size in bytes of an uploaded object, or null if it isn't there.
async function uploadedSize(objectPath) {
  const row = await queryOne(
    "SELECT metadata FROM storage.objects WHERE bucket_id = ? AND name = ?",
    [BUCKET, objectPath]
  );
  if (!row) return null;
  const size = Number(row.metadata && row.metadata.size);
  return Number.isFinite(size) ? size : 0;
}

async function finishUpload(objectPath) {
  await revokeTicket(objectPath, "upload");
}

// Where and how the browser can GET the file for the next few minutes.
async function createDownload(objectPath) {
  await issueTicket(objectPath, "read");
  return { url: objectUrl("download", objectPath), headers: authHeaders() };
}

async function remove(objectPath) {
  await issueTicket(objectPath, "delete");
  try {
    const res = await fetch(objectUrl("delete", objectPath), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      console.error(`Storage delete failed for ${objectPath}: HTTP ${res.status}`);
    }
  } finally {
    await revokeTicket(objectPath, "delete");
  }
}

module.exports = {
  MODE,
  SUPABASE_URL,
  safeFilename,
  createUpload,
  uploadedSize,
  finishUpload,
  createDownload,
  remove,
};
