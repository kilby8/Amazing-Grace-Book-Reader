// Progress + session gauntlet. Self-contained: starts its own server on a
// spare port with a throwaway data dir, so it runs anywhere (CI included).
//
//   node test-progress.mjs
//
// API checks: save/load reading position, per-reader isolation, input
// validation, logins surviving a server restart, logout removing the session.
// Browser check (runs when CHROME points at a Chrome/Chromium binary):
// reopening a book lands on the saved page and playback resumes there.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-progress-"));
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);

// A two-page PDF with enough text per page that every TTS engine splits a
// page into several chunks, so "resumed mid-page" is distinguishable from
// "restarted the page".
function makePdf(pages) {
  const objs = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const content = lines.map((l, j) => `BT /F1 10 Tf 30 ${800 - j * 14} Td (${l}) Tj ET`).join("\n");
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objs[pageIds[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const sentences = (page) => Array.from({ length: 12 }, (_, i) => `Page ${page} sentence ${i + 1} is long enough to be worth reading aloud.`);
const PDF_BYTES = makePdf([sentences(1), sentences(2)]);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH: join(DATA, "library.db"), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => { if (!/ExperimentalWarning|--trace-warnings/.test(String(d))) process.stderr.write(d); });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/me`); return; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  server = null;
}

// Minimal cookie-jar client: one per user.
function client() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async req(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      let body = opts.body;
      if (body && !(body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(body);
      }
      const res = await fetch(BASE + path, { ...opts, headers, body });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { status: res.status, json };
    },
  };
}

async function uploadPdf(c) {
  const form = new FormData();
  form.append("file", new Blob([PDF_BYTES], { type: "application/pdf" }), "two-pages.pdf");
  return c.req("/api/books", { method: "POST", body: form });
}

try {
  await startServer();
  const stamp = Date.now();
  const alice = client();
  const bob = client();
  check("alice registers", (await alice.req("/api/auth/register", { method: "POST", body: { username: `alice_${stamp}`, password: "password1" } })).status === 200);
  check("bob registers", (await bob.req("/api/auth/register", { method: "POST", body: { username: `bob_${stamp}`, password: "password1" } })).status === 200);

  const up = await uploadPdf(alice);
  const bookId = up.json && up.json.book && up.json.book.id;
  check("alice uploads a PDF", up.status === 200 && bookId, JSON.stringify(up.json));

  let r = await alice.req(`/api/books/${bookId}/progress`);
  check("no progress before reading", r.status === 200 && r.json.progress === null, JSON.stringify(r.json));

  r = await alice.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: 2, char_offset: 999999999, total_pages: 2 } });
  check("save progress", r.status === 200 && r.json.ok);
  r = await alice.req(`/api/books/${bookId}/progress`);
  check("load progress", r.json.progress && r.json.progress.page === 2 && r.json.progress.char_offset === 999999999 && r.json.progress.total_pages === 2, JSON.stringify(r.json));

  r = await alice.req("/api/books");
  const listed = r.json.books.find((b) => b.id === bookId);
  check("library list carries progress", listed && listed.progress_page === 2 && listed.progress_total_pages === 2, JSON.stringify(listed));

  r = await alice.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: 0 } });
  check("rejects page 0", r.status === 400);
  r = await alice.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: 1, char_offset: -5 } });
  check("rejects negative offset", r.status === 400);
  r = await alice.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: "abc" } });
  check("rejects non-numeric page", r.status === 400);

  r = await bob.req(`/api/books/${bookId}/progress`);
  check("bob can't read progress on alice's private book", r.status === 404);
  r = await bob.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: 1 } });
  check("bob can't write progress on alice's private book", r.status === 404);

  await alice.req(`/api/books/${bookId}/visibility`, { method: "POST", body: { visibility: "public" } });
  r = await bob.req(`/api/books/${bookId}/progress`, { method: "POST", body: { page: 1, char_offset: 7 } });
  check("bob saves his own place in a public book", r.status === 200);
  r = await bob.req(`/api/books/${bookId}/progress`);
  check("bob sees his own place", r.json.progress && r.json.progress.page === 1 && r.json.progress.char_offset === 7, JSON.stringify(r.json));
  r = await alice.req(`/api/books/${bookId}/progress`);
  check("alice's place is untouched", r.json.progress && r.json.progress.page === 2, JSON.stringify(r.json));

  check("anonymous progress request is rejected", (await client().req(`/api/books/${bookId}/progress`)).status === 401);

  // ----- Sessions survive a restart -----
  await stopServer();
  await startServer();
  r = await alice.req("/api/me");
  check("alice still signed in after restart", r.json && r.json.user && r.json.user.username === `alice_${stamp}`, JSON.stringify(r.json));
  r = await alice.req(`/api/books/${bookId}/progress`);
  check("progress survives restart", r.json.progress && r.json.progress.page === 2);

  // ----- Browser: reopening the book lands on the saved page -----
  if (CHROME) {
    const { default: puppeteer } = await import("puppeteer-core");
    // CHROME_ARGS adds launch flags, e.g. --proxy-server=... behind a proxy.
    const extraArgs = (process.env.CHROME_ARGS || "").split(" ").filter(Boolean);
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu", ...extraArgs] });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // CDN_DIR serves the cdnjs scripts (pdf.js, jszip) from a local copy,
      // laid out as <CDN_DIR>/<library>/<file>, for machines without
      // internet access. Other external requests are dropped.
      if (process.env.CDN_DIR) {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const url = new URL(req.url());
          if (url.origin === BASE) return req.continue();
          const m = url.hostname === "cdnjs.cloudflare.com" && url.pathname.match(/^\/ajax\/libs\/([^/]+)\/[^/]+\/(.+)$/);
          const file = m && join(process.env.CDN_DIR, m[1], m[2]);
          if (file && existsSync(file)) {
            return req.respond({
              status: 200,
              contentType: "text/javascript",
              headers: { "Access-Control-Allow-Origin": "*" },
              body: readFileSync(file),
            });
          }
          req.abort();
        });
      }
      const [name, value] = alice.cookie.split("=");
      await page.setCookie({ name, value, url: BASE });
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      const meta = await page.$eval(`.book-card-open[data-id="${bookId}"] .book-card-meta`, (n) => n.textContent);
      check("library card shows saved page", /Page 2 of 2/.test(meta), meta);
      await page.click(`.book-card-open[data-id="${bookId}"]`);
      await page.waitForFunction(() => /left off/.test(document.getElementById("status")?.textContent || ""), { timeout: 20000 }).catch(() => {});
      check("reader reopens on saved page", (await page.$eval("#pageJump", (n) => n.value)) === "2");
      const status = await page.evaluate(() => document.getElementById("status")?.textContent || "");
      check("reader says it's resuming", /left off/.test(status), status);

      // Play with the browser engine and capture what it would say. The
      // saved offset is past the end of page 2, so playback should start on
      // page 2's last chunk rather than its first.
      await page.evaluate(() => {
        window.__spoken = [];
        window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); };
        const engine = document.getElementById("engine");
        engine.value = "browser";
        engine.dispatchEvent(new Event("change"));
      });
      await page.click("#play");
      await page.waitForFunction(() => window.__spoken.length > 0, { timeout: 5000 }).catch(() => {});
      const spoken = await page.evaluate(() => window.__spoken[0] || "");
      const page2 = await page.$eval("#textOut", (n) => n.textContent.split("--- page break ---").pop().trim().replace(/\s+/g, " "));
      check("playback resumes inside the saved page", spoken && page2.endsWith(spoken) && !spoken.startsWith("Page 2 sentence 1 "),
        `spoken=${JSON.stringify(spoken)} page2=${JSON.stringify(page2.slice(-200))}`);
      await page.click("#stop");
      await new Promise((r) => setTimeout(r, 500));
      r = await alice.req(`/api/books/${bookId}/progress`);
      check("stopping saves the position it actually reached",
        r.json.progress && r.json.progress.page === 2 && r.json.progress.char_offset < 1e9, JSON.stringify(r.json));
      check("no page errors", errors.length === 0, errors.join(" | "));
    } finally {
      await browser.close();
    }
  } else {
    console.log("SKIP  browser checks (set CHROME to a Chrome/Chromium binary)");
  }

  // ----- Logout removes the session -----
  const oldCookie = alice.cookie;
  await alice.req("/api/auth/logout", { method: "POST" });
  const replay = client();
  replay.cookie = oldCookie;
  r = await replay.req("/api/me");
  check("old cookie is dead after logout", r.json && r.json.user === null, JSON.stringify(r.json));

  // ----- Deleting a book drops its progress -----
  await alice.req("/api/auth/login", { method: "POST", body: { username: `alice_${stamp}`, password: "password1" } });
  r = await alice.req(`/api/books/${bookId}`, { method: "DELETE" });
  check("delete book", r.status === 200);
  r = await bob.req(`/api/books/${bookId}/progress`);
  check("progress gone with the book", r.status === 404);
} catch (e) {
  fail++;
  console.error(e);
} finally {
  await stopServer();
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
