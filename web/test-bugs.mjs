// Bug report check. Self-contained like test-public.mjs: starts the app on a
// spare port with a throwaway data dir, then checks
//   - the API: sign-in required, a description is required, context must be
//     a small object, the row is stored with its context and browser
//   - the browser (when CHROME is set): the Report a bug button shows once
//     signed in, the sheet sends the report with the book, page, voice and
//     recent errors, and the phone layout never scrolls sideways
//
//   CHROME=/path/to/chrome CDN_DIR=/path/to/cdn node test-bugs.mjs
//   DATABASE_URL=postgres://reader_app... ADMIN_DATABASE_URL=postgres://postgres... \
//     PG_SSL=off node test-bugs.mjs   (Postgres; the app role can't read reports
//     back, so the test reads them with ADMIN_DATABASE_URL)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startCdn } from "./test-cdn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9290 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-bugs-"));
const DB_PATH = join(DATA, "library.db");
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);
const PDF = readFileSync(join(HERE, "multipage.pdf"));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH, NODE_ENV: "development", DATABASE_URL: process.env.DATABASE_URL || "", SUPABASE_URL: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (d) => { if (!/ExperimentalWarning|--trace-warnings/.test(String(d))) process.stderr.write(d); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/api/me`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
}

function client() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async req(path, opts = {}) {
      const headers = { "User-Agent": "agr-test/1.0" };
      if (cookie) headers.Cookie = cookie;
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { status: res.status, json };
    },
  };
}

// The app can't read reports back (by design), so read the table directly.
async function reports() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, ssl: process.env.PG_SSL === "off" ? false : { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query("SELECT * FROM reader.bug_reports ORDER BY id");
    await c.end();
    return r.rows.map((row) => ({ ...row, context: typeof row.context === "string" ? JSON.parse(row.context) : row.context }));
  }
  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare("SELECT * FROM bug_reports ORDER BY id").all();
  db.close();
  return rows.map((row) => ({ ...row, context: row.context ? JSON.parse(row.context) : null }));
}

let browser, cdn;
try {
  const stamp = Date.now().toString(36);
  const anon = client(), alice = client();
  await alice.req("/api/auth/register", { method: "POST", json: { username: `bug_a_${stamp}`, password: "password1" } });
  const me = (await alice.req("/api/me")).json.user;

  // ----- API -----
  let r = await anon.req("/api/bug-reports", { method: "POST", json: { description: "x" } });
  check("signed out: 401", r.status === 401);
  r = await alice.req("/api/bug-reports", { method: "POST", json: { description: "   " } });
  check("blank description: 400", r.status === 400);
  r = await alice.req("/api/bug-reports", { method: "POST", json: { description: "x", context: [1, 2] } });
  check("context must be an object", r.status === 400);
  r = await alice.req("/api/bug-reports", { method: "POST", json: { description: "x", context: { big: "y".repeat(20000) } } });
  check("context over 16 KB: 400", r.status === 400);
  const before = (await reports()).length;
  r = await alice.req("/api/bug-reports", { method: "POST", json: { description: "  Stops after page 2  ", context: { page: 2, playback: { engine: "pocket" } } } });
  check("report saved: 201 with id", r.status === 201 && r.json.report.id > 0 && r.json.report.created_at > 0, JSON.stringify(r.json));
  r = await alice.req("/api/bug-reports", { method: "POST", json: { description: "z".repeat(5000) } });
  check("long descriptions are kept, cut to 4000", r.status === 201);
  let rows = await reports();
  const row = rows[before];
  check("row holds the trimmed description", row && row.description === "Stops after page 2");
  check("row holds the user, context and browser", row && Number(row.user_id) === me.id && row.context.page === 2 && row.context.playback.engine === "pocket" && row.user_agent === "agr-test/1.0");
  check("new reports start as status new", row && row.status === "new");
  check("description capped at 4000", rows[before + 1].description.length === 4000 && rows[before + 1].context === null);
  r = await alice.req("/api/bug-reports");
  check("the app can't list reports", r.status === 404);

  // ----- Browser -----
  if (!CHROME) {
    console.log("SKIP  browser checks (set CHROME)");
  } else {
    const { default: puppeteer } = await import("puppeteer-core");
    cdn = await startCdn(process.env.CDN_DIR);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300000, args: ["--no-sandbox", "--disable-gpu", ...(cdn ? cdn.chromeArgs : [])] });
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const visible = (page, sel) => page.$eval(sel, (n) => !n.hidden && !!(n.offsetWidth || n.offsetHeight)).catch(() => false);
    const pageErrors = [];
    async function open(c, viewport) {
      const page = await browser.newPage();
      if (viewport) await page.setViewport(viewport);
      page.on("pageerror", (e) => pageErrors.push(e.message));
      if (c) {
        const [name, value] = c.cookie.split("=");
        await page.setCookie({ name, value, url: BASE });
      }
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
      return page;
    }

    const out = await open(null, { width: 1280, height: 900 });
    await out.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 10000 });
    check("signed out: no bug button", !(await visible(out, "#bugBtn")));
    await out.close();

    const page = await open(alice, { width: 1280, height: 900 });
    await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
    check("signed in: Report a bug button in the top bar", await visible(page, "#bugBtn"));

    // Open a book so the report has one (needs pdf.js from CDN_DIR).
    let opened = false;
    if (cdn) {
      const form = new FormData();
      form.append("file", new Blob([PDF], { type: "application/pdf" }), "Bug Book.pdf");
      const book = (await alice.req("/api/books", { method: "POST", body: form })).json.book;
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector(`#bookGrid .book-card[data-id="${book.id}"]`, { timeout: 10000 });
      await page.click(`.book-card-open[data-id="${book.id}"]`);
      opened = await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 15000 }).then(() => true, () => false);
      await sleep(1500);
    }

    // Something went wrong earlier: it should ride along with the report.
    // (Errors thrown from page.evaluate show up muted as "Script error.", so
    // fire the same events the browser fires for the app's own errors.)
    await page.evaluate(() => {
      console.error("pocket fetch failed: 503");
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom from a timer"), message: "boom from a timer", filename: location.origin + "/app.js", lineno: 7 }));
      const p = Promise.reject(new Error("boom from a promise")); p.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: p, reason: new Error("boom from a promise") }));
    });
    await sleep(200);
    check("bug button still there in the reader", !opened || await visible(page, "#bugBtn"));
    await page.click("#bugBtn");
    await sleep(300);
    check("the sheet opens", await page.$eval("#bugDialog", (d) => d.open));
    check("include details is on by default", await page.$eval("#bugInclude", (n) => n.checked));
    await page.click("#bugSend");
    await sleep(200);
    check("empty report: asks what went wrong", await visible(page, "#bugError"));
    await page.type("#bugText", "The voice stopped after page 2.");
    const n0 = (await reports()).length;
    await page.click("#bugSend");
    await page.waitForFunction(() => !document.getElementById("bugDialog").open, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    check("sheet closes after sending", !(await page.$eval("#bugDialog", (d) => d.open)));
    check("thank-you toast", /Thanks/.test(await page.$eval("#status", (n) => n.textContent)));
    rows = await reports();
    const sent = rows[n0];
    check("report reached the database", sent && sent.description === "The voice stopped after page 2.");
    const ctx = sent && sent.context;
    check("context: screen, voice, viewport", ctx && ctx.screen && ctx.playback && ctx.playback.engine && /\d+x\d+/.test(ctx.viewport), JSON.stringify(ctx).slice(0, 300));
    check("context: recent errors ride along", ctx && ctx.recent.some((e) => /503/.test(e.msg)) && ctx.recent.some((e) => /boom from a timer/.test(e.msg) && /app\.js:7/.test(e.msg)) && ctx.recent.some((e) => e.kind === "rejection" && /boom from a promise/.test(e.msg)), JSON.stringify(ctx && ctx.recent).slice(-600));
    if (opened) check("context: book and page", ctx.book && ctx.book.title && ctx.page >= 1 && ctx.totalPages >= 1, JSON.stringify(ctx.book));
    else console.log("SKIP  book context (set CDN_DIR)");
    check("context has no book text", !JSON.stringify(ctx).includes("pagesText"));

    // Unticked: no context at all.
    await page.click("#bugBtn");
    await sleep(300);
    await page.click("#bugInclude");
    await page.type("#bugText", "Private one.");
    await page.click("#bugSend");
    await sleep(800);
    rows = await reports();
    check("unticked: report sent without context", rows.at(-1).description === "Private one." && rows.at(-1).context === null);

    // Phone: the button fits and the sheet doesn't scroll sideways.
    const phone = await open(alice, { width: 360, height: 780, isMobile: true, deviceScaleFactor: 2 });
    await phone.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
    check("phone: bug button visible", await visible(phone, "#bugBtn"));
    check("phone: top bar fits the width", await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await phone.click("#bugBtn");
    await sleep(400);
    check("phone: the sheet fits the width", await phone.evaluate(() => { const d = document.getElementById("bugDialog"); return d.open && d.scrollWidth <= d.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth; }));

    const unexpected = pageErrors.filter((m) => !/boom from a/.test(m));
    check("no other page errors", unexpected.length === 0, unexpected.join(" | "));
  }
} catch (e) {
  fail++;
  console.log(`FAIL  crashed: ${e.stack || e}`);
} finally {
  if (browser) await browser.close();
  if (cdn) cdn.close();
  server.kill();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
