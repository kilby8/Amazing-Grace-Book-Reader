// Grace Reader — drop a PDF, hear it read aloud.
// pdf.js does the text extraction. Two playback engines:
//   - browser: SpeechSynthesis (zero infra, immediate)
//   - pocket:  POST to a local pocket-tts server, play the WAV back
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
  pdfDoc: null,           // pdf.js document proxy
  pagesText: [],          // string per page, after extraction
  currentPage: 1,         // 1-indexed
  isPlaying: false,
  isPaused: false,
  // browser mode state
  browserQueue: [],       // remaining chunks for the current page
  browserIndex: 0,        // index into the current utterance within the page
  // pocket mode state
  pocketAudio: null,      // currently-playing HTMLAudioElement (or null)
  pocketQueue: [],        // remaining chunks
  pocketIndex: 0,
  abortPocket: false,     // set true to stop the in-flight fetch chain
};

const MAX_CHARS_BROWSER = 220;  // SpeechSynthesis chokes on very long utterances
const MAX_CHARS_POCKET = 600;   // pocket-tts handles longer, but chunks help latency

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
  // If we were mid-playback on the other engine, restart from the same place.
  if (state.isPlaying || state.isPaused) {
    const restartFromPage = state.currentPage;
    stopInternal().then(() => {
      state.currentPage = restartFromPage;
      playFromCurrent();
    });
  }
});

els.speed.addEventListener("input", () => {
  els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}×`;
  if (state.isPlaying) {
    if (els.engine.value === "browser") {
      // SpeechSynthesis has no per-utterance rate setter mid-flight in all browsers.
      // Re-issuing the current chunk with the new rate is the simplest portable fix.
      const restartFromPage = state.currentPage;
      const remaining = state.browserQueue.slice(state.browserIndex);
      stopInternal().then(() => {
        state.browserQueue = remaining;
        state.browserIndex = 0;
        state.currentPage = restartFromPage;
        playFromCurrent();
      });
    } else if (state.pocketAudio) {
      state.pocketAudio.playbackRate = Number(els.speed.value);
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
  // Prefer English voices up top, then the rest.
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
  const other = voices.filter((v) => !/^en[-_]/i.test(v.lang));
  for (const v of [...en, ...other]) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    els.browserVoice.appendChild(opt);
  }
}

// Voices load asynchronously in Chrome; also re-fill when the engine changes.
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
  setStatus(`Checking ${base}/health …`);
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
  setStatus(`Reading ${file.name} (${(file.size / 1024).toFixed(0)} KB) …`);
  try {
    const buf = await file.arrayBuffer();
    setStatus("Parsing PDF …");
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pdfDoc = doc;
    state.pagesText = [];
    for (let i = 1; i <= doc.numPages; i++) {
      setStatus(`Extracting text: page ${i} / ${doc.numPages} …`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // pdf.js gives us an array of text items; join with spaces. Newlines are
      // preserved where the source PDF had them, which reads better.
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
// Split on sentence boundaries first; then pack sentences into chunks no
// longer than maxChars. Empty strings get dropped.
function chunkText(text, maxChars) {
  if (!text) return [];
  // Naive but adequate sentence splitter: any of `.`, `!`, `?` followed by
  // whitespace, or a hard newline.
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = [];
  let buf = "";
  for (const p of parts) {
    if (p.length > maxChars) {
      // Oversized sentence — hard-split on word boundaries.
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
  } else if (state.pocketAudio) {
    state.pocketAudio.pause();
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
  } else if (state.pocketAudio) {
    state.pocketAudio.play().catch((e) => {
      setStatus(`Pocket playback error: ${e.message}`, "err");
      stopInternal();
    });
    state.isPaused = false;
    state.isPlaying = true;
    els.play.disabled = true;
    els.pause.disabled = false;
  }
}

async function stopInternal() {
  if (els.engine.value === "browser") {
    window.speechSynthesis.cancel();
    state.browserQueue = [];
    state.browserIndex = 0;
  } else {
    state.abortPocket = true;
    if (state.pocketAudio) {
      // Pause and drop our reference. Do NOT set src = "" — that fires
      // MEDIA_ERR_SRC_NOT_SUPPORTED on the element which we then surface
      // as a fake playback error. Just pausing + dropping the ref is
      // enough; URL.revokeObjectURL from the chunk's onended/onerror will
      // garbage-collect the blob when nothing else holds it.
      try { state.pocketAudio.pause(); } catch (_) {}
      state.pocketAudio = null;
    }
    state.pocketQueue = [];
    state.pocketIndex = 0;
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
  // Build the queue for the current page (only).
  const text = state.pagesText[state.currentPage - 1] || "";
  state.browserQueue = chunkText(text, MAX_CHARS_BROWSER);
  state.browserIndex = 0;
  if (state.browserQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} (browser TTS) …`);
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
    // End of page — auto-advance if there is a next page.
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
    if (!state.isPlaying) return;  // user stopped
    state.browserIndex += 1;
    speakNextBrowserChunk();
  };
  u.onerror = (e) => {
    // 'interrupted'/'canceled' is expected when the user hits Stop.
    if (e.error && e.error !== "interrupted" && e.error !== "canceled") {
      setStatus(`Browser TTS error: ${e.error}`, "err");
    }
    state.isPlaying = false;
    els.play.disabled = !state.pdfDoc;
    els.pause.disabled = true;
  };
  window.speechSynthesis.speak(u);
}

