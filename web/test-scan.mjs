// Scan pages check (see SCAN.md). Self-contained like test-ui.mjs.
//   1. Text clean-up rules on hand-made OCR output (no browser needed)
//   2. The EPUB it builds opens with the reader's own EPUB loader rules
//   3. In Chrome: four phone photos of a printed book (one sideways, two
//      out of order, uneven light) go through the real scanner: OCR,
//      page-number order, Make book, and the book opens in the player
//      with the right text. Word accuracy is measured against the source.
//
//   CHROME=/path/to/chrome CDN_DIR=/path/to/cdn node test-scan.mjs
// CDN_DIR needs pdf.js + JSZip (as for test-ui.mjs) and, for the OCR,
// npm/tesseract.js, npm/tesseract.js-core and npm/@tesseract.js-data/eng
// (unpacked npm packages: tesseract.js@5.1.1, tesseract.js-core@5.1.1,
// @tesseract.js-data/eng@1.0.0). Without CHROME only parts 1-2 run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startCdn } from "./test-cdn.mjs";
import { cleanPage, joinLines, finishBook, suggestOrder, buildEpub, tidy, sameHead } from "./public/scan-text.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "test-fixtures", "scan");
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// ----- 1. clean-up rules -----
const L = (text, y, x0 = 100, x1 = 900, confidence = 92) => ({ text, confidence, bbox: { x0, y0: y, x1, y1: y + 30 } });
const ocr = (paras) => ({ width: 1000, height: 1500, blocks: [{ paragraphs: paras.map((lines) => ({ lines })) }] });

{
  const r = cleanPage(ocr([
    [L("42 THE LANTERN KEEPER", 40, 100, 900)],
    [L("Somewhere behind her, on the stones of the old cart", 120, 150), L("track, a horse was walk-", 160), L("ing. It was not hurrying.", 200, 100, 520)],
    [L("Margaret waited. Her father had told her", 240, 150), L("once that a person who runs.", 280, 100, 600)],
  ]));
  check("running head with a page number is dropped and the number kept", r.pageNumber === 42 && !/LANTERN/.test(r.text), JSON.stringify(r));
  check("a word hyphenated at a line end is mended", /walking\. It was/.test(r.text), r.text);
  check("paragraphs are kept apart", r.text.split("\n\n").length === 2, r.text);
}
{
  const r = cleanPage(ocr([
    [L("The sea was calm that night and nothing moved", 100, 150)],
    [L("on the water for a long while after.", 140, 100, 600)],
    [L("17", 1400, 480, 520)],
    [L("~ ;' |", 1450, 100, 140, 20)],
  ]));
  check("a page number at the foot is taken out of the text", r.pageNumber === 17 && !/17/.test(r.text), JSON.stringify(r));
  check("smudges with no letters are dropped", !/[~|]/.test(r.text), r.text);
}
{
  // One Tesseract paragraph holding two real ones: the indent splits them.
  const r = cleanPage(ocr([[
    L("He waited by the door.", 100, 150, 500),
    L("Then the second paragraph begins here and runs on", 140, 150, 900),
    L("across the whole width of the page.", 180, 100, 700),
  ]]));
  check("an indented line starts a new paragraph", r.text.split("\n\n").length === 2, r.text);
}
check("a bar read for a capital I is fixed", tidy("Though | can't, said |. And | think") === "Though I can't, said I. And I think");
check("running heads match despite a misread letter or a speck", sameHead("THE LANTERN KEEPER a", "THE LANTERN KEEPEN") && !sameHead("CHAPTER ONE", "CHAPTER TWO"));
check("ligatures and stray spaces are tidied", tidy("ﬁne , ﬂat ﬁeld .") === "fine, flat field.");
check("em dashes join without a space", joinLines(["he said—", "and stopped"]) === "he said—and stopped");
{
  const book = finishBook([
    { text: "THE LANTERN KEEPER\n\nFirst page text runs on to a bro-", head: "THE LANTERN KEEPER", pageNumber: 41 },
    { text: "ken word. And more.", head: null, pageNumber: 42 },
    { text: "THE LANTERN KEEPER\n\nThird page.", head: "THE LANTERN KEEPER", pageNumber: 43 },
  ]);
  check("a running head that repeats on several pages is dropped", book[0].text.startsWith("First") && book[2].text === "Third page.", JSON.stringify(book));
  check("a word split across two pages is mended", /a broken$/.test(book[0].text) && book[1].text === "word. And more.", JSON.stringify(book));
  check("printed page numbers become page labels", book.map((p) => p.label).join(",") === "41,42,43");
  const kept = finishBook([{ text: "CHAPTER ONE\n\nIt began.", head: "CHAPTER ONE", pageNumber: 1 }, { text: "More.", head: null }]);
  check("a heading seen only once (a chapter title) is kept", kept[0].text.startsWith("CHAPTER ONE"));
}
check("page-number order is suggested when the photos are out of order",
  JSON.stringify(suggestOrder([{ pageNumber: 41 }, { pageNumber: 43 }, { pageNumber: 42 }])) === "[0,2,1]");
