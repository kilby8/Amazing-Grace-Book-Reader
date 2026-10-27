// Book finder checks. Self-contained: the sources are recorded fixtures
// (test-finder-fixtures.cjs), so no network is needed.
//   - finder.js: search, ranking, dedupe, lending filter, format/size
//     pick, a failing source, query sanitizing, id validation, redirect
//     allow-list, file-type and size checks
//   - the API: login required, search, add, the added book downloads
//   - the UI: Find books tab, results, Add -> Open -> plays, library
//     search hand-off, a failed source, phone layout, light/dark
//
//   CHROME=/path/to/chrome CDN_DIR=/path/to/cdn node test-finder.mjs
//   SHOTS=/some/dir   also saves screenshots
//
//   node test-finder.mjs --live    asks the real sources instead
//                                  (needs internet; no browser part)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startCdn } from "./test-cdn.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { createFinder, parseId, isAllowedUrl, tidyAuthor } = require("./finder.js");
const fx = require("./test-finder-fixtures.cjs");
const LIVE = process.argv.includes("--live");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}
const titles = (rs) => rs.map((r) => `${r.title} [${r.source}]`).join(" | ");
async function rejects(p, re) {
  try { await p; return false; } catch (e) { return re.test(String(e.message)); }
}

// ----- live mode: the real sources -----
if (LIVE) {
  const f = createFinder();
  const cases = [
    ["moby dick", /moby/i, /melville/i],
    ["pride and prejudice", /pride and prejudice/i, /austen/i],
    ["pilgrim's progress", /pilgrim/i, /bunyan/i],
    ["spurgeon", /./, /spurgeon/i],
    ["john newton", /./, /newton/i],
    ["sherlock holmes", /sherlock|holmes/i, /doyle/i],
  ];
  for (const [q, t, a] of cases) {
    const started = Date.now();
    const res = await f.search(q);
    const ms = Date.now() - started;
    const top3 = res.results.slice(0, 3);
    check(`live "${q}": right book in the top 3 (${ms} ms)`, top3.some((r) => t.test(r.title) && a.test(r.author)), titles(top3));
    check(`live "${q}": every source answered`, res.sources.every((s) => s.ok), JSON.stringify(res.sources));
    check(`live "${q}": has a PDF result`, res.results.some((r) => r.kind === "pdf"), titles(res.results));
  }
  const res = await f.search("moby dick");
  for (const pick of [res.results.find((r) => r.source === "gutenberg"), res.results.find((r) => r.source === "ia" && r.kind === "pdf")]) {
    if (!pick) { check("live download: a result to try", false); continue; }
    const started = Date.now();
    try {
      const file = await f.download(pick.id);
      check(`live download ${pick.id} (${file.kind}, ${(file.buffer.length / 1048576).toFixed(1)} MB, ${Date.now() - started} ms)`, file.buffer.length > 10000 && file.kind === pick.kind);
    } catch (e) {
      check(`live download ${pick.id}`, false, e.message);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ----- finder.js against the fixtures -----
{
  const f = createFinder({ fetchImpl: fx.fakeFetch });
  const res = await f.search("moby dick");
  const ids = res.results.map((r) => r.id);
  check("search answers from both sources", res.sources.length === 2 && res.sources.every((s) => s.ok), JSON.stringify(res.sources));
  check("Gutenberg's Moby Dick ranks first", ids[0] === "gutenberg:2701", titles(res.results));
  check("the Internet Archive PDF is in the top 3", ids.slice(0, 3).includes("ia:mobydickorwhale01melvuoft"), titles(res.results));
  check("navigation entries in the OPDS feed are skipped", res.results.every((r) => !/sort alphabetically/i.test(r.title)));
  check("XML entities are decoded", res.results.some((r) => r.title === "Moby-Dick & Other Tales"));
  check("several scans of one book collapse to the most downloaded", !ids.includes("ia:mobydick00melv_1"), titles(res.results));
  check("borrow-only Internet Archive books are dropped", !ids.includes("ia:mobydicklending0000melv"));
  const ia = res.results.find((r) => r.id === "ia:mobydickorwhale01melvuoft");
  check("IA result is the text PDF with its size", ia && ia.kind === "pdf" && ia.size === 29450706, JSON.stringify(ia));
  check("IA authors read naturally", ia && ia.author === "Herman Melville", ia && ia.author);
  const huge = res.results.find((r) => r.id === "ia:whalinghugescan");
  check("a PDF over the cap falls back to the EPUB", huge && huge.kind === "epub" && huge.size === 900000, JSON.stringify(huge));
  check("results carry covers and source pages", res.results.every((r) => /^https:\/\//.test(r.cover) && /^https:\/\//.test(r.pageUrl)));
  check("Gutenberg results are EPUB", res.results.filter((r) => r.source === "gutenberg").every((r) => r.kind === "epub"));

  fx.seen.length = 0;
  const again = await f.search("  MOBY   dick ");
  check("repeat searches come from the cache", again.results.length === res.results.length && fx.seen.length === 0, fx.seen.join(" "));

  const boom = await f.search("boom whale");
  check("a failing source is reported, the other still answers", boom.sources.find((s) => s.source === "gutenberg").ok === false && boom.results.length > 0 && boom.results.every((r) => r.source === "ia"), JSON.stringify(boom.sources));

  fx.seen.length = 0;
  await f.search('moby" OR collection:inlibrary) OR (title:*');
  const iaUrl = fx.seen.find((u) => u.includes("advancedsearch"));
  const q = iaUrl ? new URL(iaUrl).searchParams.get("q") : "";
  check("user text can't add search syntax to the IA query", q && !/collection:inlibrary\)|title:\*/.test(q.replace(/NOT collection:inlibrary/, "")) && q.startsWith("(title:(moby collection inlibrary title)"), q);

  check("short queries don't search", (await f.search("a")).results.length === 0);
  check("tidyAuthor", tidyAuthor("Austen, Jane, 1775-1817") === "Jane Austen" && tidyAuthor(["Twain, Mark"]) === "Mark Twain" && tidyAuthor("Unknown") === "Unknown");

  for (const bad of ["", "gutenberg:", "gutenberg:12a", "gutenberg:../1", "ia:../../etc/passwd", "ia:a/b", "http://169.254.169.254/", "file:///etc/passwd", "evil:1"]) {
    check(`bad id refused: ${JSON.stringify(bad)}`, parseId(bad) === null);
  }
  check("allowed hosts", isAllowedUrl("https://www.gutenberg.org/x") && isAllowedUrl("https://ia800100.us.archive.org/x") && !isAllowedUrl("http://www.gutenberg.org/x") && !isAllowedUrl("https://archive.org.evil.com/") && !isAllowedUrl("https://evilarchive.org/"));

  const g = await f.download("gutenberg:2701");
  check("Gutenberg download follows its redirect to the EPUB", g.kind === "epub" && g.buffer.equals(fx.EPUB));
  const g15 = await f.download("gutenberg:15");
  check("Gutenberg falls back to the older EPUB when epub3 is missing", g15.kind === "epub" && g15.buffer.equals(fx.EPUB));
  const p = await f.download("ia:mobydickorwhale01melvuoft");
  check("IA download follows the redirect to the PDF", p.kind === "pdf" && p.buffer.equals(fx.PDF));
  check("a redirect off the source hosts is refused", await rejects(f.download("ia:sneakyredirect"), /unexpected/));
  check("a download that isn't the promised file type is refused", await rejects(f.download("ia:notapdf"), /wasn't a PDF/));
  check("borrow-only items can't be downloaded", await rejects(f.download("ia:mobydicklending0000melv"), /borrowed/));
  check("unknown ids are refused", await rejects(f.download("ia:../x"), /Unknown book/));
  const tiny = createFinder({ fetchImpl: fx.fakeFetch, maxBytes: 100 });
  check("downloads stop at the size cap", await rejects(tiny.download("gutenberg:2701"), /larger than/));
}

// ----- the API, with the server's fetch swapped for the fixtures -----
const PORT = 9100 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-finder-"));
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);

const server = spawn(process.execPath, ["-r", "./test-finder-fixtures.cjs", "server.js"], {
  cwd: HERE,
  env: { ...process.env, FINDER_FAKE: "1", PORT: String(PORT), DATA_DIR: DATA, DB_PATH: join(DATA, "library.db"), NODE_ENV: "development", DATABASE_URL: "", SUPABASE_URL: "" },
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
      const headers = { ...(opts.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
      return { status: res.status, json, buf, headers: res.headers };
    },
  };
}

let browser = null;
let cdn = null;
const pageErrors = [];
try {
  const anon = client();
  check("search needs a login", (await anon.req("/api/finder/search?q=moby")).status === 401);
  check("add needs a login", (await anon.req("/api/finder/add", { method: "POST", json: { id: "gutenberg:2701" } })).status === 401);

  const stamp = Date.now();
  const me = client();
  await me.req("/api/auth/register", { method: "POST", json: { username: `finder_${stamp}`, password: "password1" } });
  let r = await me.req("/api/finder/search?q=moby%20dick");
  check("search API answers", r.status === 200 && r.json.results.length >= 4 && r.json.results[0].id === "gutenberg:2701", JSON.stringify(r.json && r.json.results && r.json.results.slice(0, 2)));
  r = await me.req("/api/finder/search?q=m");
  check("search API wants 2+ letters", r.status === 400);
  r = await me.req("/api/finder/add", { method: "POST", json: { id: "ia:sneakyredirect", title: "x" } });
  check("add refuses a download that leaves the source", r.status === 502 && /unexpected/.test(r.json.error), JSON.stringify(r.json));
  r = await me.req("/api/finder/add", { method: "POST", json: { id: "https://evil.example/book.pdf", title: "x" } });
  check("add refuses a URL instead of an id", r.status === 400, JSON.stringify(r.json));
  r = await me.req("/api/finder/add", { method: "POST", json: { id: "ia:mobydickorwhale01melvuoft", title: "Moby-Dick; or, The whale", author: "Herman Melville" } });
  check("add an Internet Archive PDF", r.status === 200 && r.json.book.kind === "pdf" && r.json.book.author === "Herman Melville", JSON.stringify(r.json));
  const pdfBook = r.json && r.json.book;
  r = await me.req("/api/books");
  check("it's on the shelf", r.json.books.some((b) => pdfBook && b.id === pdfBook.id && b.title === "Moby-Dick; or, The whale"));
  r = await me.req(`/api/books/${pdfBook.id}/file`);
  check("its file is the PDF that was fetched", r.status === 200 && r.buf.equals(fx.PDF) && r.headers.get("content-type") === "application/pdf");
  const other = client();
  await other.req("/api/auth/register", { method: "POST", json: { username: `finder_b_${stamp}`, password: "password1" } });
  check("another reader can't open it", (await other.req(`/api/books/${pdfBook.id}/file`)).status === 404);
  const csp = (await anon.req("/")).headers.get("content-security-policy") || "";
  check("CSP lets the source covers load", /img-src[^;]*https:\/\/www\.gutenberg\.org[^;]*https:\/\/\*\.archive\.org/.test(csp), csp.match(/img-src[^;]*/)?.[0]);

  // ----- the UI -----
  if (!CHROME) {
    console.log("SKIP  browser checks (set CHROME to a Chrome/Chromium binary)");
  } else {
    const { default: puppeteer } = await import("puppeteer-core");
    cdn = await startCdn(process.env.CDN_DIR);
    const SHOTS = process.env.SHOTS;
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300000, args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", ...(cdn ? cdn.chromeArgs : [])] });
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const text = (page, sel) => page.$eval(sel, (n) => n.textContent.trim());
    const visible = (page, sel) => page.$eval(sel, (n) => !n.hidden && !!(n.offsetWidth || n.offsetHeight) && !n.closest("[hidden]"));
    async function openPage(viewport, theme) {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      if (theme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const [name, value] = me.cookie.split("=");
      await page.setCookie({ name, value, url: BASE });
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      return page;
    }
    async function search(page, q) {
      await page.$eval("#finderInput", (n) => { n.value = ""; });
      await page.type("#finderInput", q);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll("#finderResults .finder-skeleton").length === 0 && /free book|No free books|failed/i.test(document.getElementById("finderStatus").textContent), { timeout: 15000 });
    }

    const page = await openPage({ width: 1280, height: 900 });
    check("library has a Find books tab", await visible(page, "#findBooksBtn"));
    await page.click("#findBooksBtn");
    await sleep(100);
    check("Find books screen opens with the search box focused", (await visible(page, "#findScreen")) && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "finderInput");
    check("suggestions show before a search", await visible(page, "#finderIdle"));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "find-idle-desk-light.png") });
    await search(page, "moby dick");
    const rows = await page.$$eval("#finderResults .finder-row", (ns) => ns.map((n) => ({
      title: n.querySelector(".finder-title").textContent,
      src: n.querySelector(".badge-src").textContent,
      kind: n.querySelector(".badge").textContent,
      btn: n.querySelector(".finder-add").textContent.trim(),
    })));
    check("results list shows", rows.length >= 4, JSON.stringify(rows));
    check("first result is Gutenberg's Moby Dick", rows[0] && rows[0].title === "Moby Dick; Or, The Whale" && rows[0].src === "Project Gutenberg", JSON.stringify(rows[0]));
    check("results show their format", rows.some((x) => x.kind === "pdf") && rows.some((x) => x.kind === "epub"));
    check("the PDF added through the API already says Open", rows.some((x) => x.title === "Moby-Dick; or, The whale" && x.btn === "Open"), JSON.stringify(rows));
    check("summary says how many", /\d+ free books for/.test(await text(page, "#finderStatus")), await text(page, "#finderStatus"));
    check("idle suggestions hide once there are results", !(await visible(page, "#finderIdle")));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "find-results-desk-light.png") });

    const first = '#finderResults .finder-row[data-id="gutenberg:2701"] .finder-add';
    await page.click(first);
    await page.waitForFunction((sel) => document.querySelector(sel).dataset.state !== "idle", { timeout: 3000 }, first).catch(() => {});
    const midState = await page.$eval(first, (n) => n.dataset.state);
    await page.waitForFunction((sel) => document.querySelector(sel).dataset.state === "done", { timeout: 15000 }, first).catch(() => {});
    check("Add shows progress, then turns into Open", ["busy", "done"].includes(midState) && (await page.$eval(first, (n) => n.textContent.trim())) === "Open", midState);
    check("toast confirms it", /Added .Moby Dick; Or, The Whale. to your library/.test(await text(page, "#status")), await text(page, "#status"));
    await page.click(first);
    await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 10000 }).catch(() => {});
    check("Open goes to the player", await visible(page, "#readerScreen"));
    check("player shows the book's title", /Moby Dick/.test(await text(page, "#playerBookTitle")), await text(page, "#playerBookTitle"));
    if (cdn) {
      await page.waitForFunction(() => Number(document.getElementById("pageCount").textContent) > 0, { timeout: 20000 }).catch(() => {});
      check("the added EPUB opens and its chapters load", Number(await text(page, "#pageCount")) === 2, await text(page, "#pageCount"));
      check("its text is there to read aloud", /Call me Ishmael/.test(await page.evaluate(() => document.getElementById("readAlong") && document.getElementById("readAlong").textContent)));
    } else {
      console.log("SKIP  opening the EPUB (set CDN_DIR so JSZip loads)");
    }

    await page.click("#backToLibrary");
    await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
    await sleep(300);
    const shelf = await page.$$eval("#bookGrid .book-card", (ns) => ns.map((n) => `${n.querySelector(".book-card-title").textContent}/${(n.querySelector(".book-card-author") || {}).textContent || ""}`));
    check("both added books are on the shelf with authors", shelf.includes("Moby Dick; Or, The Whale/Herman Melville") && shelf.includes("Moby-Dick; or, The whale/Herman Melville"), JSON.stringify(shelf));

    await page.type("#librarySearch", "whale and its captors");
    await sleep(150);
    check("a shelf search with no match offers the finder", (await visible(page, "#findFromLibrary")) && /Search free books for .whale and its captors./.test(await text(page, "#findFromLibraryLabel")), await text(page, "#findFromLibraryLabel"));
    await page.click("#findFromLibrary");
    await page.waitForFunction(() => /free book|No free books/i.test(document.getElementById("finderStatus").textContent), { timeout: 15000 }).catch(() => {});
    check("...which searches for the same words", (await visible(page, "#findScreen")) && (await page.$eval("#finderInput", (n) => n.value)) === "whale and its captors");
    check("...and finds it", (await page.$$eval("#finderResults .finder-title", (ns) => ns.map((n) => n.textContent))).includes("The Whale and its Captors"));

    await search(page, "boom whale");
    check("a source that fails is named, other results still show", /Project Gutenberg didn.t answer/.test(await text(page, "#finderStatus")) && (await page.$$eval("#finderResults .finder-row", (n) => n.length)) > 0, await text(page, "#finderStatus"));
    await search(page, "zzqx nothing");
    check("no results says so and suggests what to try", /No free books found/.test(await text(page, "#finderStatus")));

    await page.$eval("#finderInput", (n) => { n.value = ""; });
    await page.click('[data-go="library"]');
    check("My books tab goes back", await visible(page, "#libraryScreen"));
    await page.$eval("#librarySearch", (n) => { n.value = ""; n.dispatchEvent(new Event("input")); });
    await page.click("#browsePublicBtn");
    await sleep(200);
    await page.click('#publicScreen [data-go="find"]');
    check("Public library links to Find books too", await visible(page, "#findScreen"));
    await page.close();

    // Phone, both themes.
    for (const theme of ["light", "dark"]) {
      const phone = await openPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, theme);
      await phone.click("#findBooksBtn");
      await search(phone, "moby dick");
      const wide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`phone (${theme}): no sideways scroll on results`, wide <= 0, `${wide}px`);
      const tap = await phone.$eval("#finderResults .finder-add", (n) => n.getBoundingClientRect().height);
      check(`phone (${theme}): Add button is a comfortable tap`, tap >= 40, String(tap));
      if (SHOTS) await phone.screenshot({ path: join(SHOTS, `find-results-phone-${theme}.png`) });
      await phone.close();
    }
    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  }
} catch (e) {
  fail++;
  console.error(e);
} finally {
  if (browser) await browser.close();
  if (cdn) cdn.close();
  server.kill("SIGTERM");
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
