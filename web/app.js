// Amazing Grace Reader - drop a PDF or EPUB, hear it read aloud.
// pdf.js does the text extraction. Two playback engines:
//   - browser: SpeechSynthesis (zero infra, immediate)
//   - pocket:  POST to a local pocket-tts server, decode + play via Web Audio
//
// App flow:
//   auth -> library -> reader
//   1. /api/me on load decides which screen to show
//   2. Library shows the user's saved books; clicking one opens it
//   3. Drop / file-picker on the library screen uploads + opens the new
//      book in the reader in one motion
//   4. "Back to library" returns to the grid; "Sign out" clears session
"use strict";

// pdf.js ships as an ES module from the CDN we pinned in index.html.
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

const els = {
  // Top-level screens
  status: $("status"),
  logoutBtn: $("logoutBtn"),
  authScreen: $("authScreen"),
  libraryScreen: $("libraryScreen"),
  readerScreen: $("readerScreen"),

  // Auth screen
  tabLogin: $("tabLogin"),
  tabRegister: $("tabRegister"),
  authForm: $("authForm"),
  authUsername: $("authUsername"),
  authPassword: $("authPassword"),
  authError: $("authError"),
  authSubmit: $("authSubmit"),
  authSubmitLabel: $("authSubmitLabel"),

  // Library screen
  libraryGreeting: $("libraryGreeting"),
  uploadPickBtn: $("uploadPickBtn"),
  filePicker: $("filePicker"),
  drop: $("drop"),
  pickFile: $("pickFile"),  // legacy - library uses filePicker; reader uses this; both share #drop
  file: $("file"),           // reader-only hidden file input
  bookGrid: $("bookGrid"),
  libraryEmpty: $("libraryEmpty"),
  backToLibrary: $("backToLibrary"),
  browsePublicBtn: $("browsePublicBtn"),

  // Public-library screen
  publicScreen: $("publicScreen"),
  publicGrid: $("publicGrid"),
  publicEmpty: $("publicEmpty"),
  backFromPublic: $("backFromPublic"),

  // Reader screen
  engine: $("engine"),
  pocketRow: $("pocketRow"),
  pocketVoiceRow: $("pocketVoiceRow"),
  pocketUrl: $("pocketUrl"),
  pocketHealth: $("pocketHealth"),
  pocketVoice: $("pocketVoice"),
  elevenLabsRow: $("elevenLabsRow"),
  elevenLabsVoice: $("elevenLabsVoice"),
  elevenLabsStatus: $("elevenLabsStatus"),
  browserVoiceRow: $("browserVoiceRow"),
  browserVoice: $("browserVoice"),
  refreshVoices: $("refreshVoices"),
  speed: $("speed"),
  speedLabel: $("speedLabel"),
  prev: $("prev"),
  play: $("play"),
  playLabel: $("playLabel"),
  playIcon: $("playIcon"),
  pause: $("pause"),
  stop: $("stop"),
  next: $("next"),
  audioPos: $("audioPos"),
  audioPosLabel: $("audioPosLabel"),
  nowReading: $("now-reading"),
  nrTitle: $("nrTitle"),
  pageJump: $("pageJump"),
  pageCount: $("pageCount"),
  pagePrint: $("pagePrint"),
  textOut: $("textOut"),
};

// ----- state -----
const state = {
  // Session
  user: null,                    // { id, username } | null
  screen: "loading",             // "loading" | "auth" | "library" | "reader"
  // Library
  books: [],                     // [{id,title,author,kind,size,added_at,last_opened_at,visibility,shared_at}]
  publicBooks: [],               // [{id,title,author,kind,size,shared_at,shared_by}]
  // Reader
  pdfDoc: null,
  pagesText: [],
  currentPage: 1,
  isPlaying: false,
  isPaused: false,
  browserQueue: [],
  browserIndex: 0,
  pocketQueue: [],
  pocketIndex: 0,
  pocketBuffers: [],
  pocketBase: "",
  abortPocket: false,
  pocketPlayToken: 0,
  elevenLabsQueue: [],
  elevenLabsIndex: 0,
  elevenLabsBuffers: [],
  abortElevenLabs: false,
  elevenLabsPlayToken: 0,
  // Guards source.onended from advancing the chunk index when the user
  // paused via audioCtx.suspend(). Chrome fires onended synthetically on
  // suspend, which used to make pause→play jump to the next chunk instead
  // of resuming the paused one.
  audioCtxSuspended: false,
  // True while the user is mid-drag on the position slider so the ticker
  // doesn't fight their pointer.
  isDraggingSlider: false,
  pagePrintNumbers: null,
  chapterTitles: null,
  bookTitle: "",
  // The id of the currently loaded book (so "back to library" + reopen works)
  currentBookId: null,
};

// ----- API helpers -----
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.dataset.state = kind || "idle";
}

// ----- Screen routing -----
function showScreen(name) {
  state.screen = name;
  for (const s of [els.authScreen, els.libraryScreen, els.publicScreen, els.readerScreen]) {
    if (!s) continue;
    s.hidden = true;
  }
  if (name === "auth" && els.authScreen) els.authScreen.hidden = false;
  if (name === "library" && els.libraryScreen) els.libraryScreen.hidden = false;
  if (name === "public" && els.publicScreen) els.publicScreen.hidden = false;
  if (name === "reader" && els.readerScreen) els.readerScreen.hidden = false;
  els.logoutBtn.hidden = !(state.user && (name === "library" || name === "public" || name === "reader"));
}

function setNowReadingTitle(bookTitle) {
  els.nrTitle.textContent = bookTitle || "";
  els.nowReading.hidden = !bookTitle;
}

function syncPlayButton() {
  if (els.playLabel) els.playLabel.textContent = state.isPaused ? "Resume" : "Play";
  if (els.playIcon) {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7L8 5z"/>';
  }
}

// ----- Init: check session and route -----
async function init() {
  setStatus("Checking session…", "busy");
  try {
    const me = await api("/api/me");
    if (me.user) {
      state.user = me.user;
      await loadLibrary();
      showScreen("library");
      setStatus(`Signed in as ${me.user.username}`);
    } else {
      state.user = null;
      showScreen("auth");
      setStatus("Sign in to start");
    }
  } catch (e) {
    setStatus(`Could not reach server: ${e.message}`, "err");
    showScreen("auth");
  }
}