check("no suggestion when already in order or numbers are missing",
  suggestOrder([{ pageNumber: 1 }, { pageNumber: 2 }]) === null && suggestOrder([{ pageNumber: 2 }, { pageNumber: null }]) === null);

// ----- 2. the EPUB -----
{
  const require = createRequire(import.meta.url);
  let JSZip = null;
  try { JSZip = require("jszip"); } catch (_) {
    const dir = process.env.CDN_DIR;
    if (dir && existsSync(join(dir, "jszip", "jszip.min.js"))) {
      const mod = { exports: {} };
      new Function("module", "exports", readFileSync(join(dir, "jszip", "jszip.min.js"), "utf8"))(mod, mod.exports);
      JSZip = mod.exports;
    }
  }
  if (!JSZip) console.log("SKIP  EPUB checks (no jszip: npm i jszip or set CDN_DIR)");
  else {
    const blob = await buildEpub(JSZip, { title: "Tom & Jerry <3>", author: "A. Writer", pages: [{ text: "One & two.\n\nThree.", label: "41" }, { text: "Four.", label: null }] });
    const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
    const names = Object.keys(zip.files);
    const raw = Buffer.from(await blob.arrayBuffer());
    check("EPUB starts with an uncompressed mimetype entry", raw.slice(30, 38).toString() === "mimetype" && raw.slice(38, 58).toString() === "application/epub+zip");
    const opf = await zip.file("OEBPS/content.opf").async("string");
    check("title and author are in the package, escaped", opf.includes("<dc:title>Tom &amp; Jerry &lt;3&gt;</dc:title>") && opf.includes("<dc:creator>A. Writer</dc:creator>"));
    check("one spine item per page", (opf.match(/<itemref /g) || []).length === 2 && names.includes("OEBPS/page-0002.xhtml"));
    const p1 = await zip.file("OEBPS/page-0001.xhtml").async("string");
    check("paragraphs become <p> elements", (p1.match(/<p>/g) || []).length === 2 && p1.includes("One &amp; two."));
    const nav = await zip.file("OEBPS/nav.xhtml").async("string");
    check("printed page numbers go in the page list", nav.includes('epub:type="page-list"') && nav.includes(">41</a>") && nav.includes(">2</a>"));
  }
}

// ----- 3. the real scanner in Chrome -----
function words(s) {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}
function wordAccuracy(truth, got) {
  const a = words(truth), b = words(got);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / a.length;
}

