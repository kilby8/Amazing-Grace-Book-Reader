// Public library check. Self-contained like test-ui.mjs: starts the app on a
// spare port with a throwaway data dir, then checks
//   - the API: share/unshare (owner only), the public list (who shared it,
//     mine/saved/free flags, saves count, own progress, one copy per free
//     book), save/unsave, saved books on My books, removing a saved book
//     never deletes the owner's file, unshared books drop off
//   - the browser (when CHROME is set): Share a book sheet, Save from the
//     public tab, the saved book on My books, search, unshare, and that the
//     phone layout never scrolls sideways
//
//   CHROME=/path/to/chrome CDN_DIR=/path/to/cdn node test-public.mjs
//   DATABASE_URL=postgres://... PG_SSL=off node test-public.mjs   (Postgres)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startCdn } from "./test-cdn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9090 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-public-"));
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
      const headers = {};
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
async function upload(c, name) {
  const form = new FormData();
  form.append("file", new Blob([PDF], { type: "application/pdf" }), name);
  return (await c.req("/api/books", { method: "POST", body: form })).json.book;
}
const share = (c, id, visibility = "public") => c.req(`/api/books/${id}/visibility`, { method: "POST", json: { visibility } });
// Mark a book as added from Find books (the finder itself is covered by
// test-finder.mjs and needs the network or fixtures).
async function setSource(id, source) {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.PG_SSL === "off" ? false : { rejectUnauthorized: false } });
    await c.connect();
    await c.query("UPDATE books SET source = $1 WHERE id = $2", [source, id]);
    await c.end();
    return;
  }
  const db = new DatabaseSync(DB_PATH);
  db.prepare("UPDATE books SET source = ? WHERE id = ?").run(source, id);
  db.close();
}

