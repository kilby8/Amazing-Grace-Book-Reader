// Library + player features check. Self-contained like test-playback.mjs:
// starts the app and a stand-in Pocket voice server, then checks
//   - the bookmarks API (add, list, delete, per-reader, validation)
//   - the library: covers, progress, search, sort, Continue listening
//   - one-tap Resume, the mini player keeping the book playing
//   - read along: a sentence is highlighted while playing; tapping one
//     plays from it
//   - bookmarks from the player, the pages list, voice picks, theme,
//     keyboard, and that the phone layout never scrolls sideways
//
//   CHROME=/path/to/chrome node test-ui.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startCdn } from "./test-cdn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8990 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-ui-"));
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// ----- books -----
const SENTENCES = [
  "The first sentence is short.",
  "A second sentence follows it, a little longer than the first one was.",
  "Third comes a sentence about rivers and mills and the quiet morning light.",
  "Then a fourth.",
  "And a fifth sentence closes the page with a gentle word of grace.",
];
function makePdf(pages) {
  const objs = [];
  const ids = pages.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const c = lines.map((l, j) => `BT /F1 9 Tf 20 ${800 - j * 12} Td (${l}) Tj ET`).join("\n");
    objs[ids[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ids[i] + 1} 0 R >>`;
    objs[ids[i] + 1] = `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const off = [];
  for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PAGES = [SENTENCES, SENTENCES.map((s) => s.replace("sentence", "line")), SENTENCES];

// ----- stand-in Pocket voice: 1 s of tone per 20 characters, fast -----
const requested = [];
const pocket = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Headers": "*" }); return res.end(); }
  if (req.url.endsWith("/health")) { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); return res.end('{"status":"healthy"}'); }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const m = body.match(/name="text"\r\n\r\n([\s\S]*?)\r\n--/);
    const text = m ? m[1] : "";
    requested.push(text);
    const rate = 24000, n = Math.max(1, Math.round((text.length / 20) * rate));
    const b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
    setTimeout(() => { res.writeHead(200, { ...cors, "Content-Type": "audio/wav" }); res.end(b); }, 30);
  });
});
await new Promise((r) => pocket.listen(0, "127.0.0.1", r));
const POCKET_URL = `http://127.0.0.1:${pocket.address().port}/pocket`;

// ----- app server -----
const server = spawn(process.execPath, ["server.js"], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH: join(DATA, "library.db"), NODE_ENV: "development", DATABASE_URL: process.env.DATABASE_URL || "", SUPABASE_URL: "" },
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
      const res = await fetch(BASE + path, { method: opts.method || "GET", headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { status: res.status, json };
    },
  };
}
async function upload(c, name, pages) {
  const form = new FormData();
  form.append("file", new Blob([makePdf(pages)], { type: "application/pdf" }), name);
  return (await c.req("/api/books", { method: "POST", body: form })).json.book;
}

