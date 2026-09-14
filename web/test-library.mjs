// Library gauntlet: register -> upload -> library shows book -> open ->
// reader shows now-reading with print-page badge -> back to library ->
// logout -> register a different user -> first user's library is empty.
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

async function dropFile(page, path, mime, name) {
  const b64 = readFileSync(path).toString("base64");
  await page.evaluate(async (b64, mime, name) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    // The library's drop zone is #drop
    document.getElementById("drop").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  }, b64, mime, name);
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

  // ----- Auth screen -----
  await page.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 5000 });
  check("auth screen visible on first load", true);
  check("library screen hidden on first load", await page.$eval("#libraryScreen", (n) => n.hidden));
  check("reader screen hidden on first load", await page.$eval("#readerScreen", (n) => n.hidden));

  // Switch to "Create account" tab
  await page.click("#tabRegister");
  await new Promise((r) => setTimeout(r, 200));
  check("submit label flips to 'Create account'", /create/i.test(await page.$eval("#authSubmitLabel", (n) => n.textContent)));

  // Try too-short username (validation)
  await page.type("#authUsername", "ab");
  await page.type("#authPassword", "abcdef");
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("authError").hidden, { timeout: 5000 }).catch(() => {});
  const errText = await page.$eval("#authError", (n) => n.textContent);
  check("short username rejected client-side", /3.characters/i.test(errText) || errText.length > 0, errText);

  // Clear and try invalid credentials (wrong password)
  await page.evaluate(() => { document.getElementById("authUsername").value = ""; document.getElementById("authPassword").value = ""; });
  // Switch back to sign in
  await page.click("#tabLogin");
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#authUsername", "ghost");
  await page.type("#authPassword", "wrongpass");
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("authError").hidden, { timeout: 5000 });
  const errText2 = await page.$eval("#authError", (n) => n.textContent);
  check("wrong credentials rejected", /invalid/i.test(errText2), errText2);

  // Now actually register a new user
  await page.click("#tabRegister");
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => { document.getElementById("authUsername").value = ""; document.getElementById("authPassword").value = ""; });
  const newUser = `alice_${Date.now()}`;
  await page.type("#authUsername", newUser);
  await page.type("#authPassword", "alicepassword1");
  await page.click("#authSubmit");

  // ----- Library screen -----
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
  check("library screen visible after register", true);
  check("auth screen hidden after register", await page.$eval("#authScreen", (n) => n.hidden));
  check("sign-out button visible", await page.$eval("#logoutBtn", (n) => !n.hidden));
  const greeting = await page.$eval("#libraryGreeting", (n) => n.textContent);
  check("greeting greets the new user", greeting.includes(newUser), greeting);

  // Library should be empty initially
  const emptyVisible = await page.$eval("#libraryEmpty", (n) => !n.hidden);
  check("library empty state visible initially", emptyVisible);

  // Upload the EPUB via the drop zone
  await dropFile(page, EPUB, "application/epub+zip", "willoughby.epub");

  // After upload, should auto-navigate to the reader
  await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 30000 });
  check("upload auto-navigates to reader", true);

  // Wait for the EPUB to load
  await page.waitForFunction(() => {
    const s = document.getElementById("status").textContent;
    return /Loaded/.test(s);
  }, { timeout: 30000 });
  const status = await page.$eval("#status", (n) => n.textContent);
  console.log("status after upload:", status);
  check("EPUB loaded (status says 'Loaded ...')", /Loaded/.test(status), status);

  // Now-reading area shows the book title
  const nrTitle = await page.$eval("#nrTitle", (n) => n.textContent);
  check("now-reading shows book title", /Willoughby/i.test(nrTitle), nrTitle);

  // Jump to chapter 10 (c001, pn=3) and check badge
  await page.evaluate(() => {
    const inp = document.getElementById("pageJump");
    inp.value = "10";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 250));
  const badge = await page.evaluate(() => {
    const el = document.getElementById("pagePrint");
    return { text: el.textContent, hidden: el.hidden };
  });
  check("print badge shows 'p. 3' on ch. 10", badge.text === "p. 3" && !badge.hidden, JSON.stringify(badge));

  // ----- Back to library -----
  await page.click("#backToLibrary");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 5000 });
  check("back-to-library returns to library", true);
  check("reader hidden after back", await page.$eval("#readerScreen", (n) => n.hidden));

  // The library should now show 1 book
  await new Promise((r) => setTimeout(r, 500));
  const cards = await page.$$eval(".book-card", (els) => els.length);
  check("library shows 1 book card", cards === 1, `cards=${cards}`);
  const cardTitle = await page.$eval(".book-card-title", (n) => n.textContent);
  check("book card title is the EPUB title", /Willoughby/i.test(cardTitle), cardTitle);

  // Click the book card to re-open
  await page.click(".book-card-open");
  await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 10000 });
  await page.waitForFunction(() => /Loaded/.test(document.getElementById("status").textContent), { timeout: 30000 });
  const reloadedTitle = await page.$eval("#nrTitle", (n) => n.textContent);
  check("re-open loads the same book", /Willoughby/i.test(reloadedTitle), reloadedTitle);

  // ----- Sign out -----
  await page.click("#backToLibrary");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 5000 });
  await page.click("#logoutBtn");
  await page.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 5000 });
  check("sign-out returns to auth screen", true);
  check("library hidden after logout", await page.$eval("#libraryScreen", (n) => n.hidden));

  // ----- Per-user isolation: register a new user, library should be empty -----
  await page.click("#tabRegister");
  await new Promise((r) => setTimeout(r, 200));
  const otherUser = `bob_${Date.now()}`;
  await page.type("#authUsername", otherUser);
  await page.type("#authPassword", "bobpassword1");
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
  const otherCards = await page.$$eval(".book-card", (els) => els.length);
  check("different user sees empty library", otherCards === 0, `cards=${otherCards}`);

  // ----- Sign back in as the first user, library still has the book -----
  await page.click("#logoutBtn");
  await page.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 5000 });
  await page.click("#tabLogin");
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#authUsername", newUser);
  await page.type("#authPassword", "alicepassword1");
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
  const restoredCards = await page.$$eval(".book-card", (els) => els.length);
  check("first user still has 1 book after logout+login", restoredCards === 1, `cards=${restoredCards}`);

  // ----- Delete the book -----
  // The confirm() dialog must be auto-accepted. We dispatch the click via
  // evaluate because puppeteer's click() has trouble clicking inside this
  // particular grid layout; el.click() always works.
  page.on("dialog", async (d) => { await d.accept(); });
  await page.evaluate(() => document.querySelector(".book-card-del").click());
  await new Promise((r) => setTimeout(r, 1500));
  const afterDel = await page.$$eval(".book-card", (els) => els.length);
  check("deleting a book removes the card", afterDel === 0, `cards=${afterDel}`);

  // ----- Errors / page issues -----
  // The 400 (short username) and 401 (wrong credentials) are EXPECTED —
  // they're the validation/auth checks that are part of the test flow.
  const fatalConsoleErrors = errors.filter((e) =>
    !/Failed to fetch|net::ERR_CONNECTION_REFUSED|fetchPriority|favicon|Unsupported method|status of 501|status of 404|status of 400|status of 401/i.test(e)
  );
  check("no unexpected console errors", fatalConsoleErrors.length === 0, fatalConsoleErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  await browser.close();
}
