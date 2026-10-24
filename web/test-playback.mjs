// Playback fluency check for the Pocket engine. Self-contained: starts the
// app and a stand-in Pocket server that behaves like the real one (one
// request at a time; makes speech about 1.5x faster than it plays), then
// plays a three-page book in headless Chrome and measures, in real-world
// seconds:
//   - time from pressing Play to the first sound
//   - every silence between two chunks, including across page turns
//   - that every sentence was spoken once, in order
//
//   CHROME=/path/to/chrome node test-playback.mjs
//
// SCALE (default 0.25) shrinks every duration so the run takes about a
// minute; reported numbers are scaled back up. Measured on the hosted
// Pocket server (2026-10-24): ~34 ms of generation and ~51 ms of audio
// per character, requests served one after another.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCALE = Number(process.env.SCALE || 0.25);
const GEN_MS_PER_CHAR = 34 * SCALE;
const AUDIO_MS_PER_CHAR = 51 * SCALE;
const PORT = 8890 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "agr-playback-"));
const CHROME = process.env.CHROME || ["/opt/pw-browsers/chromium/chrome-linux/chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(existsSync);
if (!CHROME) {
  console.log("SKIP  playback checks (set CHROME to a Chrome/Chromium binary)");
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
}

// ----- the book: three pages of mixed sentence lengths -----
const WORDS = "the quiet river ran beside an old mill where morning light fell across the stones and the miller sang softly to himself while he worked".split(" ");
function sentence(n, len) {
  const w = [];
  for (let i = 0; w.join(" ").length < len; i++) w.push(WORDS[(n * 7 + i) % WORDS.length]);
  const s = w.join(" ");
  return `Line ${n} ${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}
const LENGTHS = [40, 180, 90, 260, 60, 140, 320, 70, 200, 110];
const PAGES = [0, 1, 2].map((p) => LENGTHS.map((len, i) => sentence(p * 100 + i, len)));

function makePdf(pages) {
  // One sentence per text line so pdf.js keeps them apart.
  const wrap = (s) => s.match(/.{1,90}(\s|$)/g).map((l) => l.trim());
  const objs = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((sents, i) => {
    const lines = sents.flatMap(wrap);
    const content = lines.map((l, j) => `BT /F1 8 Tf 20 ${820 - j * 10} Td (${l}) Tj ET`).join("\n");
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objs[pageIds[i] + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ----- stand-in Pocket server -----
function wav(seconds) {
  const rate = 24000;
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2);
  return buf;
}
const requested = [];
let busyUntil = 0;
let maxInFlight = 0, inFlight = 0;
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
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    // One at a time, like the real server: each request waits for the last.
    const start = Math.max(Date.now(), busyUntil);
    busyUntil = start + text.length * GEN_MS_PER_CHAR;
    setTimeout(() => {
      inFlight--;
      if (res.destroyed) return;
      res.writeHead(200, { ...cors, "Content-Type": "audio/wav" });
      res.end(wav((text.length * AUDIO_MS_PER_CHAR) / 1000));
    }, busyUntil - Date.now());
  });
});
await new Promise((r) => pocket.listen(0, "127.0.0.1", r));
const POCKET_URL = `http://127.0.0.1:${pocket.address().port}/pocket`;

// ----- app server -----
const server = spawn(process.execPath, ["server.js"], {
  cwd: HERE,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DB_PATH: join(DATA, "library.db"), NODE_ENV: "development", DATABASE_URL: "", SUPABASE_URL: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.on("data", (d) => { if (!/ExperimentalWarning|--trace-warnings/.test(String(d))) process.stderr.write(d); });
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/api/me`); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
}

const { default: puppeteer } = await import("puppeteer-core");
const extraArgs = (process.env.CHROME_ARGS || "").split(" ").filter(Boolean);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", ...extraArgs],
});
const pageErrors = [];
let lastPage = null;
try {
  // Sign up and upload through the API, then drive the UI.
  const stamp = Date.now();
  let cookie = "";
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `play_${stamp}`, password: "password1" }),
  });
  cookie = reg.headers.get("set-cookie").split(";")[0];
  const form = new FormData();
  form.append("file", new Blob([makePdf(PAGES)], { type: "application/pdf" }), "three-pages.pdf");
  const up = await (await fetch(`${BASE}/api/books`, { method: "POST", headers: { Cookie: cookie }, body: form })).json();
  const bookId = up.book.id;

  const page = await browser.newPage();
  lastPage = page;
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const errors = pageErrors;
  page.on("pageerror", (e) => errors.push(e.message));
  if (process.env.CDN_DIR) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.origin === BASE || url.hostname === "127.0.0.1") return req.continue();
      const m = url.hostname === "cdnjs.cloudflare.com" && url.pathname.match(/^\/ajax\/libs\/([^/]+)\/[^/]+\/(.+)$/);
      const file = m && join(process.env.CDN_DIR, m[1], m[2]);
      if (file && existsSync(file)) {
        return req.respond({ status: 200, contentType: "text/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: readFileSync(file) });
      }
      req.abort();
    });
  }
  // Record when every audio chunk starts and when it will finish.
  await page.evaluateOnNewDocument(() => {
    window.__plays = [];
    const orig = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, ...rest) {
      const ctx = this.context;
      const lead = Math.max(0, when - ctx.currentTime);
      const startMs = performance.now() + lead * 1000;
      const rate = this.playbackRate.value || 1;
      const entry = { startMs, endMs: startMs + ((this.buffer.duration - offset) / rate) * 1000, dur: this.buffer.duration, offset, stopped: false };
      window.__plays.push(entry);
      const origStop = this.stop.bind(this);
      this.stop = (...a) => { entry.stopped = true; entry.endMs = Math.min(entry.endMs, performance.now()); return origStop(...a); };
      return orig.call(this, when, offset, ...rest);
    };
  });
  const [name, value] = cookie.split("=");
  await page.setCookie({ name, value, url: BASE });
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
  await page.click(`.book-card-open[data-id="${bookId}"]`);
  // pdf.js occasionally stalls loading its worker from the local CDN copy
  // in this harness; one reload covers it.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForFunction(() => document.getElementById("pageCount").textContent === "3", { timeout: 20000 });
      break;
    } catch (e) {
      if (attempt) throw e;
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForFunction(() => !document.getElementById("libraryScreen").hidden, { timeout: 10000 });
      await page.click(`.book-card-open[data-id="${bookId}"]`);
    }
  }
  const pageTexts = await page.evaluate(() => {
    const t = document.getElementById("textOut").textContent;
    return t.split(/\n*--- page break ---\n*/).map((s) => s.trim().replace(/\s+/g, " "));
  });
  await page.evaluate((url) => {
    const engine = document.getElementById("engine");
    engine.value = "pocket"; engine.dispatchEvent(new Event("change"));
    document.getElementById("pocketUrl").value = url;
  }, POCKET_URL);

  const clickMs = await page.evaluate(() => { document.getElementById("play").click(); return performance.now(); });
  const totalAudioMs = pageTexts.join(" ").length * AUDIO_MS_PER_CHAR;
  await page.waitForFunction(() => /end of the document/i.test(document.getElementById("status").textContent),
    { timeout: totalAudioMs * 3 + 30000, polling: 200 }).catch(() => {});
  const plays = await page.evaluate(() => window.__plays);
  const status = await page.$eval("#status", (n) => n.textContent);

  const real = (ms) => ms / SCALE / 1000;
  const firstSound = plays.length ? real(plays[0].startMs - clickMs) : Infinity;
  const gaps = plays.slice(1).map((p, i) => real(p.startMs - plays[i].endMs));
  const maxGap = gaps.length ? Math.max(...gaps) : Infinity;
  const totalSilence = gaps.reduce((a, g) => a + Math.max(0, g), 0);
  console.log(`INFO  chunks played: ${plays.length}, requests: ${requested.length}, most requests in flight: ${maxInFlight}`);
  console.log(`INFO  first sound after Play: ${firstSound.toFixed(1)} s`);
  console.log(`INFO  gaps (s): ${gaps.map((g) => g.toFixed(2)).join(" ")}`);
  console.log(`INFO  longest gap: ${maxGap.toFixed(2)} s, total silence: ${totalSilence.toFixed(1)} s, book audio: ${real(totalAudioMs).toFixed(0)} s`);

  check("reaches the end of the book", /end of the document/i.test(status), status);
  check("every sentence spoken once, in order",
    requested.join(" ").replace(/\s+/g, " ") === pageTexts.join(" "),
    `\n  got:  ${requested.join(" | ").slice(0, 300)}\n  want: ${pageTexts.join(" | ").slice(0, 300)}`);
  check("one request per chunk played", requested.length === plays.length, `${requested.length} vs ${plays.length}`);
  check("first sound within 3 s of Play", firstSound <= 3, `${firstSound.toFixed(1)} s`);
  check("no gap longer than 0.3 s, page turns included", maxGap <= 0.3, `${maxGap.toFixed(2)} s`);

  // ----- Controls during playback -----
  const wait = (realSeconds) => new Promise((r) => setTimeout(r, realSeconds * 1000 * SCALE));
  // At most one chunk audible at any moment (a scheduled next chunk that
  // was cancelled before it started has endMs <= startMs and is ignored).
  const overlaps = (list) => {
    const heard = list.filter((p) => p.endMs - p.startMs > 1).sort((a, b) => a.startMs - b.startMs);
    let n = 0;
    for (let i = 1; i < heard.length; i++) if (heard[i].startMs < heard[i - 1].endMs - 30) n++;
    return n;
  };
  const playsNow = () => page.evaluate(() => window.__plays.length);
  const status2 = () => page.$eval("#status", (n) => n.textContent);
  // Position in the book: page number plus the slider's place in the page.
  const offsetNow = () => page.evaluate(() => Number(document.getElementById("pageJump").value) * 1000 + Number(document.getElementById("audioPos").value));

  await page.evaluate(() => { window.__plays = []; const j = document.getElementById("pageJump"); j.value = "1"; j.dispatchEvent(new Event("change")); });
  await wait(25);
  check("skip buttons enabled while playing", await page.$eval("#back30", (b) => !b.disabled));

  // Pause: nothing new starts and the clock stops; Resume carries on.
  await page.click("#pause");
  const pausedAt = await offsetNow();
  const countPaused = await playsNow();
  await wait(20);
  check("pause holds still", (await offsetNow()) === pausedAt && (await playsNow()) === countPaused, `${pausedAt} -> ${await offsetNow()}`);
  await page.click("#play");
  await wait(15);
  check("resume carries on", (await offsetNow()) > pausedAt, `${pausedAt} -> ${await offsetNow()}`);

  // 30 s back lands earlier in the same audio, forward moves on.
  const beforeBack = await offsetNow();
  await page.click("#back30");
  await wait(2);
  const afterBack = await offsetNow();
  check("back 30 s moves back", afterBack < beforeBack, `${beforeBack} -> ${afterBack}`);
  await wait(10);
  const beforeFwd = await offsetNow();
  await page.click("#fwd30");
  await wait(2);
  check("forward 30 s moves on", (await offsetNow()) > beforeFwd, `${beforeFwd} -> ${await offsetNow()}`);

  // Speed change mid-chunk keeps one voice at a time and stays gapless.
  await page.evaluate(() => { const sp = document.getElementById("speed"); sp.value = "1.5"; sp.dispatchEvent(new Event("input")); });
  await wait(40);
  const ctl = await page.evaluate(() => window.__plays);
  check("never two chunks at once (pause, skips, speed)", overlaps(ctl) === 0, `${overlaps(ctl)} overlaps`);
  const ctlGaps = ctl.filter((p) => p.endMs - p.startMs > 1).slice(-4);
  const maxCtlGap = Math.max(0, ...ctlGaps.slice(1).map((p, i) => real(p.startMs - ctlGaps[i].endMs)));
  check("still gapless after a speed change", maxCtlGap <= 0.3, `${maxCtlGap.toFixed(2)} s`);
  await page.evaluate(() => { const sp = document.getElementById("speed"); sp.value = "1"; sp.dispatchEvent(new Event("input")); });

  // Sleep timer "end of page" stops at the page turn.
  const pageBefore = await page.$eval("#pageJump", (n) => n.value);
  await page.select("#sleepTimer", "page");
  await page.waitForFunction(() => /Sleep timer: stopped/.test(document.getElementById("status").textContent), { timeout: 120000 * SCALE * 4 + 30000, polling: 200 }).catch(() => {});
  const st = await status2();
  check("sleep timer stops at the end of the page", /Sleep timer: stopped/.test(st), st);
  check("…and Play resumes on the next page", Number(await page.$eval("#pageJump", (n) => n.value)) === Number(pageBefore) + 1);
  await page.click("#play");
  await wait(8);
  check("…which plays", /Reading page/.test(await status2()), await status2());
  await page.click("#stop");

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  fail++;
  console.error(e.message);
  if (lastPage) console.error("status:", await lastPage.$eval("#status", (n) => n.textContent).catch(() => "?"));
  if (pageErrors.length) console.error("page errors:", pageErrors.join(" | "));
} finally {
  await browser.close();
  server.kill("SIGTERM");
  pocket.close();
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
