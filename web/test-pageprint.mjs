// Verify the print-page badge (EPUB page-list nav).
// - Signs in as a fresh user, uploads the Willoughby EPUB, opens it
// - Asserts ch. 1 (front matter) has no print page -> badge hidden
// - Jumps to the first real chapter (c001 at spine index 10) -> badge "p. 3"
// - Verifies the badge updates on page-jump and auto-advance
// - Goes back to library, uploads the bundled PDF, asserts badge hidden
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";

const APP = "http://127.0.0.1:8770/index.html";
const EPUB = "C:/Users/carpe/.minimax/v2/assets/2026/09/10/22-53-39-287-asset_20260910-225339-287_b8cd301897d4_4f1f15a2-The Late Mrs. Willoughby (Claudia Gray) (z-library.sk, 1lib.sk, z-lib.sk).epub";
const PDF = "C:/Users/carpe/.openclaw/workspace/projects/amazing-grace-book-reader/web/multipage.pdf";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

async function dropFile(page, path, mime, name) {
  const b64 = readFileSync(path).toString("base64");
  await page.evaluate(async (b64, mime, name) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById("drop").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  }, b64, mime, name);
}

async function jumpTo(page, n) {
  await page.evaluate((n) => {
    const inp = document.getElementById("pageJump");
    inp.value = String(n);
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }, n);
  await new Promise((r) => setTimeout(r, 250));
}

async function getBadge(page) {
  return page.evaluate(() => {
    const el = document.getElementById("pagePrint");
    return { text: el.textContent, hidden: el.hidden };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto(APP, { waitUntil: "networkidle0" });

  // --- Sign in as a fresh user ---
  await page.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 10000 });
  await page.click("#tabRegister");
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#authUsername", `pp_${Date.now()}`);
  await page.type("#authPassword", "pageprint1");
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });

  // --- EPUB ---
  await dropFile(page, EPUB, "application/epub+zip", "willoughby.epub");
  await page.waitForFunction(
    () => /^Loaded /.test(document.getElementById("status").textContent),
    { timeout: 30000 }
  );

  // This test exercises page-jump / prev / next - all of which auto-play.
  // Switch to browser TTS to avoid hitting ElevenLabs' free-tier
  // concurrent-request cap (max 4 in flight).
  await page.select("#engine", "browser");
  await new Promise((r) => setTimeout(r, 200));

  // Chapter 1 is the copyright page (cvi) - no print page in the nav
  const badge1 = await getBadge(page);
  check("ch. 1 (front matter): badge hidden", badge1.hidden === true, `text="${badge1.text}" hidden=${badge1.hidden}`);

  // Jump to chapter 10 (c001) - this is the first real chapter, pn="3"
  await jumpTo(page, 10);
  const badge10 = await getBadge(page);
  check("ch. 10 (c001): badge shows 'p. 3'", badge10.text === "p. 3" && !badge10.hidden, `text="${badge10.text}" hidden=${badge10.hidden}`);

  // Jump to chapter 11 (c002) - pn="18"
  await jumpTo(page, 11);
  const badge11 = await getBadge(page);
  check("ch. 11 (c002): badge shows 'p. 18'", badge11.text === "p. 18" && !badge11.hidden, `text="${badge11.text}" hidden=${badge11.hidden}`);

  // Jump to chapter 12 (c003) - pn="33"
  await jumpTo(page, 12);
  const badge12 = await getBadge(page);
  check("ch. 12 (c003): badge shows 'p. 33'", badge12.text === "p. 33" && !badge12.hidden, `text="${badge12.text}" hidden=${badge12.hidden}`);

  // Prev from ch. 12 -> ch. 11
  await page.evaluate(() => document.getElementById("prev").click());
  await new Promise((r) => setTimeout(r, 250));
  const badgeAfterPrev = await getBadge(page);
  check("Prev: badge back to 'p. 18'", badgeAfterPrev.text === "p. 18", `text="${badgeAfterPrev.text}"`);

  // Next from ch. 11 -> ch. 12
  await page.evaluate(() => document.getElementById("next").click());
  await new Promise((r) => setTimeout(r, 250));
  const badgeAfterNext = await getBadge(page);
  check("Next: badge back to 'p. 33'", badgeAfterNext.text === "p. 33", `text="${badgeAfterNext.text}"`);

  // Jump to a front-matter chapter (cvi again, ch. 1) - clicking Play on
  // an empty front-matter page will auto-skip to the first chapter with
  // text, so the badge will reflect the *post-skip* chapter, not ch. 1.
  // That auto-skip lands on fsq (pn "i"). We just assert the badge is
  // consistent with the current chapter after the skip.
  await jumpTo(page, 1);
  const badgeBack1 = await getBadge(page);
  check("ch. 1 + auto-skip: badge shows first non-empty chapter (pn 'i')", badgeBack1.text === "p. i" && !badgeBack1.hidden, `text="${badgeBack1.text}" hidden=${badgeBack1.hidden}`);

  // Engine switch should not alter the badge (same chapter)
  await page.select("#engine", "pocket");
  await new Promise((r) => setTimeout(r, 250));
  const badgeAfterEngineSwitch = await getBadge(page);
  check("engine switch: badge unchanged", badgeAfterEngineSwitch.text === "p. i", `text="${badgeAfterEngineSwitch.text}"`);

  // Extracted text headers - jump to c001 first, then read
  await jumpTo(page, 10);
  const extracted = await page.$eval("#textOut", (n) => n.textContent);
  check("extracted text: ch. 10 header is '--- ch. 10 / p. 3 ---'", /---\s*ch\.\s*10\s*\/\s*p\.\s*3\s*---/.test(extracted), "");
  check("extracted text: no 'chapter N' headers (replaced by 'ch. N')", !/---\s*chapter\s+\d+\s*---/.test(extracted), "");

  // --- Back to library, drop PDF ---
  await page.evaluate(() => document.getElementById("backToLibrary").click());
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 5000 });
  await dropFile(page, PDF, "application/pdf", "multipage.pdf");
  await page.waitForFunction(
    () => /^Loaded /.test(document.getElementById("status").textContent),
    { timeout: 30000 }
  );
  const badgePdf = await getBadge(page);
  check("PDF load: badge is hidden", badgePdf.hidden === true, `text="${badgePdf.text}" hidden=${badgePdf.hidden}`);
  check("PDF load: badge text is empty", badgePdf.text === "", `text="${badgePdf.text}"`);

  // After PDF load, no console/page errors (filter out the expected
  // 401/400 from earlier validation tests).
  const fatalConsoleErrors = errors.filter((e) =>
    !/Failed to fetch|net::ERR_CONNECTION_REFUSED|fetchPriority|favicon|Unsupported method|status of 501|status of 404|status of 400|status of 401/i.test(e)
  );
  check("no unexpected console errors", fatalConsoleErrors.length === 0, fatalConsoleErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  await browser.close();
}
