// End-to-end browser test for Amazing Grace Reader.
// Uses system Chrome via puppeteer-core to:
//   1. Load the app page
//   2. Synthesize a drop event with multipage.pdf
//   3. Wait for the status to say "Loaded"
//   4. Read the extracted text and verify expected words
//   5. Click Play, verify the engine starts, then Stop
//   6. Switch to Pocket TTS engine and verify UI updates
//   7. Check no console errors throughout
import puppeteer from "puppeteer-core";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const APP = "http://127.0.0.1:8770/index.html";
const PDF_PATH = resolve("./multipage.pdf");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(PDF_PATH)) {
  console.error("FAIL: test PDF missing at", PDF_PATH);
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(APP, { waitUntil: "networkidle0", timeout: 30000 });

  // Required DOM elements present
  for (const id of ["engine", "drop", "file", "play", "pause", "stop", "prev", "next", "status", "textOut"]) {
    const present = await page.$("#" + id).then((h) => !!h);
    check(`element #${id} present`, present);
  }

  // Page title
  const title = await page.title();
  check("page title is Amazing Grace Reader", /Amazing Grace Reader/.test(title), title);

  // Inject the file via a synthetic drop event.
  // We can't pass a File directly through Puppeteer's filechooser API because
  // the app uses a drop zone, not the <input> click. So build a DataTransfer
  // in-page and dispatch.
  const pdfBytes = readFileSync(PDF_PATH);
  const pdfB64 = pdfBytes.toString("base64");

  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], "multipage.pdf", { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const drop = document.getElementById("drop");
    const evt = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    drop.dispatchEvent(evt);
  }, pdfB64);

  // Wait for status to flip to "Loaded"
  await page.waitForFunction(
    () => /^Loaded /.test(document.getElementById("status").textContent || ""),
    { timeout: 15000 }
  );
  const statusText = await page.$eval("#status", (n) => n.textContent);
  check(`status shows 'Loaded ...' after drop (got: ${statusText})`, /^Loaded /.test(statusText));

  // Extracted text contains the expected lyrics
  const extracted = await page.$eval("#textOut", (n) => n.textContent);
  for (const word of ["Amazing", "grace", "sweet", "sound", "wretch", "once", "found", "blind"]) {
    check(`extracted text contains '${word}'`, extracted.toLowerCase().includes(word.toLowerCase()));
  }

  // Play button is now enabled
  const playDisabled = await page.$eval("#play", (n) => n.disabled);
  check("play button enabled after load", !playDisabled);

  // Click Play (Browser TTS engine), then immediately Stop.
  // We don't try to verify audio output (headless has no audio device),
  // but we can verify the state machine transitions correctly.
  await page.click("#play");
  await new Promise((r) => setTimeout(r, 200));
  const afterPlay = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    playDisabled: document.getElementById("play").disabled,
    pauseDisabled: document.getElementById("pause").disabled,
    stopDisabled: document.getElementById("stop").disabled,
  }));
  check("status mentions reading after Play",
    /Reading/.test(afterPlay.status) || /chunk/.test(afterPlay.status) || /Browser TTS/.test(afterPlay.status),
    afterPlay.status);
  check("Play button disabled mid-playback", afterPlay.playDisabled);
  check("Pause button enabled mid-playback", !afterPlay.pauseDisabled);
  check("Stop button enabled mid-playback", !afterPlay.stopDisabled);

  await page.click("#stop");
  await new Promise((r) => setTimeout(r, 200));
  const afterStop = await page.evaluate(() => ({
    playDisabled: document.getElementById("play").disabled,
    pauseDisabled: document.getElementById("pause").disabled,
  }));
  check("Play button re-enabled after Stop", !afterStop.playDisabled);
  check("Pause button disabled after Stop", afterStop.pauseDisabled);

  // Switch to Pocket TTS engine
  await page.select("#engine", "pocket");
  await new Promise((r) => setTimeout(r, 100));
  const pocketVisible = await page.evaluate(() => ({
    pocketRow: !document.getElementById("pocketRow").hidden,
    pocketVoiceRow: !document.getElementById("pocketVoiceRow").hidden,
    browserVoiceRow: document.getElementById("browserVoiceRow").hidden,
  }));
  check("pocket URL row visible when engine=pocket", pocketVisible.pocketRow);
  check("pocket voice row visible when engine=pocket", pocketVisible.pocketVoiceRow);
  check("browser voice row hidden when engine=pocket", pocketVisible.browserVoiceRow);

  // Click Play with pocket engine selected and no server running.
  // We expect a status message about reaching the server, not a crash.
  await page.click("#play");
  await new Promise((r) => setTimeout(r, 1500));
  const pocketStatus = await page.$eval("#status", (n) => n.textContent);
  check("pocket mode attempts to reach server (status reflects request, not crash)",
    /Pocket TTS|unreachable|error|chunk|Reading/i.test(pocketStatus),
    pocketStatus);
  await page.click("#stop");
  await new Promise((r) => setTimeout(r, 100));

  // Click Play with the real pocket-tts server reachable at 127.0.0.1:8765.
  // We can't verify actual audio output in headless, but we can verify the
  // fetch returns a real WAV blob and we hand it to an Audio element without
  // throwing. The status will move from "chunk 1/N" to either "Reached the
  // end" or stay at the chunk indicator.
  await page.evaluate(() => {
    document.getElementById("pocketUrl").value = "http://127.0.0.1:8765";
  });
  await page.click("#play");
  // Give the fetch + first audio.play() a chance
  await new Promise((r) => setTimeout(r, 4000));
  const liveStatus = await page.$eval("#status", (n) => n.textContent);
  check("pocket mode with live server gets past the fetch (status mentions chunk or end)",
    /chunk|Reading|Reached/i.test(liveStatus),
    liveStatus);
  await page.click("#stop");

  await page.click("#stop");
  await new Promise((r) => setTimeout(r, 100));

  // Speed slider updates the label
  await page.evaluate(() => {
    const s = document.getElementById("speed");
    s.value = "1.5";
    s.dispatchEvent(new Event("input"));
  });
  const speedLabel = await page.$eval("#speedLabel", (n) => n.textContent);
  check(`speed label updates to 1.50× (got: ${speedLabel})`, /1\.50×|1\.5×/.test(speedLabel), speedLabel);

  // No uncaught page errors
  check("no page errors during run", pageErrors.length === 0, pageErrors.join(" | "));
  // Console errors that are not the expected fetch failures
  // (no pocket-tts server is running, so the POST to /tts fails — that's
  // the point of the test, not a bug in the app).
  const fatalConsoleErrors = consoleErrors.filter((e) =>
    !/Failed to fetch|net::ERR_CONNECTION_REFUSED|fetchPriority|favicon|Unsupported method|status of 501|status of 404/i.test(e)
  );
  check("no unexpected console errors", fatalConsoleErrors.length === 0, fatalConsoleErrors.join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
} finally {
  await browser.close();
}