let browser, cdn;
try {
  const stamp = Date.now().toString(36);
  const alice = client(), bob = client(), carol = client();
  const names = { alice: `pub_a_${stamp}`, bob: `pub_b_${stamp}`, carol: `pub_c_${stamp}` };
  for (const [who, c] of [["alice", alice], ["bob", bob], ["carol", carol]]) {
    await c.req("/api/auth/register", { method: "POST", json: { username: names[who], password: "password1" } });
  }

  // ----- API -----
  const moby = await upload(alice, "Moby Dick.pdf");
  const austen = await upload(alice, "Pride and Prejudice.pdf");
  const bobsAusten = await upload(bob, "Pride and Prejudice (Bob).pdf");
  const bobsNotes = await upload(bob, "Bob's Notes.pdf");
  check("new uploads are owned", moby.owned === true);

  let r = await share(bob, moby.id);
  check("only the owner can share", r.status === 403);
  r = await share(alice, moby.id);
  check("owner shares in one call", r.status === 200 && r.json.visibility === "public" && r.json.shared_at > 0);

  await setSource(austen.id, "gutenberg:1342");
  await setSource(bobsAusten.id, "gutenberg:1342");
  await share(alice, austen.id);
  await new Promise((res) => setTimeout(res, 5));
  await share(bob, bobsAusten.id);
  await share(bob, bobsNotes.id);

  r = await carol.req("/api/public-books");
  let list = r.json.books;
  const ids = list.map((b) => b.id);
  check("public list shows shared books", r.status === 200 && ids.includes(moby.id) && ids.includes(bobsNotes.id));
  check("two copies of one free book show once", list.filter((b) => b.source === "gutenberg:1342").length === 1);
  check("the first share of a free book is the one shown", ids.includes(austen.id) && !ids.includes(bobsAusten.id));
  check("newest share first", ids.indexOf(bobsNotes.id) < ids.indexOf(moby.id));
  const mobyRow = list.find((b) => b.id === moby.id);
  check("rows say who shared it", mobyRow.shared_by === names.alice && mobyRow.mine === false && mobyRow.saved === false && mobyRow.saves === 0);
  check("free books are flagged", list.find((b) => b.id === austen.id).free === true && mobyRow.free === false);
  check("no owner ids or file names leak", !("user_id" in mobyRow) && !("filename" in mobyRow));

  r = await bob.req("/api/public-books");
  check("your own copy of a free book wins for you", r.json.books.some((b) => b.id === bobsAusten.id && b.mine) && !r.json.books.some((b) => b.id === austen.id));

  r = await carol.req(`/api/public-books/${moby.id}/save`, { method: "POST" });
  check("save a public book", r.status === 200 && r.json.saved === true);
  r = await carol.req(`/api/public-books/${moby.id}/save`, { method: "POST" });
  check("saving twice is fine", r.status === 200);
  r = await alice.req(`/api/public-books/${moby.id}/save`, { method: "POST" });
  check("you can't save your own book", r.status === 400);
  r = await alice.req(`/api/public-books/999999/save`, { method: "POST" });
  check("saving a missing book is a 404", r.status === 404);
  const alicesPrivate = await upload(alice, "Diary.pdf");
  r = await carol.req(`/api/public-books/${alicesPrivate.id}/save`, { method: "POST" });
  check("you can't save someone's private book", r.status === 404);

  await carol.req(`/api/books/${moby.id}/progress`, { method: "POST", json: { page: 2, char_offset: 10, total_pages: 3 } });
  r = await carol.req("/api/public-books");
  const mobyForCarol = r.json.books.find((b) => b.id === moby.id);
  check("public row carries your saved flag, saves count and progress", mobyForCarol.saved === true && mobyForCarol.saves === 1 && mobyForCarol.progress_page === 2);
  r = await alice.req("/api/public-books");
  const mobyForAlice = r.json.books.find((b) => b.id === moby.id);
  check("the owner sees it as theirs, with the saves count but not carol's progress", mobyForAlice.mine === true && mobyForAlice.saves === 1 && !mobyForAlice.progress_page);

  r = await carol.req("/api/books");
  let saved = r.json.books.find((b) => b.id === moby.id);
  check("a saved book shows on My books", Boolean(saved) && saved.owned === false && saved.shared_by === names.alice);
  check("with your own progress and last-opened time", saved.progress_page === 2 && saved.last_opened_at > 0);
  r = await alice.req("/api/books");
  check("the owner's list is unchanged", r.json.books.filter((b) => b.id === moby.id).length === 1 && r.json.books.find((b) => b.id === moby.id).owned === true);

  r = await carol.req(`/api/books/${moby.id}/visibility`, { method: "POST", json: { visibility: "private" } });
  check("saving doesn't let you unshare it", r.status === 403);

  r = await carol.req(`/api/books/${moby.id}`, { method: "DELETE" });
  check("removing a saved book only unsaves it", r.status === 200 && r.json.unsaved === true);
  r = await alice.req(`/api/books/${moby.id}/download`);
  check("the owner's file is still there", r.status === 200);
  r = await carol.req("/api/books");
  check("and it's gone from your shelf", !r.json.books.some((b) => b.id === moby.id));

  await carol.req(`/api/public-books/${moby.id}/save`, { method: "POST" });
  await share(alice, moby.id, "private");
  r = await carol.req("/api/public-books");
  check("an unshared book leaves the public list", !r.json.books.some((b) => b.id === moby.id));
  r = await carol.req("/api/books");
  check("and leaves readers' shelves", !r.json.books.some((b) => b.id === moby.id));
  r = await carol.req(`/api/books/${moby.id}/download`);
  check("and can't be opened by them", r.status === 404);
  await share(alice, moby.id);
  r = await carol.req("/api/books");
  check("sharing it again brings the save back", r.json.books.some((b) => b.id === moby.id));
  r = await carol.req(`/api/public-books/${moby.id}/save`, { method: "DELETE" });
  check("unsave from the public library", r.status === 200 && r.json.saved === false);

  r = await fetch(`${BASE}/api/public-books`);
  check("the public library needs a login", r.status === 401);

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
    const setSearch = (page, v) => page.$eval("#publicSearch", (n, v) => { n.value = v; n.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    async function open(c, viewport) {
      const page = await browser.newPage();
      if (viewport) await page.setViewport(viewport);
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("dialog", (d) => d.accept());
      const [name, value] = c.cookie.split("=");
      await page.setCookie({ name, value, url: BASE });
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      return page;
    }

    // Carol has nothing of her own: the share sheet points her to Find books.
    const page = await open(carol, { width: 1280, height: 900 });
    await page.click("#browsePublicBtn");
    await page.waitForFunction(() => document.querySelectorAll("#publicGrid .book-card").length >= 3, { timeout: 10000 });
    check("Public library tab has a Share a book button", await visible(page, "#shareBookBtn"));
    check("the eyebrow counts the shared books", /\d+ books/.test(await page.$eval("#publicEyebrow", (n) => n.textContent)));
    await page.click("#shareBookBtn");
    await sleep(400);
    check("with an empty shelf the sheet offers Find books", await visible(page, "#shareListEmpty"));
    await page.keyboard.press("Escape");
    await sleep(200);

    const mobyCard = `#publicGrid .book-card[data-id="${moby.id}"]`;
    check("someone else's book offers Save", (await page.$eval(`${mobyCard} .book-card-save`, (n) => n.textContent.trim())) === "Save");
    await page.click(`${mobyCard} .book-card-save`);
    await page.waitForFunction((sel) => document.querySelector(`${sel} .book-card-save`).getAttribute("aria-pressed") === "true", { timeout: 5000 }, mobyCard);
    await sleep(500);
    check("Save turns into Saved", (await page.$eval(`${mobyCard} .book-card-save`, (n) => n.textContent.trim())) === "Saved");
    r = await carol.req("/api/books");
    check("the save reached the server", r.json.books.some((b) => b.id === moby.id));

    await setSearch(page, "notes");
    await sleep(200);
    let shown = await page.$$eval("#publicGrid .book-card", (els) => els.map((e) => Number(e.dataset.id)));
    check("search narrows the shelf", shown.length === 1 && shown[0] === bobsNotes.id);
    await setSearch(page, names.alice);
    await sleep(200);
    shown = await page.$$eval("#publicGrid .book-card", (els) => els.map((e) => Number(e.dataset.id)));
    check("search matches who shared it", shown.includes(moby.id) && !shown.includes(bobsNotes.id));
    await setSearch(page, "zzzz");
    await sleep(200);
    check("no matches says so", await visible(page, "#publicSearchEmpty"));
    await setSearch(page, "");
    await sleep(200);

    await page.click("#backFromPublic");
    await sleep(300);
    const shelfCard = `#bookGrid .book-card[data-id="${moby.id}"]`;
    check("the saved book is on My books", await visible(page, shelfCard));
    check("it says who shared it", /Shared by/.test(await page.$eval(shelfCard, (n) => n.textContent)));
    check("and has no share toggle", (await page.$(`${shelfCard} .book-card-share`)) === null);
    check("Continue listening picks up the saved book", (await page.$eval("#continueTitle", (n) => n.textContent)) === "Moby Dick");

    // Opening it from the public tab plays it as a shelf book.
    await page.click("#browsePublicBtn");
    await page.waitForSelector(`${mobyCard} .book-card-open`);
    await page.click(`${mobyCard} .book-card-open`);
    await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 10000 });
    await page.waitForFunction(() => /\d/.test(document.getElementById("pageCount").textContent), { timeout: 20000 }).catch(() => {});
    check("tapping a shared book opens the player", await visible(page, "#readerScreen"));
    await page.click("#backToLibrary");
    await sleep(300);

    // Remove from My books (the file stays for alice).
    await page.click(`${shelfCard} .book-card-del`);
    await sleep(600);
    check("Remove takes it off My books", (await page.$(shelfCard)) === null);
    r = await alice.req(`/api/books/${moby.id}/download`);
    check("without deleting the owner's file", r.status === 200);

    // Bob shares from the sheet and unshares from the public tab.
    const bobPage = await open(bob, { width: 1280, height: 900 });
    const bobsNew = await upload(bob, "Sermons on Grace.pdf");
    await bobPage.click("#browsePublicBtn");
    await sleep(500);
    await bobPage.click("#shareBookBtn");
    await bobPage.waitForSelector(`#shareList .share-toggle[data-id="${bobsNew.id}"]`, { timeout: 5000 });
    check("the sheet lists your books", (await bobPage.$$("#shareList .share-row")).length === 3);
    check("free books carry a badge in the sheet", (await bobPage.$$eval("#shareList .badge-src", (els) => els.length)) === 1);
    await bobPage.click(`#shareList .share-toggle[data-id="${bobsNew.id}"]`);
    await bobPage.waitForFunction((id) => document.querySelector(`#shareList .share-toggle[data-id="${id}"]`).getAttribute("aria-pressed") === "true", { timeout: 5000 }, bobsNew.id);
    check("Share flips to Shared in one tap", (await bobPage.$eval(`#shareList .share-toggle[data-id="${bobsNew.id}"]`, (n) => n.textContent.trim())) === "Shared");
    await bobPage.keyboard.press("Escape");
    await bobPage.waitForSelector(`#publicGrid .book-card[data-id="${bobsNew.id}"]`, { timeout: 5000 });
    check("the shared book appears on the public shelf", true);
    check("marked as shared by you", /Shared by you/.test(await bobPage.$eval(`#publicGrid .book-card[data-id="${bobsNew.id}"]`, (n) => n.textContent)));
    await bobPage.click(`#publicGrid .book-card[data-id="${bobsNew.id}"] .book-card-share`);
    await bobPage.waitForFunction((id) => !document.querySelector(`#publicGrid .book-card[data-id="${id}"]`), { timeout: 5000 }, bobsNew.id);
    check("Unshare from the public tab takes it off", true);
    r = await bob.req("/api/books");
    check("and it's private again on the server", r.json.books.find((b) => b.id === bobsNew.id).visibility === "private");
    await bobPage.click("#backFromPublic");
    await sleep(300);
    check("your own covers say Share before anything is public", (await bobPage.$eval(`#bookGrid .book-card[data-id="${bobsNew.id}"] .book-card-share`, (n) => n.textContent.trim())) === "Share");

    // Phone: no sideways scroll on the public tab or the sheet.
    const phone = await open(bob, { width: 360, height: 780, isMobile: true, deviceScaleFactor: 2 });
    await phone.click("#browsePublicBtn");
    await sleep(500);
    check("phone: public tab fits the width", await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check("phone: Share a book keeps its words", (await phone.$eval("#shareBookBtn span", (n) => getComputedStyle(n).display)) !== "none");
    await phone.click("#shareBookBtn");
    await sleep(400);
    check("phone: the sheet fits the width", await phone.evaluate(() => { const d = document.getElementById("shareDialog"); return d.scrollWidth <= d.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth; }));

    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
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