// ----- Auth flow -----
let authMode = "login"; // "login" | "register"

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === "login";
  els.tabLogin.classList.toggle("auth-tab-active", isLogin);
  els.tabRegister.classList.toggle("auth-tab-active", !isLogin);
  els.tabLogin.setAttribute("aria-selected", String(isLogin));
  els.tabRegister.setAttribute("aria-selected", String(!isLogin));
  els.authSubmitLabel.textContent = isLogin ? "Sign in" : "Create account";
  els.authPassword.setAttribute("autocomplete", isLogin ? "current-password" : "new-password");
  els.authError.hidden = true;
  els.authError.textContent = "";
}
els.tabLogin.addEventListener("click", () => setAuthMode("login"));
els.tabRegister.addEventListener("click", () => setAuthMode("register"));

function showAuthError(msg) {
  els.authError.textContent = msg;
  els.authError.hidden = false;
}

els.authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.authError.hidden = true;
  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;
  if (!username || !password) return showAuthError("Username and password are required.");
  els.authSubmit.disabled = true;
  els.authSubmitLabel.textContent = authMode === "login" ? "Signing in…" : "Creating account…";
  setStatus(authMode === "login" ? "Signing in…" : "Creating account…", "busy");
  try {
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const { user } = await api(path, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    state.user = user;
    await loadLibrary();
    showScreen("library");
    setStatus(`Welcome, ${user.username}`, "ok");
    els.authPassword.value = "";
  } catch (err) {
    showAuthError(err.message);
    setStatus(err.message, "err");
    els.authSubmitLabel.textContent = authMode === "login" ? "Sign in" : "Create account";
  } finally {
    els.authSubmit.disabled = false;
  }
});

els.logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (_) { /* best-effort */ }
  state.user = null;
  state.books = [];
  state.currentBookId = null;
  showScreen("auth");
  setStatus("Signed out");
  els.authUsername.value = "";
  els.authPassword.value = "";
  setAuthMode("login");
});

// ----- Library -----
async function loadLibrary() {
  try {
    const { books } = await api("/api/books");
    state.books = books;
    renderLibrary();
  } catch (e) {
    setStatus(`Could not load library: ${e.message}`, "err");
  }
}

function renderLibrary() {
  els.bookGrid.innerHTML = "";
  els.libraryEmpty.hidden = state.books.length > 0;
  // Greeting always reflects current book count (including empty)
  if (state.user) {
    if (state.books.length === 0) {
      els.libraryGreeting.textContent = `Welcome, ${state.user.username}. Your library is empty.`;
    } else if (state.books.length === 1) {
      els.libraryGreeting.textContent = `Welcome back, ${state.user.username}. 1 book in your library.`;
    } else {
      els.libraryGreeting.textContent = `Welcome back, ${state.user.username}. ${state.books.length} books in your library.`;
    }
  }
  if (state.books.length === 0) return;
  for (const b of state.books) {
    const li = document.createElement("li");
    li.className = "book-card";
    li.dataset.id = String(b.id);
    const isPublic = b.visibility === "public";
    const kindLabel = b.kind.toUpperCase();
    const sizeKB = (b.size / 1024).toFixed(0);
    const dateStr = new Date(b.added_at).toLocaleDateString();
    li.innerHTML = `
      <button class="book-card-open" data-id="${b.id}" aria-label="Open ${escapeHtml(b.title)}">
        <div class="book-card-mark" aria-hidden="true">${escapeHtml(kindLabel)}</div>
        <div class="book-card-body">
          <h3 class="book-card-title">${escapeHtml(b.title)}</h3>
          ${b.author ? `<p class="book-card-author">${escapeHtml(b.author)}</p>` : ""}
          <p class="book-card-meta">${sizeKB} KB &middot; ${escapeHtml(dateStr)}</p>
        </div>
      </button>
      <button class="book-card-share" data-id="${b.id}" aria-pressed="${isPublic}" aria-label="${isPublic ? "Make private" : "Share publicly"}" title="${isPublic ? "Public — anyone signed in can read it" : "Private — only you can read it"}">
        <svg class="book-card-share-icon-private" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <svg class="book-card-share-icon-public" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
        <span class="book-card-share-label">${isPublic ? "Public" : "Private"}</span>
      </button>
      <button class="book-card-del" data-id="${b.id}" aria-label="Delete ${escapeHtml(b.title)}" title="Remove from library">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    `;
    els.bookGrid.appendChild(li);
  }
  els.bookGrid.querySelectorAll(".book-card-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      openBookFromLibrary(id);
    });
  });
  els.bookGrid.querySelectorAll(".book-card-share").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const book = state.books.find((b) => b.id === id);
      if (!book) return;
      const target = book.visibility === "public" ? "private" : "public";
      try {
        await setBookVisibility(id, target);
      } catch (err) {
        setStatus(`Could not change sharing: ${err.message}`, "err");
      }
    });
  });
  els.bookGrid.querySelectorAll(".book-card-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const book = state.books.find((b) => b.id === id);
      if (!book) return;
      const ok = confirm(`Remove "${book.title}" from your library? The file will be deleted from disk.`);
      if (!ok) return;
      try {
        await api(`/api/books/${id}`, { method: "DELETE" });
        state.books = state.books.filter((b) => b.id !== id);
        renderLibrary();
        setStatus(`Removed "${book.title}"`, "ok");
      } catch (err) {
        setStatus(`Could not remove: ${err.message}`, "err");
      }
    });
  });
}

