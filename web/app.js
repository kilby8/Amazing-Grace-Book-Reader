// Grace Reader - drop a PDF, hear it read aloud.
// pdf.js does the text extraction. Two playback engines:
//   - browser: SpeechSynthesis (zero infra, immediate)
//   - pocket:  POST to a local pocket-tts server, decode + play via Web Audio
"use strict";

// pdf.js ships as an ES module from the CDN we pinned in index.html.
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.min.mjs";
// Worker is the same version, different file. Required for off-main-thread parsing.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  engine: $("engine"),
  pocketRow: $("pocketRow"),
  pocketVoiceRow: $("pocketVoiceRow"),
  pocketUrl: $("pocketUrl"),
  pocketHealth: $("pocketHealth"),
  pocketVoice: $("pocketVoice"),
  browserVoiceRow: $("browserVoiceRow"),
  browserVoice: $("browserVoice"),
  refreshVoices: $("refreshVoices"),
  speed: $("speed"),
  speedLabel: $("speedLabel"),
  drop: $("drop"),
  pickFile: $("pickFile"),
  file: $("file"),
  status: $("status"),
  prev: $("prev"),
  play: $("play"),
  pause: $("pause"),
  stop: $("stop"),
  next: $("next"),
  pageJump: $("pageJump"),
  pageCount: $("pageCount"),
  textOut: $("textOut"),
};

// ----- state -----
const state = {
  pdfDoc: null,
  pagesText: [],
  currentPage: 1,
  isPlaying: false,
  isPaused: false,
  // browser mode state
  browserQueue: [],
  browserIndex: 0,
  // pocket mode state
  pocketQueue: [],
  pocketIndex: 0,
  pocketBuffers: [],       // pre-decoded AudioBuffer per chunk (gaps out the stutter)
  pocketBase: "",          // base URL of the pocket-tts server
  abortPocket: false,
};

const MAX_CHARS_BROWSER = 220;
const MAX_CHARS_POCKET = 600;

// ----- Web Audio API context (pocket-tts engine) -----
// One shared AudioContext for the page. Decoding the WAV into an AudioBuffer
// and playing through an AudioBufferSourceNode is more reliable than the
// <audio> element + blob URL approach across browser engines (in-app
// WebViews, headless Chrome, etc.) - the <audio> element's
// MEDIA_ERR_SRC_NOT_SUPPORTED has too many ways to fire even with a valid
// blob URL, including spurious fires on cleanup. Web Audio either decodes
// or throws, and the source has a clean onended without an error channel.
let audioCtx = null;
let pocketSource = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

// ----- status line -----
function setStatus(msg, kind = "") {
  els.status.className = kind;
  els.status.textContent = msg;
}

// ----- engine-visibility plumbing -----
function applyEngineVisibility() {
  const isPocket = els.engine.value === "pocket";
  els.pocketRow.hidden = !isPocket;
  els.pocketVoiceRow.hidden = !isPocket;
  els.browserVoiceRow.hidden = isPocket;
}

els.engine.addEventListener("change", () => {
  applyEngineVisibility();
  if (state.isPlaying || state.isPaused) {
    const restartFromPage = state.currentPage;
    stopInternal().then(() => {
      state.currentPage = restartFromPage;
      playFromCurrent();
    });
  }
});