if (!CHROME || !process.env.CDN_DIR) {
  console.log("SKIP  browser scan (set CHROME and CDN_DIR)");
} else {
  const PORT = 9100 + Math.floor(Math.random() * 100);
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = mkdtempSync(join(tmpdir(), "agr-scan-"));
  const server = spawn(process.execPath, ["server.js"], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH: join(DATA, "library.db"), NODE_ENV: "development", DATABASE_URL: "", SUPABASE_URL: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => { if (!/ExperimentalWarning|--trace-warnings/.test(String(d))) process.stderr.write(d); });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/me`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  let browser = null;
  let cdn = null;
  const pageErrors = [];
  try {
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `scan_${Date.now()}`, password: "password1" }) });
    const cookie = reg.headers.get("set-cookie").split(";")[0];
    const { default: puppeteer } = await import("puppeteer-core");
    cdn = await startCdn(process.env.CDN_DIR);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 900000, args: ["--no-sandbox", "--disable-gpu", ...cdn.chromeArgs] });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts\.g|duckdns/.test(m.text() + " " + ((m.location() || {}).url || ""))) pageErrors.push(`console: ${m.text()} ${(m.location() || {}).url || ""}`); });
    const [name, value] = cookie.split("=");
    await page.setCookie({ name, value, url: BASE });
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });

    check("Scan pages button is on the library", await page.$eval("#scanOpenBtn", (n) => !!n.offsetWidth));
    await page.click("#scanOpenBtn");
    await page.waitForFunction(() => document.getElementById("scanDialog").open);
    check("scanner opens with a default title and nothing to save yet",
      (await page.$eval("#scanTitle", (n) => n.value)).startsWith("Scanned pages") && await page.$eval("#scanSave", (n) => n.disabled));

    const photos = ["IMG_2041.jpg", "IMG_2042.jpg", "IMG_2043.jpg", "IMG_2044.jpg"].map((f) => join(FIX, f));
    const input = await page.$("#scanPicker");
    const t0 = Date.now();
    // Hand them over in a shuffled order: the scanner sorts by file name.
    await input.uploadFile(photos[3], photos[0], photos[2], photos[1]);
    await page.waitForFunction(() => document.querySelectorAll("#scanList li").length === 4);
    const thumbs = await page.$$eval("#scanList img", (imgs) => imgs.map((i) => i.src.startsWith("blob:")));
    check("four pages listed with thumbnails", thumbs.length === 4 && thumbs.every(Boolean));
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll("#scanList .scan-state")].map((n) => n.textContent);
      return s.length === 4 && s.every((t) => !/Waiting|Reading/.test(t));
    }, { timeout: 600000, polling: 1000 });
    const secs = (Date.now() - t0) / 1000;
    console.log(`      OCR of 4 photos took ${secs.toFixed(1)} s`);
    const states = await page.$$eval("#scanList .scan-state", (n) => n.map((x) => x.textContent));
    console.log("      " + states.join("\n      "));
    check("every page was read", states.every((t) => /Ready|Check this page/.test(t)), states.join(" | "));
    check("printed page numbers were found", states.every((t) => /printed page \d+/.test(t)), states.join(" | "));
    check("the sideways photo was turned upright on its own", /printed page 44/.test(states[2]), states[2]);

    check("out-of-order photos: 'Put in page order' is offered", await page.$eval("#scanOrder", (n) => !n.hidden));
    await page.click("#scanOrderBtn");
    const order = await page.$$eval("#scanList .scan-state", (n) => n.map((x) => (x.textContent.match(/printed page (\d+)/) || [])[1]).join(","));
    check("pages now in printed order", order === "41,42,43,44", order);
    check("order notice goes away once sorted", await page.$eval("#scanOrder", (n) => n.hidden));

    // Move a page with the arrows, then back.
    await page.click('#scanList li:nth-child(2) button[data-act="up"]');
    const swapped = await page.$$eval("#scanList .scan-state", (n) => n.map((x) => (x.textContent.match(/printed page (\d+)/) || [])[1]).join(","));
    await page.click('#scanList li:nth-child(1) button[data-act="down"]');
    check("arrows move a page earlier and later", swapped === "42,41,43,44");

    // Fix a word by hand on page 1: the edit is what gets saved.
    const truth = JSON.parse(readFileSync(join(FIX, "pages.json"), "utf8"));
    const got = await page.$$eval("#scanList textarea", (n) => n.map((t) => t.value));
    const acc = truth.pages.map((p, i) => wordAccuracy(p.paras.join(" "), got[i] || ""));
    console.log(`      word accuracy per page: ${acc.map((a) => (a * 100).toFixed(1) + "%").join(", ")}`);
    const overall = wordAccuracy(truth.pages.map((p) => p.paras.join(" ")).join(" "), got.join(" "));
    check(`OCR word accuracy at least 97% (got ${(overall * 100).toFixed(1)}%)`, overall >= 0.97);
    check("no running heads left in the page text", got.every((t) => !/LANTERN KEEPER/i.test(t)));
    const paraCounts = got.map((t) => t.split("\n\n").length).join(",");
    check("paragraph breaks match the printed page", paraCounts === truth.pages.map((p) => p.paras.length).join(","), paraCounts);

    await page.$eval("#scanTitle", (n) => { n.value = ""; n.dispatchEvent(new Event("input")); });
    check("Make book needs a title", await page.$eval("#scanSave", (n) => n.disabled));
    await page.type("#scanTitle", "The Lantern Keeper");
    await page.type("#scanAuthor", "Test Author");
    check("phone layout never scrolls sideways", await page.$eval("#scanDialog", (d) => d.scrollWidth <= d.clientWidth + 1));
    await page.click("#scanSave");
    await page.waitForFunction(() => !document.getElementById("readerScreen").hidden && document.getElementById("pageCount").textContent === "4", { timeout: 30000 });
    check("book saved and opened in the player with 4 pages", true);
    check("scanner closed after saving", await page.$eval("#scanDialog", (d) => !d.open));
    const listed = await (await fetch(`${BASE}/api/books`, { headers: { Cookie: cookie } })).json();
    const b = listed.books[0];
    check("saved with the title and author typed in", b && b.title === "The Lantern Keeper" && b.author === "Test Author" && b.kind === "epub", JSON.stringify(b));
    check("a scanned book counts in pages, not chapters", (await page.$eval("#pageUnit", (n) => n.textContent.trim())) === "Page");
    const played = await page.evaluate(() => document.getElementById("textOut") ? document.getElementById("textOut").textContent : "");
    check("player has the scanned text with printed page numbers", /p\. 41/.test(played) && /Margaret looked at him/.test(played), played.slice(0, 300));

    // Dim, blurry, tilted, low-resolution photos with a curled page.
    await page.click("#libraryBtn").catch(() => {});
    page.on("dialog", (d) => d.accept());
    await page.evaluate(() => { document.getElementById("scanOpenBtn").click(); });
    await page.waitForFunction(() => document.getElementById("scanDialog").open);
    check("scanner is empty again after saving", await page.$$eval("#scanList li", (n) => n.length) === 0);
    await (await page.$("#scanPicker")).uploadFile(join(FIX, "DIM_41.jpg"), join(FIX, "DIM_44.jpg"));
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll("#scanList .scan-state")].map((n) => n.textContent);
      return s.length === 2 && s.every((t) => !/Waiting|Reading/.test(t));
    }, { timeout: 600000, polling: 1000 });
    const dim = await page.$$eval("#scanList textarea", (n) => n.map((t) => t.value));
    const dimAcc = [0, 3].map((k, i) => wordAccuracy(truth.pages[k].paras.join(" "), dim[i] || ""));
    console.log(`      dim photos word accuracy: ${dimAcc.map((a) => (a * 100).toFixed(1) + "%").join(", ")}`);
    check("hard photos still read at 92% or better", dimAcc.every((a) => a >= 0.92));
    await page.click("#scanDiscard");
    check("Start over clears the pages", await page.$$eval("#scanList li", (n) => n.length) === 0);
    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    fail++;
    console.error(e);
  } finally {
    if (browser) await browser.close();
    if (cdn) cdn.close();
    server.kill("SIGTERM");
    rmSync(DATA, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