// Toggle a book's visibility. Optimistic: flip the local state and re-render
// immediately, then revert on error.
async function setBookVisibility(id, visibility) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  const prevVisibility = book.visibility;
  const prevSharedAt = book.shared_at;
  book.visibility = visibility;
  book.shared_at = visibility === "public" ? Date.now() : null;
  renderLibrary();
  try {
    const res = await api(`/api/books/${id}/visibility`, {
      method: "POST",
      body: JSON.stringify({ visibility }),
    });
    // Trust the server's shared_at so clocks stay consistent.
    if (res && typeof res.shared_at !== "undefined") {
      book.shared_at = res.shared_at;
    }
    setStatus(
      visibility === "public"
        ? `Shared "${book.title}" with the public library`
        : `Made "${book.title}" private`,
      "ok"
    );
  } catch (err) {
    // Revert on failure.
    book.visibility = prevVisibility;
    book.shared_at = prevSharedAt;
    renderLibrary();
    throw err;
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Upload (drag-drop OR picker) - same handler for both library and reader
async function uploadFile(file) {
  if (!state.user) {
    setStatus("Sign in to save books", "err");
    return;
  }
  const name = (file.name || "").toLowerCase();
  if (!name.endsWith(".pdf") && !name.endsWith(".epub")) {
    setStatus("Only PDF and EPUB files are supported", "err");
    return;
  }
  setStatus(`Uploading ${file.name}…`, "busy");
  try {
    const form = new FormData();
    form.append("file", file);
    const { book } = await api("/api/books", { method: "POST", body: form });
    setStatus(`Saved "${book.title}"`, "ok");
    // Insert at top of list and open it
    state.books = [book, ...state.books.filter((b) => b.id !== book.id)];
    if (state.screen === "library") renderLibrary();
    await openBookFromLibrary(book.id);
  } catch (e) {
    setStatus(`Upload failed: ${e.message}`, "err");
  }
}

async function openBookFromLibrary(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) {
    setStatus("Book not found in library", "err");
    return;
  }
  setStatus(`Loading "${book.title}"…`, "busy");
  try {
    const res = await fetch(`/api/books/${id}/file`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], `${book.title}.${book.kind}`, { type: blob.type });
    // Update last_opened_at locally so the library shows it as recent
    book.last_opened_at = Date.now();
    state.currentBookId = id;
    showScreen("reader");
    applyEngineVisibility();
    syncPlayButton();
    await loadDocument(file);
  } catch (e) {
    setStatus(`Could not open book: ${e.message}`, "err");
  }
}

els.uploadPickBtn.addEventListener("click", () => els.filePicker.click());
els.filePicker.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadFile(f);
  e.target.value = "";
});

// ----- Public library -----
async function loadPublicLibrary() {
  try {
    const { books } = await api("/api/public-books");
    state.publicBooks = books;
    renderPublicLibrary();
  } catch (e) {
    setStatus(`Could not load public library: ${e.message}`, "err");
  }
}

function renderPublicLibrary() {
  if (!els.publicGrid) return;
  els.publicGrid.innerHTML = "";
  els.publicEmpty.hidden = state.publicBooks.length > 0;
  if (state.publicBooks.length === 0) return;
  for (const b of state.publicBooks) {
    const li = document.createElement("li");
    li.className = "book-card";
    li.dataset.id = String(b.id);
    const kindLabel = b.kind.toUpperCase();
    const sizeKB = (b.size / 1024).toFixed(0);
    const sharedStr = b.shared_at ? new Date(b.shared_at).toLocaleDateString() : "";
    li.innerHTML = `
      <button class="book-card-open" data-id="${b.id}" aria-label="Open ${escapeHtml(b.title)}">
        <div class="book-card-mark" aria-hidden="true">${escapeHtml(kindLabel)}</div>
        <div class="book-card-body">
          <h3 class="book-card-title">${escapeHtml(b.title)}</h3>
          ${b.author ? `<p class="book-card-author">${escapeHtml(b.author)}</p>` : ""}
          <p class="book-card-meta">${sizeKB} KB &middot; shared by <span class="book-card-sharedby">@${escapeHtml(b.shared_by || "")}</span>${sharedStr ? " &middot; " + escapeHtml(sharedStr) : ""}</p>
        </div>
      </button>
    `;
    els.publicGrid.appendChild(li);
  }
  els.publicGrid.querySelectorAll(".book-card-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      openBookFromPublicLibrary(id);
    });
  });
}

async function openBookFromPublicLibrary(id) {
  const book = state.publicBooks.find((b) => b.id === id);
  if (!book) {
    setStatus("Book not found in public library", "err");
    return;
  }
  setStatus(`Loading "${book.title}"…`, "busy");
  try {
    const res = await fetch(`/api/books/${id}/file`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], `${book.title}.${book.kind}`, { type: blob.type });
    state.currentBookId = id;
    showScreen("reader");
    applyEngineVisibility();
    syncPlayButton();
    await loadDocument(file);
  } catch (e) {
    setStatus(`Could not open book: ${e.message}`, "err");
  }
}

if (els.browsePublicBtn) {
  els.browsePublicBtn.addEventListener("click", async () => {
    setStatus("Loading public library…", "busy");
    showScreen("public");
    await loadPublicLibrary();
    setStatus("Browsing public library");
  });
}
if (els.backFromPublic) {
  els.backFromPublic.addEventListener("click", async () => {
    showScreen("library");
    setStatus("Back to library");
  });
}

els.backToLibrary.addEventListener("click", async () => {
  // Stop playback before leaving the reader
  await stopInternal();
  state.currentBookId = null;
  state.pdfDoc = null;
  state.pagesText = [];
  state.bookTitle = "";
  state.chapterTitles = null;
  state.pagePrintNumbers = null;
  setNowReadingTitle("");
  els.textOut.textContent = "";
  setCurrentPage(1);
  showScreen("library");
  await loadLibrary();
  setStatus("Back to library");
});

// ----- Document loading (PDF or EPUB) - called by both library and direct drop -----
async function loadDocument(file) {
  if (!file) return;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".epub") || file.type === "application/epub+zip") {
    return loadEpubFile(file);
  }
  return loadPdfFile(file);
}

// Drop zone wiring - on library screen it's an upload zone; on reader
// screen it's still a way to load a one-off without saving (but requires
// being logged in to actually do anything useful).
function wireDropzone() {
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
    if (f) uploadFile(f);
  });
  // The library drop zone opens the picker on click/Enter; the reader
  // drop zone does the same (the picker re-uses the library filePicker).
  els.drop.addEventListener("click", () => els.filePicker.click());
  els.drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.filePicker.click();
    }
  });
}
wireDropzone();

// ----- The reader: PDF + EPUB extraction + playback -----
// (logic preserved verbatim from the single-page version)

const MAX_CHARS_BROWSER = 220;
const MAX_CHARS_POCKET = 600;
// ElevenLabs is server-proxied and counts against the monthly quota.
// 1500 chars per chunk matches the server-side cap; fewer round trips
// = better cost-per-chapter and smoother playback.
const MAX_CHARS_ELEVENLABS = 1500;

let audioCtx = null;
let pocketSource = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