let browser = null;
let cdn = null;
const pageErrors = [];
try {
  // ----- API: bookmarks -----
  const stamp = Date.now();
  const alice = client(), bob = client();
  await alice.req("/api/auth/register", { method: "POST", json: { username: `ui_a_${stamp}_longusername1`, password: "password1" } });
  await bob.req("/api/auth/register", { method: "POST", json: { username: `ui_b_${stamp}`, password: "password1" } });
  const grace = await upload(alice, "Amazing Grace.pdf", PAGES);
  const walden = await upload(alice, "Walden.pdf", [SENTENCES]);
  const zeal = await upload(alice, "Zeal and Patience.pdf", [SENTENCES]);

  let r = await alice.req(`/api/books/${grace.id}/bookmarks`);
  check("bookmarks start empty", r.status === 200 && Array.isArray(r.json.bookmarks) && r.json.bookmarks.length === 0, JSON.stringify(r.json));
  r = await alice.req(`/api/books/${grace.id}/bookmarks`, { method: "POST", json: { page: 2, char_offset: 30, note: "  lovely line  " } });
  check("add a bookmark", r.status === 201 && r.json.bookmark.page === 2 && r.json.bookmark.char_offset === 30 && r.json.bookmark.note === "lovely line", JSON.stringify(r.json));
  const bmId = r.json.bookmark.id;
  r = await alice.req(`/api/books/${grace.id}/bookmarks`, { method: "POST", json: { page: 1, char_offset: 0 } });
  r = await alice.req(`/api/books/${grace.id}/bookmarks`);
  check("bookmarks list in reading order", r.json.bookmarks.length === 2 && r.json.bookmarks[0].page === 1 && r.json.bookmarks[1].page === 2);
  r = await alice.req(`/api/books/${grace.id}/bookmarks`, { method: "POST", json: { page: 0 } });
  check("bad page is rejected", r.status === 400);
  r = await alice.req(`/api/books/${grace.id}/bookmarks`, { method: "POST", json: { page: 1, note: 5 } });
  check("bad note is rejected", r.status === 400);
  r = await bob.req(`/api/books/${grace.id}/bookmarks`);
  check("another reader can't see a private book's bookmarks", r.status === 404);
  r = await bob.req(`/api/books/${grace.id}/bookmarks/${bmId}`, { method: "DELETE" });
  check("another reader can't delete them", r.status === 404);
  r = await alice.req(`/api/books/${grace.id}/bookmarks/${bmId}`, { method: "PATCH", json: { note: " a better line " } });
  check("edit a bookmark's note", r.status === 200 && r.json.bookmark.note === "a better line", JSON.stringify(r.json));
  r = await bob.req(`/api/books/${grace.id}/bookmarks/${bmId}`, { method: "PATCH", json: { note: "mine now" } });
  check("another reader can't edit the note", r.status === 404);
  r = await alice.req(`/api/books/${grace.id}/bookmarks/${bmId}`, { method: "PATCH", json: { note: 7 } });
  check("bad note edit is rejected", r.status === 400);
  await alice.req(`/api/books/${grace.id}/visibility`, { method: "POST", json: { visibility: "public" } });
  r = await bob.req(`/api/books/${grace.id}/bookmarks`);
  check("on a public book each reader has their own bookmarks", r.status === 200 && r.json.bookmarks.length === 0);
  r = await alice.req(`/api/books/${grace.id}/bookmarks/${bmId}`, { method: "DELETE" });
  check("delete a bookmark", r.status === 200);
  r = await alice.req(`/api/books/${grace.id}/bookmarks`);
  check("deleted bookmark is gone", r.json.bookmarks.length === 1);

  // Progress so the library has something to continue.
  await alice.req(`/api/books/${walden.id}/progress`, { method: "POST", json: { page: 1, char_offset: 0, total_pages: 1 } });
  await alice.req(`/api/books/${grace.id}/progress`, { method: "POST", json: { page: 2, char_offset: 0, total_pages: 3 } });

  if (!CHROME) {
    console.log("SKIP  browser checks (set CHROME to a Chrome/Chromium binary)");
  } else {
    const { default: puppeteer } = await import("puppeteer-core");
    // CDN_DIR serves the cdnjs scripts (pdf.js, jszip) from a local copy for
    // machines without internet access; see test-cdn.mjs.
    cdn = await startCdn(process.env.CDN_DIR);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 900000, args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", ...(cdn ? cdn.chromeArgs : [])] });
    async function openPage(viewport) {
      const page = await browser.newPage();
      if (viewport) await page.setViewport(viewport);
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const [name, value] = alice.cookie.split("=");
      await page.setCookie({ name, value, url: BASE });
      // Point the natural voice at the stand-in before the app starts.
      await page.evaluateOnNewDocument((url) => {
        document.addEventListener("DOMContentLoaded", () => { const u = document.getElementById("pocketUrl"); if (u) u.value = url; });
      }, POCKET_URL);
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      return page;
    }
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const text = (page, sel) => page.$eval(sel, (n) => n.textContent.trim());
    const visible = (page, sel) => page.$eval(sel, (n) => !n.hidden && !!(n.offsetWidth || n.offsetHeight));

    const page = await openPage({ width: 1280, height: 860 });
    check("library shows a cover per book", (await page.$$eval("#bookGrid .book-card .cover", (n) => n.length)) === 3);
    const graceMeta = await page.$eval(`.book-card-open[data-id="${grace.id}"] .book-card-meta`, (n) => n.textContent);
    check("cards show progress", /Page 2 of 3/.test(graceMeta) && (await page.$(`.book-card-open[data-id="${grace.id}"] .progress span`)) !== null, graceMeta);
    check("Continue listening shows the latest book", await visible(page, "#continueCard"));
    await page.type("#librarySearch", "wald");
    await sleep(100);
    const found = await page.$$eval("#bookGrid .book-card-title", (n) => n.map((x) => x.textContent));
    check("search filters the shelf", found.length === 1 && found[0] === "Walden", JSON.stringify(found));
    await page.$eval("#librarySearch", (n) => { n.value = ""; n.dispatchEvent(new Event("input")); });
    await page.select("#librarySort", "title");
    const sorted = await page.$$eval("#bookGrid .book-card-title", (n) => n.map((x) => x.textContent));
    check("sort by title", sorted.join("|") === "Amazing Grace|Walden|Zeal and Patience", sorted.join("|"));

    // One tap: open the continue book and play.
    const contId = Number(await page.$eval("#continueCard", (n) => n.dataset.id));
    await page.click("#continueBtn");
    await page.waitForFunction(() => !document.getElementById("readerScreen").hidden && document.getElementById("pageCount").textContent !== "…", { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById("pause").hidden, { timeout: 10000 }).catch(() => {});
    check("Resume opens the book and plays in one tap", await visible(page, "#pause"), await text(page, "#status"));
    check("…on the saved page", contId !== grace.id || (await page.$eval("#pageJump", (n) => n.value)) === "2");

    // Read along follows the voice.
    await page.waitForFunction(() => document.querySelector("#readAlong .ra-now"), { timeout: 8000 }).catch(() => {});
    const now = await page.$eval("#readAlong", (n) => (n.querySelector(".ra-now") || {}).textContent || "");
    check("read along highlights the sentence being read", now.length > 0, now);
    // Tap the fourth sentence: playback restarts from it.
    const before = requested.length;
    await page.evaluate(() => document.querySelectorAll("#readAlong .ra-s")[3].click());
    await sleep(1200);
    // A request already in flight can land just after the tap; what matters
    // is that playback restarts from the tapped sentence.
    const tapped = requested.slice(before).find((t) => /^Then a fourth\./.test(t)) || "";
    check("tapping a sentence plays from it", tapped !== "", JSON.stringify(requested.slice(before)));

    // Bookmark from the player.
    const bmBefore = await page.$$eval("#bookmarksList li", (n) => n.length);
    await page.click("#bookmarkBtn");
    await page.waitForFunction((n) => document.querySelectorAll("#bookmarksList li").length > n, { timeout: 5000 }, bmBefore).catch(() => {});
    const bmCount = await page.$$eval("#bookmarksList li", (n) => n.length);
    r = await alice.req(`/api/books/${contId}/bookmarks`);
    check("Bookmark saves the spot to the account", bmCount === bmBefore + 1 && r.json.bookmarks.length === bmCount, `${bmCount} vs ${r.json.bookmarks.length}`);
    // Add a note to that bookmark inline.
    await page.click("#tabBookmarks");
    await page.click("#bookmarksList li:last-child .bookmark-edit");
    await page.waitForSelector(".bookmark-note-form input", { timeout: 3000 });
    await page.type(".bookmark-note-form input", "favourite part");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /favourite part/.test(document.querySelector("#bookmarksList")?.textContent || ""), { timeout: 5000 }).catch(() => {});
    r = await alice.req(`/api/books/${contId}/bookmarks`);
    check("a note can be added to a bookmark", r.json.bookmarks.some((b) => b.note === "favourite part") && /favourite part/.test(await text(page, "#bookmarksList")), JSON.stringify(r.json.bookmarks));
    await page.click("#tabChapters");
    check("pages list marks the current page", (await page.$$eval("#chaptersList .ch-now", (n) => n.length)) === 1);

    // Back to the library: still playing, mini player shown.
    await page.click("#backToLibrary");
    await sleep(800);
    check("mini player appears on the library", await visible(page, "#miniPlayer"));
    const stillPlaying = await page.evaluate(() => document.getElementById("miniToggle").getAttribute("aria-label") === "Pause");
    check("…and the book keeps playing", stillPlaying);
    await page.click("#miniToggle");
    await sleep(300);
    check("mini player pauses", (await page.$eval("#miniToggle", (n) => n.getAttribute("aria-label"))) === "Play");
    await page.click("#miniOpen");
    await sleep(300);
    check("mini player reopens the player", await visible(page, "#readerScreen"));

    // Keyboard: space toggles.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Space");
    await sleep(500);
    check("Space plays", await visible(page, "#pause"));
    await page.keyboard.press("Space");
    await sleep(300);
    check("Space pauses", await visible(page, "#play"));

    // Voice picks.
    await page.click("#voiceBtn");
    await page.click('.voice-pick[data-voice="eve"]');
    check("voice pick sets the narrator", (await page.$eval("#pocketVoice", (n) => n.value)) === "eve" && (await text(page, "#voiceBtnLabel")) === "Eve");
    await page.evaluate(() => document.getElementById("voiceDialog").close());

    // Theme persists.
    const firstTheme = await page.evaluate(() => document.documentElement.dataset.theme || "auto");
    await page.click("#themeToggle");
    const flipped = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.click("#stop");
    await page.reload({ waitUntil: "networkidle0" });
    const kept = await page.evaluate(() => document.documentElement.dataset.theme);
    check("theme switch sticks after reload", flipped && flipped !== firstTheme && kept === flipped, `${firstTheme} -> ${flipped} -> ${kept}`);
    check("voice choice sticks after reload", (await page.$eval("#pocketVoice", (n) => n.value)) === "eve");
    await page.close();

    // Phone: nothing wider than the screen on any screen.
    const phone = await openPage({ width: 375, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    // A phone widens its layout to fit overflowing content (and body hides
    // sideways scroll), so measure every element against the 375 px screen.
    const overflow = async () => phone.evaluate(() => {
      let worst = 0;
      for (const el of document.querySelectorAll("body *")) {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right - 375 > worst) worst = r.right - 375;
      }
      return Math.round(worst);
    });
    const libOver = await overflow();
    await phone.click(`.book-card-open[data-id="${walden.id}"]`);
    await phone.waitForFunction(() => document.getElementById("pageCount").textContent === "1", { timeout: 20000 }).catch(() => {});
    await sleep(500);
    const readerOver = await overflow();
    check("phone layout fits a 375 px screen", libOver <= 0 && readerOver <= 0 && (await phone.evaluate(() => window.innerWidth)) === 375, `library ${libOver}px, player ${readerOver}px over`);
    const small = await phone.evaluate(() => Array.from(document.querySelectorAll("#readerScreen button")).filter((b) => b.offsetParent && (b.offsetWidth < 40 || b.offsetHeight < 36)).map((b) => b.id || b.className));
    check("player buttons are big enough to tap", small.length === 0, small.join(", "));
    await phone.close();
    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  }
} catch (e) {
  fail++;
  console.error(e);
} finally {
  if (browser) await browser.close();
  if (cdn) cdn.close();
  server.kill("SIGTERM");
  pocket.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