els.speed.addEventListener("input", () => {
  els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}\u00d7`;
  if (state.isPlaying) {
    if (els.engine.value === "browser") {
      // SpeechSynthesis has no per-utterance rate setter mid-flight in all browsers.
      const restartFromPage = state.currentPage;
      const remaining = state.browserQueue.slice(state.browserIndex);
      stopInternal().then(() => {
        state.browserQueue = remaining;
        state.browserIndex = 0;
        state.currentPage = restartFromPage;
        playFromCurrent();
      });
    } else if (pocketSource) {
      // AudioBufferSourceNode supports live playbackRate changes without
      // recreating the source.
      pocketSource.playbackRate.value = Number(els.speed.value);
    }
  }
});

// ----- browser voices -----
function refreshBrowserVoices() {
  const voices = window.speechSynthesis.getVoices() || [];
  els.browserVoice.innerHTML = "";
  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no voices available)";
    els.browserVoice.appendChild(opt);
    return;
  }
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
  const other = voices.filter((v) => !/^en[-_]/i.test(v.lang));
  for (const v of [...en, ...other]) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    els.browserVoice.appendChild(opt);
  }
}

if ("speechSynthesis" in window) {
  refreshBrowserVoices();
  window.speechSynthesis.onvoiceschanged = refreshBrowserVoices;
}
els.refreshVoices.addEventListener("click", refreshBrowserVoices);

// ----- pocket-tts health check -----
els.pocketHealth.addEventListener("click", async () => {
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set a Pocket TTS URL first.", "err");
    return;
  }
  setStatus(`Checking ${base}/health \u2026`);
  try {
    const r = await fetch(`${base}/health`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    setStatus(`Pocket TTS OK: ${j.status ?? "healthy"}`, "ok");
  } catch (e) {
    setStatus(`Pocket TTS unreachable: ${e.message}`, "err");
  }
});

// ----- file picking -----
els.pickFile.addEventListener("click", (e) => {
  e.stopPropagation();
  els.file.click();
});
els.drop.addEventListener("click", () => els.file.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.file.click();
  }
});
els.file.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadPdfFile(f);
});

// ----- drag and drop -----
["dragenter", "dragover"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.drop.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.drop.classList.remove("dragover");
  })
);
els.drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadPdfFile(f);
});

// ----- PDF loading -----
async function loadPdfFile(file) {
  if (!file) return;
  setStatus(`Reading ${file.name} (${(file.size / 1024).toFixed(0)} KB) \u2026`);
  try {
    const buf = await file.arrayBuffer();
    setStatus("Parsing PDF \u2026");
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pdfDoc = doc;
    state.pagesText = [];
    for (let i = 1; i <= doc.numPages; i++) {
      setStatus(`Extracting text: page ${i} / ${doc.numPages} \u2026`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .replace(/\s+\n/g, "\n")
        .trim();
      state.pagesText.push(text);
    }
    state.currentPage = 1;
    els.pageCount.textContent = String(doc.numPages);
    els.pageJump.disabled = false;
    els.pageJump.value = 1;
    els.pageJump.max = String(doc.numPages);
    els.prev.disabled = false;
    els.next.disabled = false;
    els.play.disabled = false;
    const totalChars = state.pagesText.reduce((a, t) => a + t.length, 0);
    setStatus(
      `Loaded ${file.name}: ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}, ${totalChars} chars.`,
      "ok"
    );
    els.textOut.textContent = state.pagesText.join("\n\n--- page break ---\n\n");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to read PDF: ${e.message}`, "err");
  }
}