async function loadPdfFile(file) {
  if (!file) return;
  setStatus(`Reading ${file.name} (${(file.size / 1024).toFixed(0)} KB) \u2026`, "busy");
  try {
    const buf = await file.arrayBuffer();
    setStatus("Parsing PDF \u2026", "busy");
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    state.pdfDoc = doc;
    state.pagesText = [];
    state.pagePrintNumbers = null;
    state.chapterTitles = null;
    for (let i = 1; i <= doc.numPages; i++) {
      setStatus(`Extracting text: page ${i} / ${doc.numPages} \u2026`, "busy");
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
    let bookTitle = file.name.replace(/\.pdf$/i, "");
    try {
      const meta = await doc.getMetadata();
      if (meta && meta.info && typeof meta.info.Title === "string" && meta.info.Title.trim()) {
        bookTitle = meta.info.Title.trim();
      }
    } catch (_) {}
    state.bookTitle = bookTitle;
    setNowReadingTitle(bookTitle);
    setCurrentPage(1);
    els.pageCount.textContent = String(doc.numPages);
    els.pageJump.disabled = false;
    els.pageJump.max = String(doc.numPages);
    els.prev.disabled = false;
    els.next.disabled = false;
    els.play.disabled = false;
    const totalChars = state.pagesText.reduce((a, t) => a + t.length, 0);
    setStatus(
      `Loaded ${doc.numPages} page${doc.numPages === 1 ? "" : "s"} \u00b7 ${totalChars.toLocaleString()} chars`,
      "ok"
    );
    els.textOut.textContent = state.pagesText.join("\n\n--- page break ---\n\n");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to read PDF: ${e.message}`, "err");
  }
}

async function loadEpubFile(file) {
  if (!file) return;
  if (typeof JSZip === "undefined") {
    setStatus("EPUB support needs JSZip; reload the page to load it.", "err");
    return;
  }
  setStatus(`Reading ${file.name} (${(file.size / 1024).toFixed(0)} KB) \u2026`, "busy");
  try {
    setStatus("Unzipping EPUB \u2026", "busy");
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const container = await zip.file("META-INF/container.xml").async("string");
    const containerDoc = new DOMParser().parseFromString(container, "application/xml");
    const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
    if (!opfPath) throw new Error("EPUB container.xml has no rootfile full-path");
    const opfText = await zip.file(opfPath).async("string");
    const opfDoc = new DOMParser().parseFromString(opfText, "application/xml");
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    let pageNumberByHref = {};
    const navItem = opfDoc.querySelector('manifest > item[properties*="nav"]');
    if (navItem) {
      const navHref = navItem.getAttribute("href") || "";
      const navPath = navHref.startsWith("/") ? navHref.slice(1) : opfDir + navHref;
      const navEntry = zip.file(navPath);
      if (navEntry) {
        const navText = await navEntry.async("string");
        const navDoc = new DOMParser().parseFromString(navText, "application/xhtml+xml");
        let pl = null;
        navDoc.querySelectorAll("nav").forEach((n) => {
          if (pl) return;
          for (const a of n.attributes) {
            if (a.localName === "type" && a.value === "page-list") pl = n;
          }
        });
        if (pl) {
          pl.querySelectorAll("a").forEach((a) => {
            const href = a.getAttribute("href") || "";
            const fullFile = href.split("#")[0];
            if (!fullFile) return;
            const base = fullFile.split("/").pop();
            const label = (a.textContent || "").trim();
            if (!label) return;
            if (!(base in pageNumberByHref)) pageNumberByHref[base] = label;
          });
        }
      }
    }
    const items = {};
    opfDoc.querySelectorAll("manifest > item").forEach((el) => {
      const id = el.getAttribute("id");
      const href = el.getAttribute("href");
      const props = el.getAttribute("properties") || "";
      if (id && href && props.indexOf("nav") === -1) items[id] = href;
    });
    const spineIds = Array.from(opfDoc.querySelectorAll("spine > itemref"))
      .map((el) => el.getAttribute("idref"))
      .filter((id) => id && items[id]);
    if (spineIds.length === 0) throw new Error("EPUB spine is empty");
    const pagePrintNumbers = spineIds.map((id) => {
      const href = items[id] || "";
      const base = href.split("/").pop();
      return pageNumberByHref[base] || null;
    });
    const pages = [];
    const chapterTitles = [];
    for (let i = 0; i < spineIds.length; i++) {
      const id = spineIds[i];
      const href = items[id];
      const fullPath = opfDir + href;
      setStatus(`Extracting chapter ${i + 1} / ${spineIds.length} \u2026`, "busy");
      const entry = zip.file(fullPath);
      if (!entry) {
        pages.push("");
        chapterTitles.push("");
        continue;
      }
      const xhtml = await entry.async("string");
      const xhtmlDoc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
      const SKIP = new Set(["SCRIPT", "STYLE", "HEAD"]);
      let text = "";
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 1) {
          if (SKIP.has(node.tagName)) return;
          const isBlock = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|H[1-6]|BR|LI|BLOCKQUOTE|HR)$/i.test(node.tagName);
          if (isBlock && text && !text.endsWith("\n")) text += "\n";
          for (const child of node.childNodes) walk(child);
          if (isBlock && !text.endsWith("\n")) text += "\n";
        } else if (node.nodeType === 3) {
          text += node.nodeValue;
        }
      };
      walk(xhtmlDoc.body || xhtmlDoc.documentElement);
      text = text
        .replace(/<[^>]+>/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*\n\s*/g, "\n\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      let chapterTitle = "";
      const titleEl = xhtmlDoc.querySelector("title");
      if (titleEl && titleEl.textContent.trim()) {
        chapterTitle = titleEl.textContent.trim();
      } else {
        for (const tag of ["h1", "h2", "h3"]) {
          const h = xhtmlDoc.querySelector(tag);
          if (h && h.textContent.trim()) {
            chapterTitle = h.textContent.trim().replace(/\s+/g, " ");
            break;
          }
        }
      }
      pages.push(text);
      chapterTitles.push(chapterTitle);
    }
    state.pdfDoc = { numPages: pages.length, _kind: "epub" };
    state.pagesText = pages;
    state.pagePrintNumbers = pagePrintNumbers;
    state.chapterTitles = chapterTitles;
    const titleMatch = opfText.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
    const bookTitle = titleMatch
      ? titleMatch[1].trim()
      : file.name.replace(/\.epub$/i, "");
    state.bookTitle = bookTitle;
    setNowReadingTitle(bookTitle);
    setCurrentPage(1);
    els.pageCount.textContent = String(pages.length);
    els.pageJump.disabled = false;
    els.pageJump.max = String(pages.length);
    els.prev.disabled = false;
    els.next.disabled = false;
    els.play.disabled = false;
    const totalChars = pages.reduce((a, t) => a + t.length, 0);
    setStatus(
      `Loaded ${pages.length} chapter${pages.length === 1 ? "" : "s"} \u00b7 ${totalChars.toLocaleString()} chars`,
      "ok"
    );
    els.textOut.textContent = pages.map((p, i) => {
      const pn = pagePrintNumbers[i];
      const tag = pn ? `ch. ${i + 1} / p. ${pn}` : `ch. ${i + 1}`;
      return `--- ${tag} ---\n${p}`;
    }).join("\n\n");
  } catch (e) {
    console.error(e);
    setStatus(`Failed to read EPUB: ${e.message}`, "err");
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

// ----- print-page badge + chapter title -----
function updatePagePrintBadge() {
  const pp = state.pagePrintNumbers && state.pagePrintNumbers[state.currentPage - 1];
  if (pp) {
    els.pagePrint.textContent = `p. ${pp}`;
    els.pagePrint.hidden = false;
  } else {
    els.pagePrint.textContent = "";
    els.pagePrint.hidden = true;
  }
}

function setCurrentPage(n) {
  state.currentPage = n;
  if (els.pageJump) els.pageJump.value = String(n);
  updatePagePrintBadge();
  const ct = state.chapterTitles && state.chapterTitles[n - 1];
  if (ct) setNowReadingTitle(ct);
  else if (state.bookTitle) setNowReadingTitle(state.bookTitle);
}

// ----- engine + speed -----
function applyEngineVisibility() {
  const v = els.engine.value;
  const isPocket = v === "pocket";
  const isElevenLabs = v === "elevenlabs";
  els.pocketRow.hidden = !isPocket;
  els.pocketVoiceRow.hidden = !isPocket;
  els.elevenLabsRow.hidden = !isElevenLabs;
  els.browserVoiceRow.hidden = isPocket || isElevenLabs;
  // The position slider needs a per-chunk buffer to be useful, which
  // only Pocket and ElevenLabs produce. Browser TTS has no buffer, so
  // the slider is disabled and shows "—".
  setAudioSliderDisabled(v === "browser");
  if (v === "browser") resetAudioPosUI();
}

// ----- ElevenLabs health probe (server has the key; we just check the route) -----
els.elevenLabsStatus.addEventListener("click", async () => {
  setStatus("Checking ElevenLabs \u2026", "busy");
  try {
    // Send a tiny text snippet; if the server returns audio, the key works.
    const r = await fetch("/api/tts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "ok",
        voice_id: els.elevenLabsVoice.value.trim() || undefined,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    // Drain the body so the connection closes cleanly
    await r.arrayBuffer();
    setStatus("ElevenLabs OK", "ok");
  } catch (e) {
    setStatus(`ElevenLabs unreachable: ${e.message}`, "err");
  }
});

els.engine.addEventListener("change", () => {
  applyEngineVisibility();
  if (state.isPlaying || state.isPaused) {
    const restartFromPage = state.currentPage;
    stopInternal().then(() => {
      setCurrentPage(restartFromPage);
      playFromCurrent();
    });
  }
});

els.speed.addEventListener("input", () => {
  els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}\u00d7`;
  if (state.isPlaying) {
    if (els.engine.value === "browser") {
      const restartFromPage = state.currentPage;
      const remaining = state.browserQueue.slice(state.browserIndex);
      stopInternal().then(() => {
        state.browserQueue = remaining;
        state.browserIndex = 0;
        setCurrentPage(restartFromPage);
        playFromCurrent();
      });
    } else if (pocketSource) {
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

// ----- pocket-tts health -----
els.pocketHealth.addEventListener("click", async () => {
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set a Pocket TTS URL first.", "err");
    return;
  }
  setStatus(`Checking ${base}/health \u2026`, "busy");
  try {
    const r = await fetch(`${base}/health`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    setStatus(`Pocket TTS OK: ${j.status ?? "healthy"}`, "ok");
  } catch (e) {
    setStatus(`Pocket TTS unreachable: ${e.message}`, "err");
  }
});

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
    setCurrentPage(restartFromPage);
    playFromCurrent();
  });
});
els.next.addEventListener("click", () => {
  if (!state.pdfDoc) return;
  const restartFromPage = Math.min(state.pdfDoc.numPages, state.currentPage + 1);
  stopInternal().then(() => {
    setCurrentPage(restartFromPage);
    playFromCurrent();
  });
});
els.pageJump.addEventListener("change", () => {
  if (!state.pdfDoc) return;
  const n = Math.max(1, Math.min(state.pdfDoc.numPages, Number(els.pageJump.value) || 1));
  stopInternal().then(() => {
    setCurrentPage(n);
    playFromCurrent();
  });
});

function findNextPageWithText(startPage) {
  for (let i = startPage; i <= state.pdfDoc.numPages; i++) {
    if ((state.pagesText[i - 1] || "").trim().length > 0) return i;
  }
  return -1;
}

function playFromCurrent() {
  if (!state.pdfDoc) return;
  if (!(state.pagesText[state.currentPage - 1] || "").trim()) {
    const next = findNextPageWithText(state.currentPage);
    if (next > 0) {
      setCurrentPage(next);
      setStatus(`Skipping to page ${next} \u2014 the current page has no extractable text.`);
    }
  }
  // Start the position ticker before dispatching to the engine — it
  // covers both the active engine and the browser-engine disabled state
  // (no-op for browser since applyEngineVisibility disabled the slider).
  startPosTicker();
  if (els.engine.value === "browser") playBrowserFromCurrent();
  else if (els.engine.value === "elevenlabs") playElevenLabsFromCurrent();
  else playPocketFromCurrent();
}

function pauseInternal() {
  if (!state.isPlaying) return;
  if (els.engine.value === "browser") {
    window.speechSynthesis.pause();
  } else if (audioCtx && audioCtx.state === "running") {
    // Set the suspension guard BEFORE suspend() so any source.onended that
    // fires synchronously during suspension bails out instead of advancing
    // to the next chunk. Cleared in resumeInternal() once resume() resolves.
    state.audioCtxSuspended = true;
    try { audioCtx.suspend(); } catch (_) {}
  }
  state.isPaused = true;
  state.isPlaying = false;
  els.play.disabled = false;
  els.pause.disabled = true;
  syncPlayButton();
}

function resumeInternal() {
  if (!state.isPaused) return;
  if (els.engine.value === "browser") {
    window.speechSynthesis.resume();
    state.isPaused = false;
    state.isPlaying = true;
    els.play.disabled = true;
    els.pause.disabled = false;
    syncPlayButton();
  } else if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().then(() => {
      // Clear the guard only after the context is actually running again,
      // so a synthetic onended fired during the resume call can't slip past
      // it either.
      state.audioCtxSuspended = false;
      state.isPaused = false;
      state.isPlaying = true;
      els.play.disabled = true;
      els.pause.disabled = false;
      syncPlayButton();
    }).catch((e) => {
      state.audioCtxSuspended = false;
      setStatus(`Audio resume error: ${e.message}`, "err");
      stopInternal();
    });
  } else {
    // audioCtx is already running (e.g. user clicked Resume twice) — clear
    // the guard so future onended handlers advance correctly.
    state.audioCtxSuspended = false;
  }
}