// ----- pocket-tts playback -----

// Tiny silent WAV used to preserve the user-gesture activation window
// across the async fetch to the TTS server. Without this, a slow fetch
// can outlast the activation window and the subsequent audio.play() is
// rejected with NotAllowedError. 0.05s mono 8-bit PCM, verified valid.
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function primeAudioActivation() {
  try {
    const a = new Audio(SILENT_WAV_DATA_URL);
    a.volume = 0;
    a.play().catch(() => {});
  } catch (_) { /* best effort */ }
}

function describeMediaError(err) {
  // HTMLMediaElement.error is a MediaError with a numeric .code; .message is
  // empty in some browsers. Map the common codes to a readable name.
  if (!err) return "unknown media error";
  const codes = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
  return codes[err.code] || `code ${err.code}`;
}

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
  if (state.pocketQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} via Pocket TTS …`);
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  // Preserve the user-activation window across the async fetch.
  primeAudioActivation();
  playNextPocketChunk(base);
}

function playNextPocketChunk(base) {
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
  const chunk = state.pocketQueue[state.pocketIndex];
  const voice = els.pocketVoice.value.trim() || undefined;
  setStatus(
    `Pocket TTS: chunk ${state.pocketIndex + 1}/${state.pocketQueue.length} on page ${state.currentPage} …`
  );

  // Build a multipart form. The server accepts `text` (required) and
  // `voice_url` (optional built-in name like `eve`).
  const form = new FormData();
  form.append("text", chunk);
  if (voice) form.append("voice_url", voice);

  // The wav comes back as a stream; we don't actually need to stream — we can
  // wait for the full blob and play it as one Audio element. This is simpler
  // and the chunks are already small enough to keep latency reasonable.
  fetch(`${base}/tts`, { method: "POST", body: form })
    .then((r) => {
      if (!r.ok) {
        return r.text().then((body) => {
          throw new Error(`HTTP ${r.status}: ${body || r.statusText}`);
        });
      }
      return r.blob();
    })
    .then((blob) => {
      if (state.abortPocket) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = Number(els.speed.value) || 1.0;
      state.pocketAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        state.pocketAudio = null;
        if (state.abortPocket) return;
        // Only advance if this audio is still the active one. Otherwise a
        // user-initiated Stop or engine switch may have already moved on
        // and we don't want to double-queue the next chunk.
        if (state.pocketAudio !== audio) return;
        state.pocketIndex += 1;
        playNextPocketChunk(base);
      };
      audio.onerror = () => {
        // If this audio is no longer the active one (Stop, engine switch,
        // or replaced by a newer chunk), don't surface the error — it's
        // expected cleanup, not a real failure.
        if (state.pocketAudio !== audio) {
          URL.revokeObjectURL(url);
          return;
        }
        const desc = describeMediaError(audio.error);
        URL.revokeObjectURL(url);
        setStatus(`Pocket TTS audio error: ${desc}`, "err");
        state.isPlaying = false;
        els.play.disabled = !state.pdfDoc;
        els.pause.disabled = true;
      };
      audio.play().catch((e) => {
        URL.revokeObjectURL(url);
        setStatus(`Pocket playback error: ${e.name}: ${e.message}`, "err");
        state.isPlaying = false;
        els.play.disabled = !state.pdfDoc;
        els.pause.disabled = true;
      });
    })
    .catch((e) => {
      if (state.abortPocket) return;
      setStatus(`Pocket TTS request failed: ${e.message}`, "err");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
    });
}

// ----- initial UI state -----
applyEngineVisibility();
els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}×`;
setStatus("Drop a PDF to start.");