// ----- chunking -----
function chunkText(text, maxChars) {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = [];
  let buf = "";
  for (const p of parts) {
    if (p.length > maxChars) {
      if (buf) { out.push(buf); buf = ""; }
      const words = p.split(/\s+/);
      let wb = "";
      for (const w of words) {
        if ((wb + " " + w).trim().length > maxChars) {
          if (wb) out.push(wb);
          wb = w;
        } else {
          wb = (wb ? wb + " " : "") + w;
        }
      }
      if (wb) out.push(wb);
      continue;
    }
    if ((buf + " " + p).trim().length > maxChars) {
      if (buf) out.push(buf);
      buf = p;
    } else {
      buf = (buf ? buf + " " : "") + p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ----- transport buttons -----
els.play.addEventListener("click", () => {
  if (!state.pdfDoc) return;
  if (state.isPaused) {
    resumeInternal();
  } else {
    playFromCurrent();
  }
});
els.pause.addEventListener("click", () => pauseInternal());
els.stop.addEventListener("click", () => stopInternal());
els.prev.addEventListener("click", () => {
  if (!state.pdfDoc) return;
  const restartFromPage = Math.max(1, state.currentPage - 1);
  stopInternal().then(() => {
    state.currentPage = restartFromPage;
    els.pageJump.value = String(restartFromPage);
    playFromCurrent();
  });
});
els.next.addEventListener("click", () => {
  if (!state.pdfDoc) return;
  const restartFromPage = Math.min(state.pdfDoc.numPages, state.currentPage + 1);
  stopInternal().then(() => {
    state.currentPage = restartFromPage;
    els.pageJump.value = String(restartFromPage);
    playFromCurrent();
  });
});
els.pageJump.addEventListener("change", () => {
  if (!state.pdfDoc) return;
  const n = Math.max(1, Math.min(state.pdfDoc.numPages, Number(els.pageJump.value) || 1));
  els.pageJump.value = String(n);
  stopInternal().then(() => {
    state.currentPage = n;
    playFromCurrent();
  });
});

// ----- playback control (engine dispatch) -----
function playFromCurrent() {
  if (!state.pdfDoc) return;
  if (els.engine.value === "browser") playBrowserFromCurrent();
  else playPocketFromCurrent();
}

function pauseInternal() {
  if (!state.isPlaying) return;
  if (els.engine.value === "browser") {
    window.speechSynthesis.pause();
  } else if (audioCtx && audioCtx.state === "running") {
    // Suspending the AudioContext pauses the active source at its
    // current position. Resuming plays on from there.
    try { audioCtx.suspend(); } catch (_) {}
  }
  state.isPaused = true;
  state.isPlaying = false;
  els.play.disabled = false;
  els.pause.disabled = true;
}

function resumeInternal() {
  if (!state.isPaused) return;
  if (els.engine.value === "browser") {
    window.speechSynthesis.resume();
    state.isPaused = false;
    state.isPlaying = true;
    els.play.disabled = true;
    els.pause.disabled = false;
  } else if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().then(() => {
      state.isPaused = false;
      state.isPlaying = true;
      els.play.disabled = true;
      els.pause.disabled = false;
    }).catch((e) => {
      setStatus(`Pocket resume error: ${e.message}`, "err");
      stopInternal();
    });
  }
}

async function stopInternal() {
  if (els.engine.value === "browser") {
    window.speechSynthesis.cancel();
    state.browserQueue = [];
    state.browserIndex = 0;
  } else {
    state.abortPocket = true;
    if (pocketSource) {
      try { pocketSource.stop(); } catch (_) {}
      pocketSource = null;
    }
    if (audioCtx && audioCtx.state === "running") {
      try { await audioCtx.suspend(); } catch (_) {}
    }
    state.pocketQueue = [];
    state.pocketIndex = 0;
    state.pocketBuffers = [];
  }
  state.isPlaying = false;
  state.isPaused = false;
  els.play.disabled = !state.pdfDoc;
  els.pause.disabled = true;
}

// ----- browser TTS playback -----
function playBrowserFromCurrent() {
  if (!("speechSynthesis" in window)) {
    setStatus("This browser does not support SpeechSynthesis.", "err");
    return;
  }
  const text = state.pagesText[state.currentPage - 1] || "";
  state.browserQueue = chunkText(text, MAX_CHARS_BROWSER);
  state.browserIndex = 0;
  if (state.browserQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} (browser TTS) \u2026`);
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  speakNextBrowserChunk();
}

function speakNextBrowserChunk() {
  if (!state.isPlaying || state.isPaused) return;
  if (state.browserIndex >= state.browserQueue.length) {
    if (state.pdfDoc && state.currentPage < state.pdfDoc.numPages) {
      state.currentPage += 1;
      els.pageJump.value = String(state.currentPage);
      playBrowserFromCurrent();
    } else {
      setStatus("Reached the end of the document.", "ok");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
    }
    return;
  }
  const text = state.browserQueue[state.browserIndex];
  const u = new SpeechSynthesisUtterance(text);
  const rate = Number(els.speed.value);
  if (rate) u.rate = rate;
  const voiceName = els.browserVoice.value;
  if (voiceName) {
    const v = window.speechSynthesis.getVoices().find((vv) => vv.name === voiceName);
    if (v) u.voice = v;
  }
  u.onend = () => {
    if (!state.isPlaying) return;
    state.browserIndex += 1;
    speakNextBrowserChunk();
  };
  u.onerror = (e) => {
    if (e.error && e.error !== "interrupted" && e.error !== "canceled") {
      setStatus(`Browser TTS error: ${e.error}`, "err");
    }
    state.isPlaying = false;
    els.play.disabled = !state.pdfDoc;
    els.pause.disabled = true;
  };
  window.speechSynthesis.speak(u);
}

// ----- pocket-tts playback (Web Audio API) -----
function playPocketFromCurrent() {
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set a Pocket TTS URL first.", "err");
    return;
  }
  const text = state.pagesText[state.currentPage - 1] || "";
  state.pocketQueue = chunkText(text, MAX_CHARS_POCKET);
  state.pocketIndex = 0;
  state.abortPocket = false;
  // Pre-decoded AudioBuffer for each chunk. Filled lazily as the fetches
  // complete. Pre-fetching the next chunk while the current one plays
  // eliminates the ~1s inter-chunk gap.
  state.pocketBuffers = new Array(state.pocketQueue.length).fill(null);
  state.pocketBase = base;
  if (state.pocketQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} via Pocket TTS \u2026`);
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  // Web Audio API: create or resume the AudioContext synchronously in
  // the click handler so the user-gesture activation is honored. The
  // fetch to pocket-tts is async; resume() before fetch keeps the
  // context out of the "suspended because no user gesture yet" state.
  try { getAudioCtx().resume(); } catch (_) {}
  // Start the first fetch. When its buffer is ready, hand off to
  // playNextPocketChunk, which checks the buffer and either plays it
  // (if ready) or awaits it. onended then chains through the rest,
  // and the post-play hook in playDecodedChunk pre-fetches chunk N+1.
  fetchAndDecodeChunk(0)
    .then(() => {
      if (state.abortPocket) return;
      playNextPocketChunk();
    })
    .catch(() => { /* error already surfaced in fetchAndDecodeChunk */ });
}

// Fetch + decode a single chunk into state.pocketBuffers[index].
// Resolves with the buffer on success, rejects on error.
async function fetchAndDecodeChunk(index) {
  if (state.abortPocket) return;
  if (state.pocketBuffers[index]) return state.pocketBuffers[index];
  const chunk = state.pocketQueue[index];
  const voice = els.pocketVoice.value.trim() || undefined;
  const form = new FormData();
  form.append("text", chunk);
  if (voice) form.append("voice_url", voice);
  try {
    const r = await fetch(`${state.pocketBase}/tts`, { method: "POST", body: form });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${body || r.statusText}`);
    }
    const arrayBuffer = await r.arrayBuffer();
    if (state.abortPocket) return;
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch (_) {}
    }
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (state.abortPocket) return;
    state.pocketBuffers[index] = buffer;
    return buffer;
  } catch (e) {
    if (!state.abortPocket) {
      setStatus(`Pocket TTS request failed: ${e.message}`, "err");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
    }
    throw e;
  }
}

function playNextPocketChunk() {
  if (state.abortPocket) return;
  if (state.pocketIndex >= state.pocketQueue.length) {
    if (state.pdfDoc && state.currentPage < state.pdfDoc.numPages) {
      state.currentPage += 1;
      els.pageJump.value = String(state.currentPage);
      playPocketFromCurrent();
    } else {
      setStatus("Reached the end of the document.", "ok");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
    }
    return;
  }
  const buffer = state.pocketBuffers[state.pocketIndex];
  if (buffer) {
    // Buffer is ready - play it now and pre-fetch the next one.
    playDecodedChunk(buffer);
    const nextIdx = state.pocketIndex + 1;
    if (nextIdx < state.pocketQueue.length && !state.pocketBuffers[nextIdx]) {
      fetchAndDecodeChunk(nextIdx).catch(() => {});
    }
  } else {
    // Buffer isn't ready yet (fetch still in flight). Wait for it,
    // then play. The next fetch was kicked off in the previous chunk's
    // playDecodedChunk so it should be ready by the time the current
    // one ends; this branch mostly handles the very first chunk.
    setStatus(
      `Pocket TTS: loading chunk ${state.pocketIndex + 1}/${state.pocketQueue.length} on page ${state.currentPage} \u2026`
    );
    fetchAndDecodeChunk(state.pocketIndex)
      .then((buf) => {
        if (state.abortPocket || !buf) return;
        playDecodedChunk(buf);
        const nextIdx = state.pocketIndex + 1;
        if (nextIdx < state.pocketQueue.length && !state.pocketBuffers[nextIdx]) {
          fetchAndDecodeChunk(nextIdx).catch(() => {});
        }
      })
      .catch(() => { /* error already surfaced in fetchAndDecodeChunk */ });
  }
}

function playDecodedChunk(buffer) {
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Number(els.speed.value) || 1.0;
  source.connect(ctx.destination);
  pocketSource = source;
  source.onended = () => {
    // If this source is no longer the active one (Stop, engine switch,
    // or replaced by a newer chunk), don't surface cleanup as a
    // failure or double-queue the next chunk.
    if (pocketSource !== source) return;
    pocketSource = null;
    if (state.abortPocket) return;
    state.pocketIndex += 1;
    playNextPocketChunk();
  };
  source.start(0);
  setStatus(
    `Pocket TTS: chunk ${state.pocketIndex + 1}/${state.pocketQueue.length} on page ${state.currentPage} \u2026`
  );
}

// ----- initial UI state -----
applyEngineVisibility();
els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}\u00d7`;
setStatus("Drop a PDF to start.");
