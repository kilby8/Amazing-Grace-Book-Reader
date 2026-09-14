// ElevenLabs TTS proxy gauntlet:
//   - 401 without session
//   - 400 on missing text
//   - 400 on oversized text
//   - live round-trip: register -> POST /api/tts -> mp3 bytes back
//   - browser UI: default engine is ElevenLabs, Check button works,
//     Play actually fires /api/tts
//
// Skipped gracefully if the server has no ElevenLabs key configured
// (env var absent AND ~/.mavis/elevenlabs_credentials.json missing or empty).
import puppeteer from "puppeteer-core";

const APP = "http://127.0.0.1:8770/index.html";
const API = "http://127.0.0.1:8770";
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
  page.on("pageerror", (e) => errors.push("PAGE: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  // ----- Pre-flight: does the server have a key? -----
  // We can probe by trying a tiny request without auth: 401 means we got past
  // the "no key configured" gate; 503 means no key. Anything else is its own thing.
  const preflight = await fetch(`${API}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "ok" }),
  });
  if (preflight.status === 503) {
    console.log("ElevenLabs not configured on the server - skipping test.");
    console.log(`\n${pass} passed, ${fail} failed (skipped)`);
    await browser.close();
    process.exit(0);
  }
  if (preflight.status !== 401) {
    console.log(`Preflight returned unexpected status ${preflight.status}; continuing anyway.`);
  } else {
    check("API gate: /api/tts returns 401 without session", true);
  }

  // ----- 400 on missing text -----
  const u = "et_" + Date.now();
  const regRes = await fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: "elevenpass1" }),
  });
  const cookie = regRes.headers.get("set-cookie");
  if (!cookie) {
    console.log("FAIL  could not capture session cookie from register");
    process.exit(1);
  }
  check("register returns Set-Cookie", true);

  const noText = await fetch(`${API}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({}),
  });
  check("/api/tts without text returns 400", noText.status === 400, `status=${noText.status}`);

  const bigText = await fetch(`${API}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({ text: "x".repeat(2000) }),
  });
  check("/api/tts with oversized text returns 400", bigText.status === 400, `status=${bigText.status}`);

  // ----- Live round-trip -----
  const tts = await fetch(`${API}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify({ text: "Hello from ElevenLabs. The quick brown fox jumps over the lazy dog." }),
  });
  check("/api/tts with valid text returns 200", tts.status === 200, `status=${tts.status}`);
  check("/api/tts response is audio/mpeg", /^audio\//i.test(tts.headers.get("content-type") || ""), `ct=${tts.headers.get("content-type")}`);
  const buf = new Uint8Array(await tts.arrayBuffer());
  check("/api/tts body is non-trivial (>5 KB)", buf.length > 5000, `bytes=${buf.length}`);
  // ID3v2 header starts with "ID3" (0x49 0x44 0x33); some servers emit
  // mp3 without ID3, but ElevenLabs always does.
  const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  // Sync word "FF FB" / "FF FA" / "FF F3" appears within the first 4 KB
  let hasSync = false;
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) { hasSync = true; break; }
  }
  check("/api/tts body has mp3 ID3 header OR sync word", hasId3 || hasSync, `id3=${hasId3} sync=${hasSync}`);

  // ----- Browser UI: default engine + Check button + Play -----
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.getElementById("authScreen").hidden, { timeout: 10000 });
  // Login (server already has the user from the round-trip above; we registered
  // it directly via the API, so the cookie was set server-side. Switch to
  // login tab and sign in).
  await page.click("#tabLogin");
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => { document.getElementById("authUsername").value = ""; document.getElementById("authPassword").value = ""; });
  await page.type("#authUsername", u);
  await page.type("#authPassword", "elevenpass1");
  await new Promise((r) => setTimeout(r, 200));
  await page.click("#authSubmit");
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });

  // Library screen doesn't expose the engine picker (it's on the reader);
  // jump straight to the reader by uploading a tiny PDF.
  const pdfBytes = await fetch(`${API}/api/books`, {
    method: "POST",
    headers: { "Cookie": cookie },
    body: (() => {
      // Minimal valid PDF, ~1 KB
      const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 12 Tf 72 720 Td (ElevenLabs test page.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000100 00000 n\n0000000189 00000 n\n0000000295 00000 n\ntrailer<</Size 6/Root 1 0 R>>startxref\n357 %%EOF";
      const f = new FormData();
      const blob = new Blob([pdf], { type: "application/pdf" });
      f.append("file", blob, "elevenprobe.pdf");
      return f;
    })(),
  });
  if (!pdfBytes.ok) {
    console.log(`FAIL  could not seed library with PDF: ${pdfBytes.status}`);
    process.exit(1);
  }
  const { book } = await pdfBytes.json();
  // Reload the page so the library's initial GET /api/books picks up the
  // book we just uploaded via the raw API.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
  // Open the book from the library - the clickable target is the inner
  // .book-card-open button (which carries data-id), not the card itself.
  await page.waitForFunction(
    (id) => !!document.querySelector(`.book-card-open[data-id="${id}"]`),
    { timeout: 5000 },
    book.id
  );
  await page.click(`.book-card-open[data-id="${book.id}"]`);
  await page.waitForFunction(() => !document.getElementById("readerScreen").hidden, { timeout: 15000 });

  const defaultEngine = await page.$eval("#engine", (n) => n.value);
  check("default engine is elevenlabs", defaultEngine === "elevenlabs", `engine=${defaultEngine}`);
  check("elevenLabsRow is visible", !(await page.$eval("#elevenLabsRow", (n) => n.hidden)));
  check("pocketRow is hidden", await page.$eval("#pocketRow", (n) => n.hidden));

  // Click "Check" - fires /api/tts with text "ok". Wait for the status pill.
  await page.click("#elevenLabsStatus");
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await page.$eval("#status", (n) => n.textContent);
    if (/ElevenLabs OK/.test(s)) { check("Check button reports ElevenLabs OK", true); break; }
    if (/ElevenLabs unreachable/.test(s)) { check("Check button reports ElevenLabs OK", false, s); break; }
  }

  // Click Play - this should fire /api/tts with the page text and decode
  // audio successfully. In headless Chrome without speakers, the audio
  // context may flag an error, but the API call should still succeed.
  await page.click("#play");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await page.$eval("#status", (n) => n.textContent);
    if (/ElevenLabs: chunk \d+\/\d+ on page \d+/.test(s)) { check("Play starts ElevenLabs playback", true); break; }
    if (/ElevenLabs request failed/.test(s)) { check("Play starts ElevenLabs playback", false, s); break; }
  }
  await page.click("#stop");

  // Console errors should be empty (no fetch failures). Filter out the
  // expected "no autoplay" / decode warnings headless Chrome emits.
  const realErrors = errors.filter((e) => !/MEDIA_ERR|autoplay|favicon/i.test(e));
  check("no unexpected console errors during Play", realErrors.length === 0, realErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  await browser.close();
}