async function stopInternal() {
  if (els.engine.value === "browser") {
    window.speechSynthesis.cancel();
    state.browserQueue = [];
    state.browserIndex = 0;
  } else {
    // Both pocket and elevenlabs share the WebAudio pipeline
    state.abortPocket = true;
    state.abortElevenLabs = true;
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
    state.elevenLabsQueue = [];
    state.elevenLabsIndex = 0;
    state.elevenLabsBuffers = [];
  }
  state.audioCtxSuspended = false;
  state.isPlaying = false;
  state.isPaused = false;
  els.play.disabled = !state.pdfDoc;
  els.pause.disabled = true;
  syncPlayButton();
  stopPosTicker();
  resetAudioPosUI();
}

function playBrowserFromCurrent() {
  if (!("speechSynthesis" in window)) {
    setStatus("This browser does not support SpeechSynthesis.", "err");
    return;
  }
  if (!(state.pagesText[state.currentPage - 1] || "").trim()) {
    const next = findNextPageWithText(state.currentPage);
    if (next > 0) {
      setCurrentPage(next);
      setStatus(`Skipping to page ${next} \u2014 the current page has no extractable text.`);
    } else {
      setStatus("No pages with extractable text.", "err");
      return;
    }
  }
  const text = state.pagesText[state.currentPage - 1] || "";
  state.browserQueue = chunkText(text, MAX_CHARS_BROWSER);
  state.browserIndex = 0;
  if (state.browserQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} (browser TTS) \u2026`, "busy");
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();
  speakNextBrowserChunk();
}

function speakNextBrowserChunk() {
  if (!state.isPlaying || state.isPaused) return;
  if (state.browserIndex >= state.browserQueue.length) {
    if (state.pdfDoc && state.currentPage < state.pdfDoc.numPages) {
      setCurrentPage(state.currentPage + 1);
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

function playPocketFromCurrent() {
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set a Pocket TTS URL first.", "err");
    return;
  }
  if (!(state.pagesText[state.currentPage - 1] || "").trim()) {
    const next = findNextPageWithText(state.currentPage);
    if (next > 0) {
      setCurrentPage(next);
      setStatus(`Skipping to page ${next} \u2014 the current page has no extractable text.`);
    } else {
      setStatus("No pages with extractable text.", "err");
      return;
    }
  }
  const text = state.pagesText[state.currentPage - 1] || "";
  state.pocketQueue = chunkText(text, MAX_CHARS_POCKET);
  state.pocketIndex = 0;
  state.abortPocket = false;
  state.pocketPlayToken = (state.pocketPlayToken || 0) + 1;
  state.pocketBuffers = new Array(state.pocketQueue.length).fill(null);
  state.pocketBase = base;
  if (state.pocketQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} via Pocket TTS \u2026`, "busy");
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();
  try { getAudioCtx().resume(); } catch (_) {}
  const myToken = state.pocketPlayToken;
  fetchAndDecodeChunk(0)
    .then(() => {
      if (state.abortPocket) return;
      if (state.pocketPlayToken !== myToken) return;
      playNextPocketChunk();
    })
    .catch(() => {});
}

