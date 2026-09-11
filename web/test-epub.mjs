// Verify EPUB support: drop the user's EPUB, check chapters load and
// the text is extracted, and audio playback works in both engines.
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const APP = "http://127.0.0.1:8770/index.html";
const EPUB = "C:/Users/carpe/.minimax/v2/assets/2026/09/10/22-53-39-287-asset_20260910-225339-287_b8cd301897d4_4f1f15a2-The Late Mrs. Willoughby (Claudia Gray) (z-library.sk, 1lib.sk, z-lib.sk).epub";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE: " + e));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto(APP, { waitUntil: "networkidle0" });

  // Check JSZip loaded
  const jszipPresent = await page.evaluate(() => typeof window.JSZip !== "undefined");
  check("JSZip CDN script loaded", jszipPresent);

  // Drop the EPUB
  const b64 = readFileSync(EPUB).toString("base64");
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], "willoughby.epub", { type: "application/epub+zip" });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById("drop").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  }, b64);

  // Wait for the EPUB to load
  await page.waitForFunction(() => /^Loaded /.test(document.getElementById("status").textContent), { timeout: 30000 });
  const status = await page.$eval("#status", (n) => n.textContent);
  console.log("status:", status);
  check("EPUB loaded (status says 'Loaded ...')", /^Loaded /.test(status), status);
  check("status mentions 'chapter' (EPUB has chapters, not 'pages')", /chapter/i.test(status), status);

  const pageCount = await page.$eval("#pageCount", (n) => n.textContent);
  console.log("page count:", pageCount);
  check("at least 30 chapters extracted", Number(pageCount) >= 30, `pageCount=${pageCount}`);

  // Title should be the book's title, not the filename. After load the
  // now-reading area shows the book title (until the user navigates to a
  // chapter that has its own parsed <title>).
  const nrTitle = await page.$eval("#nrTitle", (n) => n.textContent);
  console.log("now-reading title:", nrTitle);
  check("now-reading shows the book title 'The Late Mrs. Willoughby'", /Willoughby/i.test(nrTitle), nrTitle);

  // Extracted text should contain the book's opening text
  const extracted = await page.$eval("#textOut", (n) => n.textContent);
  check("extracted text has content (>= 100k chars)", extracted.length >= 100000, `extracted length: ${extracted.length}`);
  check("extracted text contains 'Willoughby'", /Willoughby/i.test(extracted), "");
  // Generic placeholder text from the EPUB generator templates:
  check("extracted text doesn't look like an error", !/^Failed/i.test(extracted), "");

  // Transport buttons enabled
  const playDisabled = await page.$eval("#play", (n) => n.disabled);
  check("Play button enabled after EPUB load", !playDisabled);

  // Switch to Pocket TTS, click play, verify status advances
  await page.select("#engine", "pocket");
  await page.evaluate(() => { document.getElementById("pocketUrl").value = "http://127.0.0.1:8765"; });
  await page.click("#play");
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await page.$eval("#status", (n) => n.textContent);
    if (/chunk \d+\/\d+ on page \d+/.test(s)) { check("pocket mode starts playing chapter 1", true); break; }
    if (/audio error|MEDIA_ERR/.test(s)) { check("pocket mode started without error", false, s); break; }
  }
  await page.click("#stop");

  // Switch to Browser TTS, click play, verify
  await page.select("#engine", "browser");
  await page.click("#play");
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await page.$eval("#status", (n) => n.textContent);
    if (/Reading page 1 \(browser TTS\)/.test(s) || /chunk 1/.test(s)) { check("browser TTS starts reading chapter 1", true); break; }
    if (/audio error|MEDIA_ERR/.test(s)) { check("browser TTS started without error", false, s); break; }
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  const fatalConsoleErrors = errors.filter((e) =>
    !/Failed to fetch|net::ERR_CONNECTION_REFUSED|fetchPriority|favicon|Unsupported method|status of 501|status of 404/i.test(e)
  );
  check("no unexpected console errors", fatalConsoleErrors.length === 0, fatalConsoleErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  await browser.close();
}