async function fetchAndDecodeChunk(index) {
  const myToken = state.pocketPlayToken;
  if (state.abortPocket) return;
  if (state.pocketBuffers[index]) return state.pocketBuffers[index];
  const chunk = state.pocketQueue[index];
  const voice = els.pocketVoice.value.trim() || undefined;
  const form = new FormData();
  form.append("text", chunk);
  if (voice) form.append("voice_url", voice);
  try {
    const r = await fetch(`${state.pocketBase}/tts`, { method: "POST", body: form });
    if (state.abortPocket || state.pocketPlayToken !== myToken) return;
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${body || r.statusText}`);
    }
    const arrayBuffer = await r.arrayBuffer();
    if (state.abortPocket || state.pocketPlayToken !== myToken) return;
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch (_) {}
    }
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (state.abortPocket || state.pocketPlayToken !== myToken) return;
    state.pocketBuffers[index] = buffer;
    return buffer;
  } catch (e) {
    if (!state.abortPocket && state.pocketPlayToken === myToken) {
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
      setCurrentPage(state.currentPage + 1);
      playPocketFromCurrent();
    } else {
      setStatus("Reached the end of the document.", "ok");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
      syncPlayButton();
    }
    return;
  }
  const buffer = state.pocketBuffers[state.pocketIndex];
  if (buffer) {
    playDecodedChunk(buffer);
    const nextIdx = state.pocketIndex + 1;
    if (nextIdx < state.pocketQueue.length && !state.pocketBuffers[nextIdx]) {
      fetchAndDecodeChunk(nextIdx).catch(() => {});
    }
  } else {
    setStatus(
      `Pocket TTS: loading chunk ${state.pocketIndex + 1}/${state.pocketQueue.length} on page ${state.currentPage} \u2026`,
      "busy"
    );
    const myToken = state.pocketPlayToken;
    fetchAndDecodeChunk(state.pocketIndex)
      .then((buf) => {
        if (state.abortPocket) return;
        if (state.pocketPlayToken !== myToken) return;
        if (!buf) return;
        playDecodedChunk(buf);
        const nextIdx = state.pocketIndex + 1;
        if (nextIdx < state.pocketQueue.length && !state.pocketBuffers[nextIdx]) {
          fetchAndDecodeChunk(nextIdx).catch(() => {});
        }
      })
      .catch(() => {});
  }
}

function playDecodedChunk(buffer) {
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Number(els.speed.value) || 1.0;
  source.connect(ctx.destination);
  pocketSource = source;
  // Stash the audioCtx timestamp at start so the position ticker can
  // compute elapsed time within this chunk (accounting for current speed).
  source._startCtxTime = ctx.currentTime;
  source.onended = () => {
    if (pocketSource !== source) return;
    pocketSource = null;
    if (state.abortPocket) return;
    // Chrome fires source.onended synchronously when audioCtx.suspend() runs;
    // without this guard the chunk index would advance during pause, and
    // the next resume would play the FOLLOWING chunk from offset 0 instead
    // of resuming the paused one.
    if (state.audioCtxSuspended) return;
    state.pocketIndex += 1;
    playNextPocketChunk();
  };
  source.start(0);
  setStatus(
    `Pocket TTS: chunk ${state.pocketIndex + 1}/${state.pocketQueue.length} on page ${state.currentPage} \u2026`,
    "busy"
  );
}

// ----- ElevenLabs playback (server-proxied; same WebAudio pipeline as pocket) -----
function playElevenLabsFromCurrent() {
  if (!(state.pagesText[state.currentPage - 1] || "").trim()) {
    const next = findNextPageWithText(state.currentPage);
    if (next > 0) {
      setCurrentPage(next);
      setStatus(`Skipping to page ${next} \u2014 the current page has no extractable text.`);
    } else {
      setStatus("No pages with extractable text.", "err");
      return;
    }
  }
  const text = state.pagesText[state.currentPage - 1] || "";
  state.elevenLabsQueue = chunkText(text, MAX_CHARS_ELEVENLABS);
  state.elevenLabsIndex = 0;
  state.abortElevenLabs = false;
  state.elevenLabsPlayToken = (state.elevenLabsPlayToken || 0) + 1;
  state.elevenLabsBuffers = new Array(state.elevenLabsQueue.length).fill(null);
  if (state.elevenLabsQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} via ElevenLabs \u2026`, "busy");
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();
  try { getAudioCtx().resume(); } catch (_) {}
  const myToken = state.elevenLabsPlayToken;
  fetchAndDecodeElevenLabsChunk(0)
    .then(() => {
      if (state.abortElevenLabs) return;
      if (state.elevenLabsPlayToken !== myToken) return;
      playNextElevenLabsChunk();
    })
    .catch(() => {});
}

async function fetchAndDecodeElevenLabsChunk(index) {
  const myToken = state.elevenLabsPlayToken;
  if (state.abortElevenLabs) return;
  if (state.elevenLabsBuffers[index]) return state.elevenLabsBuffers[index];
  const chunk = state.elevenLabsQueue[index];
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: chunk,
        voice_id: els.elevenLabsVoice.value.trim() || undefined,
      }),
    });
    if (state.abortElevenLabs || state.elevenLabsPlayToken !== myToken) return;
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const arrayBuffer = await r.arrayBuffer();
    if (state.abortElevenLabs || state.elevenLabsPlayToken !== myToken) return;
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch (_) {}
    }
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (state.abortElevenLabs || state.elevenLabsPlayToken !== myToken) return;
    state.elevenLabsBuffers[index] = buffer;
    return buffer;
  } catch (e) {
    if (!state.abortElevenLabs && state.elevenLabsPlayToken === myToken) {
      setStatus(`ElevenLabs request failed: ${e.message}`, "err");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
    }
    throw e;
  }
}

function playNextElevenLabsChunk() {
  if (state.abortElevenLabs) return;
  if (state.elevenLabsIndex >= state.elevenLabsQueue.length) {
    if (state.pdfDoc && state.currentPage < state.pdfDoc.numPages) {
      setCurrentPage(state.currentPage + 1);
      playElevenLabsFromCurrent();
    } else {
      setStatus("Reached the end of the document.", "ok");
      state.isPlaying = false;
      els.play.disabled = !state.pdfDoc;
      els.pause.disabled = true;
      syncPlayButton();
    }
    return;
  }
  const buffer = state.elevenLabsBuffers[state.elevenLabsIndex];
  if (buffer) {
    playElevenLabsDecodedChunk(buffer);
    const nextIdx = state.elevenLabsIndex + 1;
    if (nextIdx < state.elevenLabsQueue.length && !state.elevenLabsBuffers[nextIdx]) {
      fetchAndDecodeElevenLabsChunk(nextIdx).catch(() => {});
    }
  } else {
    setStatus(
      `ElevenLabs: loading chunk ${state.elevenLabsIndex + 1}/${state.elevenLabsQueue.length} on page ${state.currentPage} \u2026`,
      "busy"
    );
    const myToken = state.elevenLabsPlayToken;
    fetchAndDecodeElevenLabsChunk(state.elevenLabsIndex)
      .then((buf) => {
        if (state.abortElevenLabs) return;
        if (state.elevenLabsPlayToken !== myToken) return;
        if (!buf) return;
        playElevenLabsDecodedChunk(buf);
        const nextIdx = state.elevenLabsIndex + 1;
        if (nextIdx < state.elevenLabsQueue.length && !state.elevenLabsBuffers[nextIdx]) {
          fetchAndDecodeElevenLabsChunk(nextIdx).catch(() => {});
        }
      })
      .catch(() => {});
  }
}

function playElevenLabsDecodedChunk(buffer) {
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Number(els.speed.value) || 1.0;
  source.connect(ctx.destination);
  pocketSource = source; // shared with pocket - we only ever have one playback pipeline live
  source._startCtxTime = ctx.currentTime;
  source.onended = () => {
    if (pocketSource !== source) return;
    pocketSource = null;
    if (state.abortElevenLabs) return;
    if (state.audioCtxSuspended) return;
    state.elevenLabsIndex += 1;
    playNextElevenLabsChunk();
  };
  source.start(0);
  setStatus(
    `ElevenLabs: chunk ${state.elevenLabsIndex + 1}/${state.elevenLabsQueue.length} on page ${state.currentPage} \u2026`,
    "busy"
  );
}

// ----- position slider (seek within current page) -----
//
// Timeline model: each page is split into N chunks; the slider's
// min..max maps to 0..N. The current chunk + a fractional offset
// within the chunk drive the slider's value, advanced by a single
// requestAnimationFrame ticker so the knob moves smoothly while audio
// plays. Seeking by dragging the slider snaps to a chunk index and
// jumps there via jumpToChunk().
//
// Browser TTS has no buffer per chunk, so the slider is disabled for
// that engine (we'd need to estimate per-utterance timing to make it
// work).

let posTickerRaf = null;

function currentChunkQueue() {
  return els.engine.value === "elevenlabs" ? state.elevenLabsQueue : state.pocketQueue;
}
function currentChunkBuffers() {
  return els.engine.value === "elevenlabs" ? state.elevenLabsBuffers : state.pocketBuffers;
}
function currentChunkIndex() {
  return els.engine.value === "elevenlabs" ? state.elevenLabsIndex : state.pocketIndex;
}

function setAudioSliderDisabled(disabled) {
  if (!els.audioPos) return;
  els.audioPos.disabled = disabled;
}

function resetAudioPosUI() {
  if (!els.audioPos) return;
  els.audioPos.value = "0";
  els.audioPos.max = "1";
  if (els.audioPosLabel) {
    els.audioPosLabel.textContent = "—";
  }
}

function refreshAudioPosUI() {
  if (!els.audioPos) return;
  const queue = currentChunkQueue();
  const idx = currentChunkIndex();
  els.audioPos.max = String(Math.max(1, queue.length));
  if (!state.isDraggingSlider) {
    els.audioPos.value = String(Math.min(Number(els.audioPos.max), idx));
  }
  const totalPages = state.pdfDoc ? state.pdfDoc.numPages : 0;
  if (els.audioPosLabel) {
    if (queue.length === 0 || totalPages === 0) {
      els.audioPosLabel.textContent = "—";
    } else {
      els.audioPosLabel.textContent =
        `Chunk ${Math.min(idx + 1, queue.length)}/${queue.length} \u00b7 Page ${state.currentPage}/${totalPages}`;
    }
  }
}

function startPosTicker() {
  cancelAnimationFrame(posTickerRaf);
  const tick = () => {
    const engine = els.engine.value;
    if (engine !== "browser" && pocketSource && state.isPlaying && !state.isPaused) {
      const ctx = getAudioCtx();
      const buffer = pocketSource.buffer;
      const queue = currentChunkQueue();
      const idx = currentChunkIndex();
      const speed = Number(els.speed.value) || 1.0;
      const startCtxTime = pocketSource._startCtxTime ?? ctx.currentTime;
      const elapsed = Math.max(0, (ctx.currentTime - startCtxTime) * speed);
      const frac = buffer ? Math.min(1, elapsed / Math.max(0.001, buffer.duration)) : 0;
      const max = Math.max(1, queue.length);
      els.audioPos.max = String(max);
      if (!state.isDraggingSlider) {
        els.audioPos.value = String(Math.min(max, idx + frac));
      }
      const totalPages = state.pdfDoc ? state.pdfDoc.numPages : 0;
      if (els.audioPosLabel) {
        els.audioPosLabel.textContent =
          `Chunk ${Math.min(idx + 1, queue.length)}/${queue.length} \u00b7 Page ${state.currentPage}/${totalPages}`;
      }
    } else if (engine !== "browser") {
      // paused / stopped but a queue exists — keep the label fresh even if
      // the value doesn't move
      refreshAudioPosUI();
    }
    posTickerRaf = requestAnimationFrame(tick);
  };
  posTickerRaf = requestAnimationFrame(tick);
}

function stopPosTicker() {
  cancelAnimationFrame(posTickerRaf);
  posTickerRaf = null;
}

// Jump the active engine to chunk index `targetIdx` of the current page.
// Cancels the active source, rewinds the queue index, and either replays
// the cached buffer or kicks off a fresh fetch+decode.
async function jumpToChunk(targetIdx) {
  const engine = els.engine.value;
  if (engine === "browser") return;
  const queue = currentChunkQueue();
  const buffers = currentChunkBuffers();
  if (queue.length === 0) return;
  const clamped = Math.max(0, Math.min(queue.length - 1, targetIdx));

  // Stop whatever is playing right now. The onended handler will fire but
  // is a no-op because pocketSource will no longer match (we nulled it).
  if (pocketSource) {
    try { pocketSource.stop(); } catch (_) {}
    pocketSource = null;
  }

  // Bump the playback token so any in-flight fetch for the old chunk is
  // discarded by its own myToken guard.
  if (engine === "elevenlabs") {
    state.elevenLabsPlayToken = (state.elevenLabsPlayToken || 0) + 1;
    state.elevenLabsIndex = clamped;
  } else {
    state.pocketPlayToken = (state.pocketPlayToken || 0) + 1;
    state.pocketIndex = clamped;
  }

  // We're continuing playback, not starting over.
  state.isPlaying = true;
  state.isPaused = false;
  state.audioCtxSuspended = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();

  try { await getAudioCtx().resume(); } catch (_) {}

  const buffer = buffers[clamped];
  if (buffer) {
    if (engine === "elevenlabs") playElevenLabsDecodedChunk(buffer);
    else playDecodedChunk(buffer);
  } else {
    setStatus(
      `Loading chunk ${clamped + 1}/${queue.length} on page ${state.currentPage} \u2026`,
      "busy"
    );
    if (engine === "elevenlabs") {
      fetchAndDecodeElevenLabsChunk(clamped).then((b) => {
        if (!b) return;
        // Only play if we are still on this chunk (user didn't jump again).
        if (state.elevenLabsIndex !== clamped) return;
        playElevenLabsDecodedChunk(b);
      }).catch(() => {});
    } else {
      fetchAndDecodeChunk(clamped).then((b) => {
        if (!b) return;
        if (state.pocketIndex !== clamped) return;
        playDecodedChunk(b);
      }).catch(() => {});
    }
  }
}

// ----- slider event wiring -----
if (els.audioPos) {
  // While the user is dragging, suppress the position ticker so it
  // doesn't fight the user's pointer; release the suppression on mouseup
  // (and also fire the seek then).
  const onDragStart = () => { state.isDraggingSlider = true; };
  const onDragEnd = () => {
    state.isDraggingSlider = false;
    if (!state.pdfDoc) return;
    if (els.engine.value === "browser") return;
    if (!state.isPlaying && !state.isPaused) return;
    const target = Math.floor(Number(els.audioPos.value));
    jumpToChunk(target);
  };
  els.audioPos.addEventListener("mousedown", onDragStart);
  els.audioPos.addEventListener("touchstart", onDragStart, { passive: true });
  els.audioPos.addEventListener("mouseup", onDragEnd);
  els.audioPos.addEventListener("touchend", onDragEnd);
  els.audioPos.addEventListener("blur", () => { state.isDraggingSlider = false; });
  // Keyboard arrow keys on the slider: change fires per arrow press.
  els.audioPos.addEventListener("change", () => {
    state.isDraggingSlider = false;
    if (!state.pdfDoc) return;
    if (els.engine.value === "browser") return;
    if (!state.isPlaying && !state.isPaused) return;
    const target = Math.floor(Number(els.audioPos.value));
    jumpToChunk(target);
  });
}

// ----- initial UI state -----
applyEngineVisibility();
els.speedLabel.textContent = `${Number(els.speed.value).toFixed(2)}\u00d7`;
syncPlayButton();
setAuthMode("login");

// Kick off session check
init();
