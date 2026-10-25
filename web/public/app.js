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
//   4. "Library" returns to the grid and keeps the book playing (mini
//      player); opening another book replaces it; "Sign out" clears all
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
  togglePassword: $("togglePassword"),
  togglePasswordIcon: $("togglePasswordIcon"),
  authError: $("authError"),
  authSubmit: $("authSubmit"),
  authSubmitLabel: $("authSubmitLabel"),

  // Library screen
  libraryGreeting: $("libraryGreeting"),
  libraryEyebrow: $("libraryEyebrow"),
  uploadPickBtn: $("uploadPickBtn"),
  filePicker: $("filePicker"),
  drop: $("drop"),
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
  back30: $("back30"),
  fwd30: $("fwd30"),
  sleepTimer: $("sleepTimer"),
  sleepLabel: $("sleepLabel"),
  audioPos: $("audioPos"),
  audioPosLabel: $("audioPosLabel"),
  nowReading: $("now-reading"),
  nrTitle: $("nrTitle"),
  pageJump: $("pageJump"),
  pageCount: $("pageCount"),
  pagePrint: $("pagePrint"),
  textOut: $("textOut"),

  // Redesign: library extras, player extras, mini player, dialogs
  accountName: $("accountName"),
  themeToggle: $("themeToggle"),
  brandHome: $("brandHome"),
  tabMine: $("tabMine"),
  librarySearch: $("librarySearch"),
  librarySort: $("librarySort"),
  librarySearchEmpty: $("librarySearchEmpty"),
  continueCard: $("continueCard"),
  continueCover: $("continueCover"),
  continueTitle: $("continueTitle"),
  continueMeta: $("continueMeta"),
  continueBar: $("continueBar"),
  continueBtn: $("continueBtn"),
  dropOverlay: $("dropOverlay"),
  playerCover: $("playerCover"),
  playerBookTitle: $("playerBookTitle"),
  pageUnit: $("pageUnit"),
  timeLeft: $("timeLeft"),
  bookBar: $("bookBar"),
  speedChip: $("speedChip"),
  sleepChipLabel: $("sleepChipLabel"),
  bookmarkBtn: $("bookmarkBtn"),
  voiceBtn: $("voiceBtn"),
  voiceBtnLabel: $("voiceBtnLabel"),
  voiceDialog: $("voiceDialog"),
  readAlong: $("readAlong"),
  chaptersPanel: $("chaptersPanel"),
  chaptersList: $("chaptersList"),
  chaptersTabLabel: $("chaptersTabLabel"),
  bookmarksPanel: $("bookmarksPanel"),
  bookmarksList: $("bookmarksList"),
  bookmarksEmpty: $("bookmarksEmpty"),
  bookmarkCount: $("bookmarkCount"),
  miniPlayer: $("miniPlayer"),
  miniOpen: $("miniOpen"),
  miniCover: $("miniCover"),
  miniTitle: $("miniTitle"),
  miniSub: $("miniSub"),
  miniToggle: $("miniToggle"),
  miniToggleIcon: $("miniToggleIcon"),
  miniBar: $("miniBar"),
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
  // Reading progress. lastCharOffset is where the most recently started
  // chunk begins in the current page (see chunkStartOffsets). resumeAt is
  // a pending {page, offset} that the next play on that page starts from.
  // progressReady stays false until the saved position has been restored,
  // so loading a book can't overwrite it with page 1.
  lastCharOffset: 0,
  resumeAt: null,
  progressReady: false,
  // Redesign
  currentBook: null,             // the library row of the loaded book (for covers, mini player)
  bookmarks: [],                 // [{id,page,char_offset,note,created_at}] for the loaded book
  autoPlayOnOpen: false,         // "Resume" on the library: start playing once loaded
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

// #status is a toast: it shows each message for a few seconds (errors
// longer) and stays readable as text for tests and screen readers.
let toastTimer = null;
// kind "quiet" updates the text without popping the toast (the player
// already shows what is playing).
function setStatus(msg, kind = "") {
  const quiet = kind === "quiet";
  els.status.textContent = msg;
  els.status.dataset.state = quiet ? "busy" : kind || "idle";
  clearTimeout(toastTimer);
  els.status.classList.toggle("toast-show", Boolean(msg) && !quiet);
  const ms = kind === "err" ? 8000 : kind === "busy" ? 2500 : 3500;
  toastTimer = setTimeout(() => els.status.classList.remove("toast-show"), ms);
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
  els.accountName.hidden = els.logoutBtn.hidden;
  els.accountName.textContent = state.user ? state.user.username : "";
  syncMiniPlayer();
  window.scrollTo(0, 0);
}

// The player shows the book's title; the line under it names the EPUB
// chapter when there is one.
function setNowReadingTitle(title) {
  const book = state.bookTitle || title || "";
  els.playerBookTitle.textContent = book;
  els.nrTitle.textContent = title && title !== book ? title : "";
  if (state.currentBook || book) renderPlayerCover();
}

// Play and Pause share one spot: whichever applies is shown.
function syncPlayButton() {
  const playing = state.isPlaying && !state.isPaused;
  if (els.playLabel) els.playLabel.textContent = state.isPaused ? "Resume" : "Play";
  els.play.setAttribute("aria-label", state.isPaused ? "Resume" : "Play");
  els.play.hidden = playing;
  els.pause.hidden = !playing;
  syncMiniPlayer();
}

// ----- Init: check session and route -----
async function init() {
  setStatus("Checking session…", "quiet");
  try {
    const me = await api("/api/me");
    if (me.user) {
      state.user = me.user;
      await loadLibrary();
      showScreen("library");
      setStatus(`Signed in as ${me.user.username}`, "quiet");
    } else {
      state.user = null;
      showScreen("auth");
      setStatus("Sign in to start", "quiet");
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

// Show/hide the password so it can be checked while typing. It goes back
// to hidden after signing in or out, so it isn't left showing.
function setPasswordVisible(show) {
  els.authPassword.type = show ? "text" : "password";
  els.togglePassword.setAttribute("aria-pressed", String(show));
  els.togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  els.togglePasswordIcon.setAttribute("href", show ? "#i-eye-off" : "#i-eye");
}
els.togglePassword.addEventListener("click", () => {
  setPasswordVisible(els.authPassword.type === "password");
  els.authPassword.focus();
});

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
    setPasswordVisible(false);
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
  await unloadBook();
  state.user = null;
  state.books = [];
  showScreen("auth");
  setStatus("Signed out");
  els.authUsername.value = "";
  els.authPassword.value = "";
  setPasswordVisible(false);
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
    const h = new Date().getHours();
    const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    els.libraryGreeting.textContent = `${part}, ${state.user.username}`;
    const n = state.books.length;
    els.libraryEyebrow.textContent = n === 0 ? "Library" : `${n} book${n === 1 ? "" : "s"} on your shelf`;
  }
  renderContinueCard();
  els.drop.classList.toggle("drop-big", state.books.length === 0);
  const shown = filteredSortedBooks();
  els.librarySearchEmpty.hidden = !(state.books.length && shown.length === 0);
  if (state.books.length === 0) return;
  for (const b of shown) {
    const li = document.createElement("li");
    li.className = "book-card" + (b.id === state.currentBookId ? " book-card-playing" : "");
    li.dataset.id = String(b.id);
    const isPublic = b.visibility === "public";
    const pct = bookPercent(b);
    li.innerHTML = `
      <button class="book-card-open" data-id="${b.id}" aria-label="Open ${escapeHtml(b.title)}">
        ${coverHtml(b)}
        <div class="book-card-body">
          <h3 class="book-card-title">${escapeHtml(b.title)}</h3>
          ${b.author ? `<p class="book-card-author">${escapeHtml(b.author)}</p>` : ""}
          <p class="book-card-meta">${bookMetaHtml(b)}</p>
          ${pct != null ? `<div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ""}
        </div>
      </button>
      <div class="book-card-actions">
        <button class="book-card-share" data-id="${b.id}" aria-pressed="${isPublic}" aria-label="${isPublic ? "Make private" : "Share in the public library"}" title="${isPublic ? "Public: anyone signed in can listen. Tap to make private." : "Private: only you. Tap to share it in the public library."}">
          <svg width="14" height="14" aria-hidden="true"><use href="#${isPublic ? "i-globe" : "i-lock"}"/></svg>
          <span class="book-card-share-label">Public</span>
        </button>
        <button class="book-card-del" data-id="${b.id}" aria-label="Remove ${escapeHtml(b.title)}" title="Remove from library">
          <svg width="14" height="14" aria-hidden="true"><use href="#i-trash"/></svg>
        </button>
      </div>
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
      const ok = confirm(`Remove "${book.title}" from your library? The file will be deleted.`);
      if (!ok) return;
      try {
        if (id === state.currentBookId) await unloadBook();
        await api(`/api/books/${id}`, { method: "DELETE" });
        forgetThumb(id);
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
    const book = await uploadBook(file);
    setStatus(`Saved "${book.title}"`, "ok");
    // Insert at top of list and open it
    state.books = [book, ...state.books.filter((b) => b.id !== book.id)];
    if (state.screen === "library") renderLibrary();
    await openBookFromLibrary(book.id);
  } catch (e) {
    setStatus(`Upload failed: ${e.message}`, "err");
  }
}

// The server says where the file goes: through it (local storage), or
// straight to Supabase Storage, after which we tell it the upload is done.
async function uploadBook(file) {
  const target = await api("/api/books/uploads", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, size: file.size }),
  });
  if (target.mode === "local") {
    const form = new FormData();
    form.append("file", file);
    const { book } = await api("/api/books", { method: "POST", body: form });
    return book;
  }
  const isEpub = file.name.toLowerCase().endsWith(".epub");
  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      ...target.headers,
      "Content-Type": file.type || (isEpub ? "application/epub+zip" : "application/pdf"),
    },
    body: file,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || j.error || `storage HTTP ${res.status}`);
  }
  const { book } = await api("/api/books/uploads/complete", {
    method: "POST",
    body: JSON.stringify({ objectPath: target.objectPath }),
  });
  return book;
}

async function fetchBookBlob(id) {
  const where = await api(`/api/books/${id}/download`);
  const sameOrigin = where.url.startsWith("/");
  const res = await fetch(where.url, {
    headers: where.headers || {},
    credentials: sameOrigin ? "same-origin" : "omit",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function openBookFromLibrary(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) {
    setStatus("Book not found in library", "err");
    return;
  }
  if (state.currentBookId === id && state.pdfDoc) {
    showScreen("reader");
    maybeAutoPlay();
    return;
  }
  await unloadBook();
  setStatus(`Opening "${book.title}"…`, "busy");
  try {
    state.currentBookId = id;
    state.currentBook = book;
    state.progressReady = false;
    showScreen("reader");
    prepareReaderFor(book);
    const blob = await fetchBookBlob(id);
    const file = new File([blob], `${book.title}.${book.kind}`, { type: blob.type });
    // Update last_opened_at locally so the library shows it as recent
    book.last_opened_at = Date.now();
    applyEngineVisibility();
    syncPlayButton();
    await loadDocument(file);
    await restoreProgress(id);
    loadBookmarks(id);
    maybeAutoPlay();
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
    li.innerHTML = `
      <button class="book-card-open" data-id="${b.id}" aria-label="Open ${escapeHtml(b.title)}">
        ${coverHtml(b)}
        <div class="book-card-body">
          <h3 class="book-card-title">${escapeHtml(b.title)}</h3>
          ${b.author ? `<p class="book-card-author">${escapeHtml(b.author)}</p>` : ""}
          <p class="book-card-meta">Shared by <span class="book-card-sharedby">${escapeHtml(b.shared_by || "")}</span></p>
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
  if (state.currentBookId === id && state.pdfDoc) {
    showScreen("reader");
    return;
  }
  await unloadBook();
  setStatus(`Opening "${book.title}"…`, "busy");
  try {
    state.currentBookId = id;
    state.currentBook = book;
    state.progressReady = false;
    showScreen("reader");
    prepareReaderFor(book);
    const blob = await fetchBookBlob(id);
    const file = new File([blob], `${book.title}.${book.kind}`, { type: blob.type });
    applyEngineVisibility();
    syncPlayButton();
    await loadDocument(file);
    await restoreProgress(id);
    loadBookmarks(id);
  } catch (e) {
    setStatus(`Could not open book: ${e.message}`, "err");
  }
}

if (els.browsePublicBtn) {
  els.browsePublicBtn.addEventListener("click", async () => {
    showScreen("public");
    await loadPublicLibrary();
  });
}
if (els.backFromPublic) {
  els.backFromPublic.addEventListener("click", async () => {
    showScreen("library");
  });
}

// Leaving the player keeps the book loaded (and playing); the mini player
// brings it back.
els.backToLibrary.addEventListener("click", async () => {
  saveProgressNow();
  showScreen("library");
  await loadLibrary();
});

// Stop and forget the loaded book (before opening another, deleting it,
// or signing out). stopInternal saves the position first.
async function unloadBook() {
  if (!state.pdfDoc && !state.currentBookId) return;
  if (state.isPlaying || state.isPaused) await stopInternal();
  else saveProgressNow();
  clearSleepTimer();
  state.progressReady = false;
  state.currentBookId = null;
  state.currentBook = null;
  state.pdfDoc = null;
  state.pagesText = [];
  state.bookTitle = "";
  state.chapterTitles = null;
  state.pagePrintNumbers = null;
  state.bookmarks = [];
  state.resumeAt = null;
  setNowReadingTitle("");
  els.textOut.textContent = "";
  els.play.disabled = els.prev.disabled = els.next.disabled = els.pageJump.disabled = true;
  els.bookmarkBtn.disabled = true;
  setCurrentPage(1);
  renderReadAlong(true);
  renderChapters();
  renderBookmarks();
  syncMiniPlayer();
}

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
    setStatus(`Ready to play \u00b7 ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`, "ok");
    els.textOut.textContent = state.pagesText.join("\n\n--- page break ---\n\n");
    bookLoaded();
    savePdfThumb(doc, state.currentBookId);
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
    setStatus(`Ready to play \u00b7 ${pages.length} chapter${pages.length === 1 ? "" : "s"}`, "ok");
    els.textOut.textContent = pages.map((p, i) => {
      const pn = pagePrintNumbers[i];
      const tag = pn ? `ch. ${i + 1} / p. ${pn}` : `ch. ${i + 1}`;
      return `--- ${tag} ---\n${p}`;
    }).join("\n\n");
    bookLoaded();
    saveEpubThumb(zip, opfDoc, opfDir, state.currentBookId);
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

// ----- reading progress -----
//
// A position is (page, char offset). The offset counts characters in the
// page's chunked text: chunk i starts at the summed length of chunks
// 0..i-1 plus one separator each. Every engine chunks the same sentence
// stream (only the max chunk size differs), so an offset saved while
// listening with one engine lands on the right sentence with another.

function chunkStartOffsets(queue) {
  const out = [];
  let pos = 0;
  for (const c of queue) {
    out.push(pos);
    pos += c.length + 1;
  }
  return out;
}

function chunkIndexForOffset(queue, offset) {
  const starts = chunkStartOffsets(queue);
  let idx = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) idx = i;
    else break;
  }
  return idx;
}

// Called right after an engine builds the queue for the current page.
// Returns the chunk index to start from and consumes any pending resume.
function takeResumeIndex(queue) {
  const r = state.resumeAt;
  state.resumeAt = null;
  if (!r || r.page !== state.currentPage || !r.offset) return 0;
  return chunkIndexForOffset(queue, r.offset);
}

// Called whenever a chunk starts playing.
function noteChunkStart(queue, idx) {
  state.lastCharOffset = chunkStartOffsets(queue)[idx] || 0;
  scheduleProgressSave();
}

function progressPayload() {
  return JSON.stringify({
    page: state.currentPage,
    char_offset: state.lastCharOffset,
    total_pages: state.pdfDoc ? state.pdfDoc.numPages : undefined,
  });
}

function canSaveProgress() {
  return Boolean(state.user && state.currentBookId && state.pdfDoc && state.progressReady);
}

let progressSaveTimer = null;
function scheduleProgressSave() {
  if (progressSaveTimer) return;
  progressSaveTimer = setTimeout(() => {
    progressSaveTimer = null;
    saveProgressNow();
  }, 3000);
}

async function saveProgressNow() {
  clearTimeout(progressSaveTimer);
  progressSaveTimer = null;
  if (!canSaveProgress()) return;
  try {
    await api(`/api/books/${state.currentBookId}/progress`, {
      method: "POST",
      body: progressPayload(),
    });
  } catch (e) {
    console.warn("Could not save reading position:", e.message);
  }
}

// Tab closing / app backgrounded on a phone: a normal fetch may be killed,
// so hand the save to the browser with sendBeacon.
function beaconProgress() {
  if (!canSaveProgress() || !navigator.sendBeacon) return;
  clearTimeout(progressSaveTimer);
  progressSaveTimer = null;
  navigator.sendBeacon(
    `/api/books/${state.currentBookId}/progress`,
    new Blob([progressPayload()], { type: "application/json" })
  );
}
window.addEventListener("pagehide", beaconProgress);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") beaconProgress();
});

async function restoreProgress(bookId) {
  if (!state.pdfDoc || state.currentBookId !== bookId) return;
  state.lastCharOffset = 0;
  state.resumeAt = null;
  try {
    const { progress } = await api(`/api/books/${bookId}/progress`);
    if (state.currentBookId !== bookId) return;
    if (progress && (progress.page > 1 || progress.char_offset > 0)) {
      const page = Math.max(1, Math.min(state.pdfDoc.numPages, progress.page));
      setCurrentPage(page);
      state.lastCharOffset = page === progress.page ? progress.char_offset : 0;
      state.resumeAt = { page, offset: state.lastCharOffset };
      const unit = state.pdfDoc._kind === "epub" ? "chapter" : "page";
      setStatus(`Picking up where you left off: ${unit} ${page}. Press Play to continue.`, "ok");
    }
  } catch (e) {
    console.warn("Could not load reading position:", e.message);
  } finally {
    if (state.currentBookId === bookId) state.progressReady = true;
    scheduleWarmPocket();
  }
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
  scheduleWarmPocket();
  onPageChanged();
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

els.pocketVoice.addEventListener("change", scheduleWarmPocket);
els.engine.addEventListener("change", () => {
  scheduleWarmPocket();
  applyEngineVisibility();
  if (state.isPlaying || state.isPaused) {
    const restartFromPage = state.currentPage;
    const restartOffset = state.lastCharOffset;
    stopInternal().then(() => {
      setCurrentPage(restartFromPage);
      state.resumeAt = { page: restartFromPage, offset: restartOffset };
      playFromCurrent();
    });
  }
});

els.speed.addEventListener("input", () => {
  syncSpeedChip();
  if (state.isPlaying) {
    if (els.engine.value === "browser") {
      const restartFromPage = state.currentPage;
      const restartOffset = state.lastCharOffset;
      stopInternal().then(() => {
        setCurrentPage(restartFromPage);
        state.resumeAt = { page: restartFromPage, offset: restartOffset };
        playFromCurrent();
      });
    } else if (els.engine.value === "pocket") {
      pocketSetRate(Number(els.speed.value) || 1.0);
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
    setStatus("Set the natural voice server under Voice, Advanced.", "err");
    return;
  }
  setStatus(`Checking ${base}/health \u2026`, "busy");
  try {
    const r = await fetch(`${base}/health`, { method: "GET" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    setStatus(`The natural voice server is working (${j.status ?? "healthy"})`, "ok");
  } catch (e) {
    setStatus(`Can't reach the natural voice server: ${e.message}`, "err");
  }
});

// ----- transport buttons -----
els.play.addEventListener("click", () => {
  if (!state.pdfDoc) return;
  if (els.engine.value !== "browser") setKeepAlive(true);
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
  updateMediaSession();
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
  setKeepAlive(false);
  updateMediaSession();
  saveProgressNow();
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
      updateMediaSession();
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
    stopPocketStream();
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
  setKeepAlive(false);
  updateMediaSession();
  scheduleWarmPocket();
  // Not awaited: the URL and payload are captured synchronously, and
  // prev/next shouldn't wait on the network before playing the next page.
  saveProgressNow();
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
  state.browserIndex = takeResumeIndex(state.browserQueue);
  if (state.browserQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} (browser TTS) \u2026`, "quiet");
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
      if (sleepTimer.mode === "page") {
        state.lastCharOffset = 0;
        stopInternal();
        clearSleepTimer("Sleep timer: stopped at the end of the page.");
        return;
      }
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
  noteChunkStart(state.browserQueue, state.browserIndex);
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

// ----- Pocket playback: one continuous, gapless stream -----
//
// The Pocket server answers one request at a time and makes speech about
// 1.5x faster than it plays (measured on the hosted server: ~34 ms of
// generation and ~51 ms of audio per character). Cutting each page into
// fixed 600-char chunks and fetching one ahead left a silence of ~12 s at
// every page turn and before the first sound. Instead:
//
//   - A producer walks the book sentence by sentence, across pages, and
//     keeps the server busy until POCKET_AHEAD_MAX_S of audio is queued.
//   - Each request is sized so it finishes well before the queued audio
//     runs out: at most 0.7 x (queued seconds) / (measured ms per char),
//     clamped to POCKET_MIN_CHARS..MAX_CHARS_POCKET. The first request is
//     small, so sound starts within a couple of seconds, and sizes grow
//     as the queue fills.
//   - The next buffer is scheduled to start at the exact end time of the
//     current one, so there is no gap between chunks.
//
// Positions use the same (page, char offset) model as the other engines:
// the offset into the page's sentences joined by single spaces.

const POCKET_MIN_CHARS = 60;
const POCKET_AHEAD_MAX_S = 150;
const POCKET_KEEP_BEHIND = 12; // played buffers kept for "back 30 s"

let pocketStream = null;

// Sentences of a page with their offsets. Sentences longer than
// MAX_CHARS_POCKET are pre-split on words, as chunkText() does.
function pageAtoms(page) {
  const atoms = [];
  let pos = 0;
  for (const piece of sentencePieces(state.pagesText[page - 1] || "")) {
    atoms.push({ text: piece, offset: pos });
    pos += piece.length + 1;
  }
  return atoms;
}

function sentencePieces(text) {
  const out = [];
  for (const p of text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    if (p.length <= MAX_CHARS_POCKET) { out.push(p); continue; }
    let wb = "";
    for (const w of p.split(/\s+/)) {
      if ((wb + " " + w).trim().length > MAX_CHARS_POCKET) {
        if (wb) out.push(wb);
        wb = w;
      } else {
        wb = (wb ? wb + " " : "") + w;
      }
    }
    if (wb) out.push(wb);
  }
  return out;
}

// Cut at most maxChars off the front of `text`, preferring a comma or
// semicolon, then a space. Returns the head; the caller keeps the rest.
function splitHead(text, maxChars) {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars + 1);
  const punct = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
  if (punct >= maxChars * 0.4) return text.slice(0, punct + 1);
  const space = window.lastIndexOf(" ");
  return space > 0 ? text.slice(0, space) : text.slice(0, maxChars);
}

function pocketRate() {
  return Number(els.speed.value) || 1.0;
}

// Seconds of audio queued from now: the rest of the current chunk plus
// every fetched chunk after it.
function pocketAheadSeconds(s) {
  let ahead = 0;
  const rate = pocketRate();
  if (s.cur) {
    const played = s.cur.offset + Math.max(0, getAudioCtx().currentTime - s.cur.startCtx) * s.cur.rate;
    ahead += Math.max(0, s.items[s.cur.idx].buffer.duration - played) / rate;
  }
  const from = s.cur ? s.cur.idx + 1 : s.playIdx;
  for (let i = from; i < s.items.length && s.items[i].buffer; i++) ahead += s.items[i].buffer.duration / rate;
  return ahead;
}

function setPocketPage(page) {
  if (state.currentPage !== page) setCurrentPage(page);
  state.pocketQueue = chunkText(state.pagesText[page - 1] || "", MAX_CHARS_POCKET);
}

// Start (or restart) the stream at a page and char offset.
function startPocketStream(page, offset) {
  stopPocketStream();
  const s = {
    token: (state.pocketPlayToken || 0) + 1,
    base: state.pocketBase,
    voice: els.pocketVoice.value.trim() || undefined,
    items: [],            // { page, offset, text, buffer }
    playIdx: 0,           // item to play next when nothing is playing
    cur: null,            // { idx, source, startCtx, offset, rate }
    next: null,           // { idx, source } scheduled to start when cur ends
    waiting: true,        // nothing playing; play items[playIdx] when it arrives
    prodPage: page,
    prodAtoms: pageAtoms(page),
    msPerChar: state.pocketMsPerChar || 40,
    done: false,          // producer reached the end of the book
    startOffset: offset,  // where playback will begin, for the slider
  };
  s.prodAtoms = atomsFrom(s.prodAtoms, offset);
  state.pocketPlayToken = s.token;
  state.abortPocket = false;
  pocketStream = s;
  setPocketPage(page);
  state.pocketIndex = chunkIndexForOffset(state.pocketQueue, offset);
  runPocketProducer(s);
}

// Drop the sentences before the one that holds `offset`.
function atomsFrom(atoms, offset) {
  let i = 0;
  while (i + 1 < atoms.length && atoms[i + 1].offset <= offset) i++;
  return atoms.slice(i);
}

// Warm start: while idle, fetch the audio for the first words Play would
// speak, so pressing Play sounds at once instead of after a round trip.
let pocketWarm = null; // { key, promise of ArrayBuffer }
let pocketWarmTimer = null;
const pocketWarmKey = (base, voice, text) => `${base}\n${voice || ""}\n${text}`;

function scheduleWarmPocket() {
  clearTimeout(pocketWarmTimer);
  pocketWarmTimer = setTimeout(warmPocketStart, 700);
}

function warmPocketStart() {
  if (els.engine.value !== "pocket" || state.isPlaying || !state.pdfDoc) return;
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) return;
  const page = state.currentPage;
  const r = state.resumeAt;
  const offset = r && r.page === page ? r.offset : 0;
  const item = nextPocketText({ prodPage: page, prodAtoms: atomsFrom(pageAtoms(page), offset) }, POCKET_MIN_CHARS);
  if (!item) return;
  const voice = els.pocketVoice.value.trim() || undefined;
  const key = pocketWarmKey(base, voice, item.text);
  if (pocketWarm && pocketWarm.key === key) return;
  const form = new FormData();
  form.append("text", item.text);
  if (voice) form.append("voice_url", voice);
  const promise = fetch(`${base}/tts`, { method: "POST", body: form })
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))));
  promise.catch(() => { if (pocketWarm && pocketWarm.key === key) pocketWarm = null; });
  pocketWarm = { key, promise };
}

function stopPocketStream() {
  const s = pocketStream;
  pocketStream = null;
  state.pocketPlayToken = (state.pocketPlayToken || 0) + 1;
  if (!s) return;
  for (const n of [s.cur, s.next]) {
    if (n && n.source) { try { n.source.stop(); } catch (_) {} }
  }
  pocketSource = null;
}

// Next chunk of text for the producer, crossing pages; null at the end.
function nextPocketText(s, maxChars) {
  while (s.prodAtoms.length === 0) {
    if (!state.pdfDoc || s.prodPage >= state.pdfDoc.numPages) return null;
    s.prodPage += 1;
    s.prodAtoms = pageAtoms(s.prodPage);
  }
  const first = s.prodAtoms[0];
  if (first.text.length > maxChars) {
    const head = splitHead(first.text, maxChars);
    const rest = first.text.slice(head.length).trim();
    s.prodAtoms[0] = { text: rest, offset: first.offset + head.length + 1 };
    if (!rest) s.prodAtoms.shift();
    return { page: s.prodPage, offset: first.offset, text: head };
  }
  let text = first.text;
  s.prodAtoms.shift();
  while (s.prodAtoms.length && text.length + 1 + s.prodAtoms[0].text.length <= maxChars) {
    text += " " + s.prodAtoms.shift().text;
  }
  return { page: s.prodPage, offset: first.offset, text };
}

async function runPocketProducer(s) {
  const alive = () => pocketStream === s && !state.abortPocket;
  while (alive()) {
    const ahead = pocketAheadSeconds(s);
    if (ahead > POCKET_AHEAD_MAX_S) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const budget = Math.floor((ahead * 1000 * 0.7) / Math.max(5, s.msPerChar));
    const item = nextPocketText(s, Math.max(POCKET_MIN_CHARS, Math.min(MAX_CHARS_POCKET, budget)));
    if (!item) { s.done = true; break; }
    const form = new FormData();
    form.append("text", item.text);
    if (s.voice) form.append("voice_url", s.voice);
    const warm = pocketWarm && pocketWarm.key === pocketWarmKey(s.base, s.voice, item.text) ? pocketWarm.promise : null;
    if (warm) pocketWarm = null;
    const t0 = performance.now();
    try {
      let arrayBuffer = warm ? await warm.catch(() => null) : null;
      if (!alive()) return;
      if (!arrayBuffer) {
        const r = await fetch(`${s.base}/tts`, { method: "POST", body: form });
        if (!alive()) return;
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}: ${body || r.statusText}`);
        }
        arrayBuffer = await r.arrayBuffer();
        if (!alive()) return;
        const msPerChar = (performance.now() - t0) / Math.max(1, item.text.length);
        s.msPerChar = state.pocketMsPerChar = s.msPerChar * 0.6 + msPerChar * 0.4;
      }
      item.buffer = await getAudioCtx().decodeAudioData(arrayBuffer);
      if (!alive()) return;
    } catch (e) {
      if (!alive()) return;
      setStatus(`The natural voice didn't answer (${e.message}). Try again, or choose "This device's voice" under Voice.`, "err");
      stopInternal();
      return;
    }
    s.items.push(item);
    if (s.waiting && s.playIdx === s.items.length - 1) playPocketItem(s, s.playIdx, 0);
    else schedulePocketNext(s);
  }
  // Producer finished: if playback is waiting on an item that will never
  // come, the book is over.
  if (alive() && s.waiting && s.playIdx >= s.items.length) finishPocketBook();
}

function makePocketSource(s, idx, rate) {
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = s.items[idx].buffer;
  source.playbackRate.value = rate;
  source.connect(ctx.destination);
  source.onended = () => onPocketEnded(s, source);
  return source;
}

// Play items[idx] now, from `offset` seconds into it.
function playPocketItem(s, idx, offset) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended" && !state.isPaused) { try { ctx.resume(); } catch (_) {} }
  for (const n of [s.cur, s.next]) {
    if (n && n.source) { n.source.onended = null; try { n.source.stop(); } catch (_) {} }
  }
  s.next = null;
  const rate = pocketRate();
  const source = makePocketSource(s, idx, rate);
  s.cur = { idx, source, startCtx: ctx.currentTime, offset, rate };
  s.waiting = false;
  source.start(0, offset);
  becameCurrent(s);
  schedulePocketNext(s);
}

// If the chunk after the current one is ready, schedule it to start the
// moment the current one ends.
function schedulePocketNext(s) {
  if (!s.cur || s.next) return;
  const idx = s.cur.idx + 1;
  if (!s.items[idx] || !s.items[idx].buffer) return;
  const ctx = getAudioCtx();
  const endTime = s.cur.startCtx + (s.items[s.cur.idx].buffer.duration - s.cur.offset) / s.cur.rate;
  if (endTime < ctx.currentTime + 0.05) return; // too close; onended will start it
  const rate = s.cur.rate;
  const source = makePocketSource(s, idx, rate);
  source.start(endTime);
  s.next = { idx, source, startCtx: endTime, rate };
}

function onPocketEnded(s, source) {
  if (pocketStream !== s || !s.cur || s.cur.source !== source) return;
  if (state.audioCtxSuspended) return;
  if (s.next) {
    s.cur = { idx: s.next.idx, source: s.next.source, startCtx: s.next.startCtx, offset: 0, rate: s.next.rate };
    s.next = null;
    becameCurrent(s);
    schedulePocketNext(s);
    return;
  }
  const idx = s.cur.idx + 1;
  s.cur = null;
  pocketSource = null;
  if (s.items[idx] && s.items[idx].buffer) {
    playPocketItem(s, idx, 0);
  } else if (s.done && idx >= s.items.length) {
    finishPocketBook();
  } else {
    s.playIdx = idx;
    s.waiting = true;
    setStatus("Loading the voice …", "busy");
  }
}

// Bookkeeping when a chunk starts: page, slider, progress, memory.
function becameCurrent(s) {
  const item = s.items[s.cur.idx];
  const pageTurn = item.page !== state.currentPage;
  if (pageTurn && sleepTimer.mode === "page") {
    // "End of page" sleep timer: stop at the page turn; Play picks up
    // from the start of the next page.
    setPocketPage(item.page);
    state.lastCharOffset = item.offset;
    stopInternal();
    state.resumeAt = { page: item.page, offset: item.offset };
    clearSleepTimer("Sleep timer: stopped at the end of the page.");
    return;
  }
  setPocketPage(item.page);
  pocketSource = s.cur.source;
  pocketSource._startCtxTime = s.cur.startCtx - s.cur.offset / s.cur.rate;
  state.pocketIndex = chunkIndexForOffset(state.pocketQueue, item.offset);
  state.lastCharOffset = item.offset;
  scheduleProgressSave();
  setStatus(`Reading page ${state.currentPage} …`, "quiet");
  updateMediaSession();
  // Let go of buffers far behind; "back 30 s" only needs the last few.
  const drop = s.cur.idx - POCKET_KEEP_BEHIND;
  if (drop >= 0 && s.items[drop]) s.items[drop].buffer = null;
}

function finishPocketBook() {
  setStatus("Reached the end of the document.", "ok");
  state.isPlaying = false;
  els.play.disabled = !state.pdfDoc;
  els.pause.disabled = true;
  syncPlayButton();
  updateMediaSession();
}

// Speed change while playing: re-anchor the current chunk at the new rate
// and reschedule the next one.
function pocketSetRate(rate) {
  const s = pocketStream;
  if (!s || !s.cur) return;
  const ctx = getAudioCtx();
  const played = s.cur.offset + Math.max(0, ctx.currentTime - s.cur.startCtx) * s.cur.rate;
  s.cur.source.playbackRate.value = rate;
  s.cur.startCtx = ctx.currentTime;
  s.cur.offset = played;
  s.cur.rate = rate;
  pocketSource._startCtxTime = s.cur.startCtx - s.cur.offset / rate;
  if (s.next) {
    s.next.source.onended = null;
    try { s.next.source.stop(); } catch (_) {}
    s.next = null;
  }
  schedulePocketNext(s);
}

// Move by `seconds` of audio (negative = back). Inside the kept buffers
// this is exact; past them it restarts the stream from the nearest
// sentence, estimating ~20 characters per second.
function pocketSeekBy(seconds) {
  const s = pocketStream;
  if (!s || !s.cur) return false;
  const ctx = getAudioCtx();
  let idx = s.cur.idx;
  let pos = s.cur.offset + Math.max(0, ctx.currentTime - s.cur.startCtx) * s.cur.rate + seconds;
  while (pos < 0 && idx > 0 && s.items[idx - 1].buffer) { idx -= 1; pos += s.items[idx].buffer.duration; }
  while (s.items[idx].buffer && pos >= s.items[idx].buffer.duration && s.items[idx + 1] && s.items[idx + 1].buffer) {
    pos -= s.items[idx].buffer.duration;
    idx += 1;
  }
  const item = s.items[idx];
  if (pos >= 0 && pos < item.buffer.duration) {
    playPocketItem(s, idx, pos);
    return true;
  }
  // Outside what we have: restart from text.
  if (pos < 0) {
    startPocketStream(item.page, Math.max(0, item.offset + Math.round(pos * 20)));
  } else if (s.prodAtoms.length) {
    startPocketStream(s.prodPage, s.prodAtoms[0].offset);
  } else if (!s.done && state.pdfDoc && s.prodPage < state.pdfDoc.numPages) {
    startPocketStream(s.prodPage + 1, 0);
  }
  return true;
}

function playPocketFromCurrent() {
  const base = els.pocketUrl.value.trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set the natural voice server under Voice, Advanced.", "err");
    return;
  }
  if (!(state.pagesText[state.currentPage - 1] || "").trim()) {
    const next = findNextPageWithText(state.currentPage);
    if (next > 0) {
      setCurrentPage(next);
      setStatus(`Skipping to page ${next} — the current page has no extractable text.`);
    } else {
      setStatus("No pages with extractable text.", "err");
      return;
    }
  }
  const r = state.resumeAt;
  state.resumeAt = null;
  const offset = r && r.page === state.currentPage ? r.offset : 0;
  state.pocketBase = base;
  setStatus(`Reading page ${state.currentPage} …`, "quiet");
  state.isPlaying = true;
  state.isPaused = false;
  state.audioCtxSuspended = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();
  try { getAudioCtx().resume(); } catch (_) {}
  startPocketStream(state.currentPage, offset);
  updateMediaSession();
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
  state.elevenLabsIndex = takeResumeIndex(state.elevenLabsQueue);
  state.abortElevenLabs = false;
  state.elevenLabsPlayToken = (state.elevenLabsPlayToken || 0) + 1;
  state.elevenLabsBuffers = new Array(state.elevenLabsQueue.length).fill(null);
  if (state.elevenLabsQueue.length === 0) {
    setStatus(`Page ${state.currentPage} has no extractable text.`, "err");
    return;
  }
  setStatus(`Reading page ${state.currentPage} \u2026`, "quiet");
  state.isPlaying = true;
  state.isPaused = false;
  els.play.disabled = true;
  els.pause.disabled = false;
  els.stop.disabled = false;
  syncPlayButton();
  try { getAudioCtx().resume(); } catch (_) {}
  const myToken = state.elevenLabsPlayToken;
  fetchAndDecodeElevenLabsChunk(state.elevenLabsIndex)
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
  noteChunkStart(state.elevenLabsQueue, state.elevenLabsIndex);
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
  // While paused the knob stays where playback stopped.
  if (!state.isDraggingSlider && !state.isPaused) {
    const v = els.engine.value === "pocket" && pocketStream ? pocketSliderValue(0) : idx;
    els.audioPos.value = String(Math.min(Number(els.audioPos.max), v));
  }
  const totalPages = state.pdfDoc ? state.pdfDoc.numPages : 0;
  if (els.audioPosLabel) {
    if (queue.length === 0 || totalPages === 0) {
      els.audioPosLabel.textContent = "—";
    } else {
      els.audioPosLabel.textContent = positionLabel();
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
        els.audioPos.value = String(Math.min(max, engine === "pocket" ? pocketSliderValue(frac) : idx + frac));
      }
      const totalPages = state.pdfDoc ? state.pdfDoc.numPages : 0;
      if (els.audioPosLabel && totalPages) els.audioPosLabel.textContent = positionLabel();
    } else if (engine !== "browser") {
      // paused / stopped but a queue exists — keep the label fresh even if
      // the value doesn't move
      refreshAudioPosUI();
    }
    posTickerRaf = requestAnimationFrame(tick);
  };
  posTickerRaf = requestAnimationFrame(tick);
}

// Pocket chunks don't line up with the page's fixed 600-char chunks the
// slider counts in, so place the knob by character position instead.
function pocketSliderValue(frac) {
  const s = pocketStream;
  if (!s) return state.pocketIndex;
  let pos = s.startOffset;
  if (s.cur) {
    const item = s.items[s.cur.idx];
    pos = item.offset + frac * (item.text.length + 1);
  }
  const starts = chunkStartOffsets(state.pocketQueue);
  const i = chunkIndexForOffset(state.pocketQueue, pos);
  const len = (state.pocketQueue[i] || "").length + 1;
  return i + Math.min(1, Math.max(0, (pos - starts[i]) / len));
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
  if (engine === "pocket") {
    state.isPlaying = true;
    state.isPaused = false;
    state.audioCtxSuspended = false;
    els.play.disabled = true;
    els.pause.disabled = false;
    els.stop.disabled = false;
    syncPlayButton();
    try { await getAudioCtx().resume(); } catch (_) {}
    startPocketStream(state.currentPage, chunkStartOffsets(queue)[clamped]);
    return;
  }

  // CRITICAL: set abortElevenLabs BEFORE stopping the source.
  // source.stop() fires onended synchronously, and the existing onended
  // handler would otherwise advance the chunk index and create a new
  // source for the FOLLOWING chunk — then jumpToChunk would create yet
  // another source for the target chunk, and both would play at once
  // (audible as overlapping / "crazy" audio). With the abort flag set,
  // the spurious onended bails out and only the target chunk plays.
  state.abortElevenLabs = true;

  // Stop whatever is playing right now. The onended handler will fire
  // synchronously and bail on the abort flag above.
  if (pocketSource) {
    try { pocketSource.stop(); } catch (_) {}
    pocketSource = null;
  }

  // Bump the playback token so any in-flight fetch for the old chunk is
  // discarded by its own myToken guard.
  state.elevenLabsPlayToken = (state.elevenLabsPlayToken || 0) + 1;
  state.elevenLabsIndex = clamped;

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
    playElevenLabsDecodedChunk(buffer);
  } else {
    setStatus(
      `Loading chunk ${clamped + 1}/${queue.length} on page ${state.currentPage} \u2026`,
      "busy"
    );
    fetchAndDecodeElevenLabsChunk(clamped).then((b) => {
      if (!b) return;
      // Only play if we are still on this chunk (user didn't jump again).
      if (state.elevenLabsIndex !== clamped) return;
      playElevenLabsDecodedChunk(b);
    }).catch(() => {});
  }

  // Clear the abort flag now that the new source has taken over — the
  // NEXT onended (when the new chunk finishes naturally) should advance
  // to the chunk after `clamped` as normal.
  state.abortElevenLabs = false;
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

// ----- Audible-style controls: 30 s skips, sleep timer, lock screen -----

// 30 s back / forward. Pocket seeks inside its audio; ElevenLabs and the
// browser voice move one chunk (a sentence or two).
function skipSeconds(seconds) {
  if (!state.pdfDoc || (!state.isPlaying && !state.isPaused)) return;
  const engine = els.engine.value;
  if (engine === "pocket") {
    if (state.isPaused) resumeInternal();
    pocketSeekBy(seconds);
    return;
  }
  if (engine === "elevenlabs") {
    jumpToChunk(state.elevenLabsIndex + (seconds < 0 ? -1 : 1));
    return;
  }
  const queue = state.browserQueue;
  const target = state.browserIndex + (seconds < 0 ? -1 : 1);
  const page = state.currentPage;
  if (target >= queue.length) {
    if (state.currentPage < state.pdfDoc.numPages) els.next.click();
    return;
  }
  const offset = chunkStartOffsets(queue)[Math.max(0, target)] || 0;
  stopInternal().then(() => {
    setCurrentPage(page);
    state.resumeAt = { page, offset };
    playFromCurrent();
  });
}
els.back30.addEventListener("click", () => skipSeconds(-30));
els.fwd30.addEventListener("click", () => skipSeconds(30));

// The skip buttons follow the transport state.
function syncSkipButtons() {
  const active = Boolean(state.pdfDoc) && (state.isPlaying || state.isPaused);
  els.back30.disabled = !active;
  els.fwd30.disabled = !active;
}

// Sleep timer: pause after N minutes, or stop at the next page turn.
const sleepTimer = { mode: "off", until: 0, timer: null, ticker: null };
function clearSleepTimer(message) {
  clearTimeout(sleepTimer.timer);
  clearInterval(sleepTimer.ticker);
  sleepTimer.mode = "off";
  sleepTimer.timer = sleepTimer.ticker = null;
  els.sleepTimer.value = "off";
  els.sleepLabel.hidden = true;
  syncSleepChip();
  if (message) setStatus(message, "ok");
}
function showSleepRemaining() {
  const left = Math.max(0, sleepTimer.until - Date.now());
  const m = Math.floor(left / 60000);
  const sec = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  els.sleepLabel.textContent = `Pausing in ${m}:${sec}`;
  els.sleepLabel.hidden = false;
}
els.sleepTimer.addEventListener("change", () => {
  const v = els.sleepTimer.value;
  clearTimeout(sleepTimer.timer);
  clearInterval(sleepTimer.ticker);
  sleepTimer.mode = v === "off" ? "off" : v === "page" ? "page" : "min";
  syncSleepChip();
  if (sleepTimer.mode === "off") { clearSleepTimer(); return; }
  if (sleepTimer.mode === "page") {
    els.sleepLabel.textContent = "Stops at the end of this page";
    els.sleepLabel.hidden = false;
    return;
  }
  sleepTimer.until = Date.now() + Number(v) * 60000;
  showSleepRemaining();
  sleepTimer.ticker = setInterval(showSleepRemaining, 1000);
  sleepTimer.timer = setTimeout(() => {
    pauseInternal();
    clearSleepTimer("Sleep timer: paused.");
  }, Number(v) * 60000);
});

// Lock screen, headphones and car controls (Media Session API).
const MS = "mediaSession" in navigator ? navigator.mediaSession : null;
function updateMediaSession() {
  syncSkipButtons();
  if (!MS) return;
  try {
    const total = state.pdfDoc ? state.pdfDoc.numPages : 0;
    const unit = state.pdfDoc && state.pdfDoc._kind === "epub" ? "Chapter" : "Page";
    const chapter = state.chapterTitles && state.chapterTitles[state.currentPage - 1];
    MS.metadata = new MediaMetadata({
      title: chapter || state.bookTitle || "Amazing Grace Reader",
      artist: state.bookTitle && chapter ? state.bookTitle : "Amazing Grace Reader",
      album: total ? `${unit} ${state.currentPage} of ${total}` : "",
    });
    MS.playbackState = state.isPlaying ? "playing" : state.isPaused ? "paused" : "none";
  } catch (_) {}
}
if (MS) {
  const on = (action, fn) => { try { MS.setActionHandler(action, fn); } catch (_) {} };
  on("play", () => els.play.click());
  on("pause", () => pauseInternal());
  on("stop", () => stopInternal());
  on("seekbackward", (d) => skipSeconds(-((d && d.seekOffset) || 30)));
  on("seekforward", (d) => skipSeconds((d && d.seekOffset) || 30));
  on("previoustrack", () => els.prev.click());
  on("nexttrack", () => els.next.click());
}

// A silent, looping <audio> element plays alongside Web Audio. It makes
// phones treat the page as a media player (lock-screen controls, keeps
// playing with the screen off) and, on iPhones, lets speech play with
// the silent switch on.
let keepAliveEl = null;
function silentWavUrl() {
  const rate = 8000, n = rate; // one second
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function setKeepAlive(on) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    if (on) {
      if (!keepAliveEl) {
        keepAliveEl = new Audio(silentWavUrl());
        keepAliveEl.loop = true;
      }
      keepAliveEl.play().catch(() => {});
    } else if (keepAliveEl) {
      keepAliveEl.pause();
    }
  } catch (_) {}
}


// =========================================================================
// Redesign: covers, library tools, player panels, bookmarks, mini player,
// theme, voice sheet, keyboard, drag and drop, install.
// =========================================================================

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};
const unitFor = (kind) => (kind === "epub" ? "Chapter" : "Page");
const loadedUnit = () => (state.pdfDoc && state.pdfDoc._kind === "epub" ? "Chapter" : "Page");

// ----- covers -----
// A book's own cover (EPUB cover image, or a PDF's first page when it
// looks like a cover) is saved on this device once the book is opened;
// until then the cover is drawn from the title.
const COVER_HUES = [28, 48, 145, 165, 200, 228, 262, 300, 340, 12, 95, 185];
function hueFor(text) {
  let h = 0;
  for (const c of String(text || "")) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return COVER_HUES[h % COVER_HUES.length];
}
const thumbKey = (id) => `agr.thumb.${id}`;
const getThumb = (id) => (id ? store.get(thumbKey(id)) : null);
const forgetThumb = (id) => store.del(thumbKey(id));
function coverHtml(b) {
  const thumb = b && getThumb(b.id);
  if (thumb) return `<div class="cover cover-img"><img src="${thumb}" alt="" loading="lazy" /></div>`;
  const title = (b && b.title) || state.bookTitle || "";
  return `<div class="cover" style="--h:${hueFor(title)}" aria-hidden="true">
    <span class="cover-kind">${escapeHtml(((b && b.kind) || "").toUpperCase())}</span>
    <span class="cover-title">${escapeHtml(title)}</span>
    <span class="cover-author">${escapeHtml((b && b.author) || "")}</span>
  </div>`;
}
function renderPlayerCover() {
  const b = state.currentBook || { id: state.currentBookId, title: state.bookTitle, kind: state.pdfDoc && state.pdfDoc._kind === "epub" ? "epub" : "pdf" };
  els.playerCover.innerHTML = coverHtml(b);
}
function canvasToThumb(canvas) {
  try { return canvas.toDataURL("image/jpeg", 0.72); } catch (_) { return null; }
}
function saveThumb(id, dataUrl) {
  if (!id || !dataUrl) return;
  store.set(thumbKey(id), dataUrl);
  if (id === state.currentBookId) renderPlayerCover();
  syncMiniPlayer(true);
}
async function savePdfThumb(doc, id) {
  if (!id || getThumb(id)) return;
  // A text-heavy first page is a title page or chapter one, not a cover.
  if ((state.pagesText[0] || "").length > 400) return;
  try {
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 320 / vp0.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    saveThumb(id, canvasToThumb(canvas));
  } catch (_) { /* keep the drawn cover */ }
}
async function saveEpubThumb(zip, opfDoc, opfDir, id) {
  if (!id || getThumb(id)) return;
  try {
    let item = opfDoc.querySelector('manifest > item[properties~="cover-image"]');
    if (!item) {
      const meta = opfDoc.querySelector('metadata > meta[name="cover"]');
      const cid = meta && meta.getAttribute("content");
      if (cid) item = Array.from(opfDoc.querySelectorAll("manifest > item")).find((el) => el.getAttribute("id") === cid);
    }
    const href = item && item.getAttribute("href");
    const entry = href && zip.file(opfDir + decodeURIComponent(href));
    if (!entry) return;
    const blob = new Blob([await entry.async("uint8array")], { type: item.getAttribute("media-type") || "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = Math.round((320 * bmp.height) / bmp.width);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    saveThumb(id, canvasToThumb(canvas));
  } catch (_) { /* keep the drawn cover */ }
}

// ----- library: progress, search, sort, continue listening -----
function bookPercent(b) {
  if (b.id === state.currentBookId && state.pdfDoc) return Math.round(loadedFraction() * 100);
  if (!b.progress_page || !b.progress_total_pages) return null;
  return Math.max(1, Math.round(((b.progress_page - 1) / b.progress_total_pages) * 100));
}
function bookMetaHtml(b) {
  const unit = unitFor(b.kind);
  const page = b.id === state.currentBookId && state.pdfDoc ? state.currentPage : b.progress_page;
  const total = b.id === state.currentBookId && state.pdfDoc ? state.pdfDoc.numPages : b.progress_total_pages;
  if (!page) return `${b.kind.toUpperCase()} &middot; Not started`;
  const pct = bookPercent(b);
  return `${unit} ${page}${total ? ` of ${total}` : ""}${pct != null ? ` &middot; ${pct}%` : ""}`;
}
function filteredSortedBooks() {
  const q = (els.librarySearch.value || "").trim().toLowerCase();
  const list = state.books.filter((b) => !q || `${b.title} ${b.author || ""}`.toLowerCase().includes(q));
  const by = els.librarySort.value;
  const recent = (b) => b.last_opened_at || 0;
  if (by === "title") list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  else if (by === "added") list.sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
  else list.sort((a, b) => recent(b) - recent(a) || (b.added_at || 0) - (a.added_at || 0));
  return list;
}
els.librarySearch.addEventListener("input", () => renderLibrary());
els.librarySort.value = store.get("agr.sort") || "recent";
els.librarySort.addEventListener("change", () => { store.set("agr.sort", els.librarySort.value); renderLibrary(); });

function continueBook() {
  if (state.currentBookId) {
    const b = state.books.find((x) => x.id === state.currentBookId);
    if (b) return b;
  }
  return state.books
    .filter((b) => b.last_opened_at || b.progress_page)
    .sort((a, b) => (b.last_opened_at || 0) - (a.last_opened_at || 0))[0] || null;
}
function renderContinueCard() {
  const b = continueBook();
  els.continueCard.hidden = !b;
  if (!b) return;
  els.continueCover.innerHTML = coverHtml(b);
  els.continueTitle.textContent = b.title;
  const pct = bookPercent(b);
  els.continueMeta.innerHTML = b.progress_page || b.id === state.currentBookId ? bookMetaHtml(b) : "Start from the beginning";
  els.continueBar.style.width = `${pct || 0}%`;
  els.continueCard.dataset.id = String(b.id);
  const playing = b.id === state.currentBookId && state.isPlaying && !state.isPaused;
  els.continueBtn.querySelector("span").textContent = playing ? "Open player" : b.progress_page ? "Resume" : "Play";
}
// Resume = open and play in one tap. Unlock audio inside the tap so the
// play that follows the download is allowed on phones.
els.continueBtn.addEventListener("click", () => {
  const id = Number(els.continueCard.dataset.id);
  try { getAudioCtx().resume(); } catch (_) {}
  if (els.engine.value !== "browser") setKeepAlive(true);
  state.autoPlayOnOpen = true;
  openBookFromLibrary(id);
});
function maybeAutoPlay() {
  if (!state.autoPlayOnOpen) return;
  state.autoPlayOnOpen = false;
  if (state.pdfDoc && !(state.isPlaying && !state.isPaused)) els.play.click();
}

// ----- player -----
function prepareReaderFor(book) {
  state.bookTitle = book.title;
  els.playerBookTitle.textContent = book.title;
  els.nrTitle.textContent = "";
  els.pageUnit.textContent = unitFor(book.kind);
  els.chaptersTabLabel.textContent = book.kind === "epub" ? "Chapters" : "Pages";
  els.pageCount.textContent = "…";
  renderPlayerCover();
  els.readAlong.innerHTML = `<p class="ra-empty">Opening the book…</p>`;
  els.chaptersList.innerHTML = "";
  state.bookmarks = [];
  renderBookmarks();
  els.timeLeft.textContent = "";
  els.audioPosLabel.textContent = "—";
  els.bookBar.style.width = "0%";
}
function bookLoaded() {
  els.pageUnit.textContent = loadedUnit();
  els.chaptersTabLabel.textContent = loadedUnit() === "Chapter" ? "Chapters" : "Pages";
  els.bookmarkBtn.disabled = false;
  if (state.currentBook) state.bookTitle = state.bookTitle || state.currentBook.title;
  renderPlayerCover();
  renderChapters();
  renderReadAlong(true);
  els.audioPosLabel.textContent = positionLabel();
  updateTimes();
}
function onPageChanged() {
  if (!els.readAlong) return;
  renderReadAlong();
  markChapter();
  els.audioPosLabel.textContent = state.pdfDoc ? positionLabel() : "—";
  updateTimes();
}
function positionLabel() {
  if (!state.pdfDoc) return "—";
  return `${loadedUnit()} ${state.currentPage} of ${state.pdfDoc.numPages}`;
}

// Where the voice is now: { page, start, end, pos } in the page's offset
// model (see chunkStartOffsets), or null when nothing is playing.
function currentReadPos() {
  if (!state.pdfDoc || !(state.isPlaying || state.isPaused)) return null;
  const s = pocketStream;
  if (els.engine.value === "pocket") {
    if (!s || !s.cur || !s.items[s.cur.idx]) return null;
    const item = s.items[s.cur.idx];
    let frac = 0;
    if (pocketSource && item.buffer) {
      const ctx = getAudioCtx();
      const rate = Number(els.speed.value) || 1;
      const t0 = pocketSource._startCtxTime ?? ctx.currentTime;
      frac = Math.min(1, Math.max(0, ((ctx.currentTime - t0) * rate) / Math.max(0.001, item.buffer.duration)));
    }
    return { page: item.page, start: item.offset, end: item.offset + item.text.length, pos: item.offset + frac * item.text.length, fine: true };
  }
  const queue = els.engine.value === "browser" ? state.browserQueue : state.elevenLabsQueue;
  const idx = els.engine.value === "browser" ? state.browserIndex : state.elevenLabsIndex;
  const text = queue[idx] || "";
  const start = state.lastCharOffset;
  return { page: state.currentPage, start, end: start + text.length, pos: start, fine: false };
}
// Characters per page and before each page, computed once per book.
let pageLensFor = null, pageLens = [], pageBefore = [], bookChars = 0;
function bookLengths() {
  if (pageLensFor !== state.pagesText) {
    pageLensFor = state.pagesText;
    pageLens = state.pagesText.map((t) => t.length + 1);
    pageBefore = [];
    bookChars = 0;
    for (const n of pageLens) { pageBefore.push(bookChars); bookChars += n; }
  }
  return { lens: pageLens, before: pageBefore, total: bookChars };
}
// Fraction of the whole book behind the voice (by characters).
function loadedFraction() {
  if (!state.pdfDoc) return 0;
  const { lens, before: starts, total: sum } = bookLengths();
  const total = sum || 1;
  const before = starts[state.currentPage - 1] || 0;
  const r = currentReadPos();
  const inPage = r && r.page === state.currentPage ? r.pos : (state.resumeAt && state.resumeAt.page === state.currentPage ? state.resumeAt.offset : state.lastCharOffset);
  return Math.min(1, (before + Math.min(inPage || 0, lens[state.currentPage - 1] || 0)) / total);
}
function charsPerSecond() {
  const speed = Number(els.speed.value) || 1;
  if (els.engine.value === "pocket") return (1000 / 51) * speed; // measured on the hosted voice
  return 14.5 * speed;
}
function formatDuration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
function updateTimes() {
  if (!state.pdfDoc) { els.timeLeft.textContent = ""; return; }
  const { total } = bookLengths();
  const frac = loadedFraction();
  const left = (total * (1 - frac)) / charsPerSecond();
  els.timeLeft.textContent = total ? `${formatDuration(left)} left in book` : "";
  els.bookBar.style.width = `${(frac * 100).toFixed(1)}%`;
}

// ----- read along -----
let raPage = 0;
let raNow = null;
let raUserScrollAt = 0;
function renderReadAlong(force = false) {
  if (!state.pdfDoc) {
    raPage = 0;
    raNow = null;
    els.readAlong.innerHTML = `<p class="muted">The text appears here and follows the voice. Tap a sentence to listen from there.</p>`;
    return;
  }
  if (!force && raPage === state.currentPage) return;
  raPage = state.currentPage;
  raNow = null;
  const ct = state.chapterTitles && state.chapterTitles[raPage - 1];
  const head = `<p class="ra-heading">${escapeHtml(ct || `${loadedUnit()} ${raPage}`)}</p>`;
  const atoms = pageAtoms(raPage);
  if (atoms.length === 0) {
    els.readAlong.innerHTML = head + `<p class="ra-empty">There is no readable text on this ${loadedUnit().toLowerCase()}. It may be a picture or a scanned page.</p>`;
  } else {
    els.readAlong.innerHTML = head + "<p>" + atoms.map((a) =>
      `<span class="ra-s" data-o="${a.offset}" data-e="${a.offset + a.text.length}">${escapeHtml(a.text)}</span>`
    ).join(" ") + "</p>";
  }
  if (raPage < state.pdfDoc.numPages) {
    els.readAlong.insertAdjacentHTML("beforeend", `<div class="ra-next"><button type="button" class="btn btn-ghost" data-next-page>Next ${loadedUnit().toLowerCase()} &rarr;</button></div>`);
  }
  els.readAlong.scrollTop = 0;
}
function highlightReadAlong() {
  const r = currentReadPos();
  const spans = els.readAlong.querySelectorAll(".ra-s");
  let now = null;
  if (r && r.page === raPage) {
    for (const sp of spans) {
      const o = Number(sp.dataset.o), e = Number(sp.dataset.e);
      const isNow = r.fine ? (r.pos >= o && r.pos <= e + 1) : (o < r.end && e > r.start);
      if (isNow && !now) now = sp;
      sp.classList.toggle("ra-now", isNow && (r.fine ? sp === now : true));
      sp.classList.toggle("ra-said", e < (r.fine ? r.pos : r.start));
    }
  } else {
    spans.forEach((sp) => sp.classList.remove("ra-now"));
  }
  if (now && now !== raNow) {
    raNow = now;
    if (Date.now() - raUserScrollAt > 5000) {
      const box = els.readAlong;
      const top = now.offsetTop - box.offsetTop - box.clientHeight / 3;
      box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }
}
["wheel", "touchmove", "keydown"].forEach((ev) =>
  els.readAlong.addEventListener(ev, () => { raUserScrollAt = Date.now(); }, { passive: true })
);
els.readAlong.addEventListener("click", (e) => {
  if (e.target.closest("[data-next-page]")) { els.next.click(); return; }
  const sp = e.target.closest(".ra-s");
  if (!sp || !state.pdfDoc) return;
  raUserScrollAt = 0;
  playFrom(raPage, Number(sp.dataset.o));
});

// Start playing at (page, offset): read-along taps, chapters, bookmarks.
function playFrom(page, offset) {
  if (!state.pdfDoc) return;
  try { getAudioCtx().resume(); } catch (_) {}
  if (els.engine.value !== "browser") setKeepAlive(true);
  stopInternal().then(() => {
    setCurrentPage(page);
    state.resumeAt = { page, offset };
    state.lastCharOffset = offset;
    playFromCurrent();
  });
}

// ----- chapters / pages list -----
function renderChapters() {
  els.chaptersList.innerHTML = "";
  if (!state.pdfDoc) return;
  const unit = loadedUnit();
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= state.pdfDoc.numPages; i++) {
    const li = document.createElement("li");
    const name = (state.chapterTitles && state.chapterTitles[i - 1]) ||
      (state.pagesText[i - 1] || "").replace(/\s+/g, " ").trim().slice(0, 80) || `${unit} ${i} (no text)`;
    li.innerHTML = `<button type="button" data-page="${i}"><span class="ch-num">${i}</span><span class="ch-name">${escapeHtml(name)}</span></button>`;
    frag.appendChild(li);
  }
  els.chaptersList.appendChild(frag);
  markChapter();
}
function markChapter() {
  els.chaptersList.querySelectorAll("button").forEach((b) => {
    const on = Number(b.dataset.page) === state.currentPage;
    b.classList.toggle("ch-now", on);
    if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  });
}
els.chaptersList.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (!b) return;
  playFrom(Number(b.dataset.page), 0);
  showPanel("readAlong");
});

// ----- bookmarks -----
async function loadBookmarks(id) {
  try {
    const { bookmarks } = await api(`/api/books/${id}/bookmarks`);
    if (state.currentBookId !== id) return;
    state.bookmarks = bookmarks || [];
  } catch (e) {
    state.bookmarks = [];
  }
  renderBookmarks();
}
function bookmarkQuote(page, offset) {
  const atoms = pageAtoms(page);
  let a = atoms[0];
  for (const x of atoms) { if (x.offset <= offset) a = x; else break; }
  return a ? a.text : "";
}
function renderBookmarks() {
  els.bookmarksList.innerHTML = "";
  const list = state.bookmarks;
  els.bookmarksEmpty.hidden = list.length > 0;
  els.bookmarkCount.hidden = list.length === 0;
  els.bookmarkCount.textContent = String(list.length);
  const unit = loadedUnit();
  for (const bm of list) {
    const li = document.createElement("li");
    const quote = state.pdfDoc ? bookmarkQuote(bm.page, bm.char_offset) : "";
    li.innerHTML = `
      <button type="button" class="bookmark-jump" data-id="${bm.id}">
        <span class="bookmark-where">${unit} ${bm.page}</span>
        ${bm.note ? `<span class="bookmark-note">${escapeHtml(bm.note)}</span>` : ""}
        <span class="bookmark-quote">${escapeHtml(quote)}</span>
      </button>
      <button type="button" class="btn-icon-round bookmark-edit" data-id="${bm.id}" aria-label="${bm.note ? "Edit note" : "Add a note"} on ${unit.toLowerCase()} ${bm.page}">
        <svg width="18" height="18" aria-hidden="true"><use href="#i-note"/></svg>
      </button>
      <button type="button" class="btn-icon-round bookmark-del" data-id="${bm.id}" aria-label="Delete bookmark on ${unit.toLowerCase()} ${bm.page}">
        <svg width="18" height="18" aria-hidden="true"><use href="#i-trash"/></svg>
      </button>`;
    els.bookmarksList.appendChild(li);
  }
}
async function addBookmark() {
  if (!state.pdfDoc || !state.currentBookId) return;
  const r = currentReadPos();
  const page = r ? r.page : state.currentPage;
  let offset = r ? Math.floor(r.fine ? r.pos : r.start) : state.lastCharOffset;
  // Snap to the start of the sentence so the jump back begins cleanly.
  for (const a of pageAtoms(page)) { if (a.offset <= offset) offset = Math.max(0, a.offset); }
  if (state.bookmarks.some((b) => b.page === page && b.char_offset === offset)) {
    setStatus(`This spot is already bookmarked`, "ok");
    showPanel("bookmarksPanel");
    return;
  }
  const note = null;
  try {
    const { bookmark } = await api(`/api/books/${state.currentBookId}/bookmarks`, {
      method: "POST",
      body: JSON.stringify({ page, char_offset: offset, note }),
    });
    state.bookmarks = [...state.bookmarks, bookmark].sort((a, b) => a.page - b.page || a.char_offset - b.char_offset);
    renderBookmarks();
    setStatus(`Bookmarked ${loadedUnit().toLowerCase()} ${page}`, "ok");
  } catch (e) {
    setStatus(`Could not save the bookmark: ${e.message}`, "err");
  }
}
// Inline note editor: Enter or leaving the box saves, Escape cancels.
function editBookmarkNote(id, li) {
  const bm = state.bookmarks.find((b) => b.id === id);
  if (!bm || !li) return;
  const form = document.createElement("form");
  form.className = "bookmark-note-form";
  form.innerHTML = `<input type="text" maxlength="500" placeholder="Add a note" aria-label="Note for this bookmark" />
    <button type="submit" class="btn btn-primary btn-small">Save</button>`;
  const input = form.querySelector("input");
  input.value = bm.note || "";
  li.replaceChildren(form);
  input.focus();
  let done = false;
  const save = async () => {
    if (done) return;
    done = true;
    const note = input.value.trim();
    if (note === (bm.note || "")) return renderBookmarks();
    try {
      const { bookmark } = await api(`/api/books/${state.currentBookId}/bookmarks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note }),
      });
      state.bookmarks = state.bookmarks.map((b) => (b.id === id ? bookmark : b));
      setStatus(note ? "Note saved" : "Note removed", "ok");
    } catch (err) {
      setStatus(`Could not save the note: ${err.message}`, "err");
    }
    renderBookmarks();
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  input.addEventListener("blur", () => setTimeout(save, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); done = true; renderBookmarks(); }
  });
}
els.bookmarkBtn.addEventListener("click", addBookmark);
els.bookmarksList.addEventListener("click", async (e) => {
  const edit = e.target.closest(".bookmark-edit");
  if (edit) { editBookmarkNote(Number(edit.dataset.id), edit.closest("li")); return; }
  const del = e.target.closest(".bookmark-del");
  const jump = e.target.closest(".bookmark-jump");
  if (del) {
    const id = Number(del.dataset.id);
    try {
      await api(`/api/books/${state.currentBookId}/bookmarks/${id}`, { method: "DELETE" });
      state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
      renderBookmarks();
    } catch (err) {
      setStatus(`Could not delete the bookmark: ${err.message}`, "err");
    }
  } else if (jump) {
    const bm = state.bookmarks.find((b) => b.id === Number(jump.dataset.id));
    if (bm) { playFrom(bm.page, bm.char_offset); showPanel("readAlong"); }
  }
});

// ----- panel tabs -----
const PANELS = ["readAlong", "chaptersPanel", "bookmarksPanel"];
function showPanel(id) {
  for (const p of PANELS) els[p === "readAlong" ? "readAlong" : p].hidden = p !== id;
  document.querySelectorAll(".panel .seg-btn").forEach((b) => {
    const on = b.dataset.panel === id;
    b.classList.toggle("seg-btn-active", on);
    b.setAttribute("aria-selected", String(on));
  });
  if (id === "chaptersPanel") {
    const cur = els.chaptersList.querySelector(".ch-now");
    if (cur) els.chaptersPanel.scrollTop = cur.offsetTop - els.chaptersPanel.offsetTop - 80;
  }
}
document.querySelectorAll(".panel .seg-btn").forEach((b) => b.addEventListener("click", () => showPanel(b.dataset.panel)));

// ----- speed + sleep chips -----
function syncSpeedChip() {
  const v = Number(els.speed.value) || 1;
  els.speedLabel.textContent = `${v.toFixed(v * 100 % 10 ? 2 : 1)}×`;
  const match = Array.from(els.speedChip.options).find((o) => Math.abs(Number(o.value) - v) < 0.001);
  if (match) els.speedChip.value = match.value;
  els.speedChip.closest(".chip").classList.toggle("chip-on", Math.abs(v - 1) > 0.001);
  store.set("agr.speed", String(v));
}
els.speedChip.addEventListener("change", () => {
  els.speed.value = els.speedChip.value;
  els.speed.dispatchEvent(new Event("input"));
});
function syncSleepChip() {
  const v = els.sleepTimer.value;
  const on = v !== "off";
  els.sleepChipLabel.textContent = !on ? "Sleep" : v === "page" ? "End of page" : `${v} min`;
  els.sleepTimer.closest(".chip").classList.toggle("chip-on", on);
}

// ----- voice sheet -----
function voiceName() {
  if (els.engine.value === "browser") return "Device voice";
  if (els.engine.value === "elevenlabs") return "Premium voice";
  const v = els.pocketVoice.value.trim();
  return /^[a-z]+$/i.test(v) ? v.charAt(0).toUpperCase() + v.slice(1) : "Custom voice";
}
function syncVoicePicks() {
  const v = els.pocketVoice.value.trim().toLowerCase();
  document.querySelectorAll(".voice-pick").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.voice === v)));
  els.voiceBtnLabel.textContent = voiceName();
  store.set("agr.voice", JSON.stringify({ engine: els.engine.value, pocketVoice: els.pocketVoice.value.trim() }));
}
function restartIfPlaying() {
  if (!(state.isPlaying || state.isPaused)) return;
  const page = state.currentPage, offset = state.lastCharOffset;
  stopInternal().then(() => {
    setCurrentPage(page);
    state.resumeAt = { page, offset };
    playFromCurrent();
  });
}
document.querySelectorAll(".voice-pick").forEach((b) => b.addEventListener("click", () => {
  if (els.pocketVoice.value === b.dataset.voice) return;
  els.pocketVoice.value = b.dataset.voice;
  els.pocketVoice.dispatchEvent(new Event("change"));
  syncVoicePicks();
  if (els.engine.value === "pocket") restartIfPlaying();
}));
els.pocketVoice.addEventListener("change", syncVoicePicks);
els.engine.addEventListener("change", syncVoicePicks);
els.voiceBtn.addEventListener("click", () => {
  if (typeof els.voiceDialog.showModal === "function") els.voiceDialog.showModal();
  else els.voiceDialog.setAttribute("open", "");
});
els.voiceDialog.addEventListener("click", (e) => { if (e.target === els.voiceDialog) els.voiceDialog.close(); });
(function restoreVoicePrefs() {
  try {
    const p = JSON.parse(store.get("agr.voice") || "null");
    if (p && ["pocket", "browser", "elevenlabs"].includes(p.engine)) els.engine.value = p.engine;
    if (p && p.pocketVoice) els.pocketVoice.value = p.pocketVoice;
  } catch (_) {}
  const sp = Number(store.get("agr.speed"));
  if (sp >= 0.5 && sp <= 2) els.speed.value = String(sp);
  syncVoicePicks();
})();

// ----- mini player -----
let miniKey = "";
function syncMiniPlayer(forceCover = false) {
  if (!els.miniPlayer) return;
  const show = Boolean(state.pdfDoc && state.currentBookId && (state.screen === "library" || state.screen === "public"));
  els.miniPlayer.hidden = !show;
  document.body.classList.toggle("has-mini", show);
  if (!show) return;
  const playing = state.isPlaying && !state.isPaused;
  const key = `${state.currentBookId}`;
  if (forceCover || key !== miniKey) {
    miniKey = key;
    els.miniCover.innerHTML = coverHtml(state.currentBook || { id: state.currentBookId, title: state.bookTitle });
  }
  els.miniTitle.textContent = state.bookTitle;
  els.miniSub.textContent = `${positionLabel()}${playing ? " · Playing" : state.isPaused ? " · Paused" : ""}`;
  els.miniToggleIcon.setAttribute("href", playing ? "#i-pause" : "#i-play");
  els.miniToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  els.miniBar.style.width = `${(loadedFraction() * 100).toFixed(1)}%`;
}
els.miniOpen.addEventListener("click", () => showScreen("reader"));
els.miniToggle.addEventListener("click", togglePlay);
function togglePlay() {
  if (!state.pdfDoc) return;
  if (state.isPlaying && !state.isPaused) pauseInternal();
  else els.play.click();
  syncPlayButton();
}

// ----- theme -----
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function syncThemeButton() {
  const dark = currentTheme() === "dark";
  els.themeToggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach((m) => m.setAttribute("content", dark ? "#1c1815" : "#faf6f0"));
}
els.themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("agr.theme", next);
  syncThemeButton();
});
syncThemeButton();

els.brandHome.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.user && state.screen !== "library") { showScreen("library"); loadLibrary(); }
});
if (els.tabMine) els.tabMine.addEventListener("click", () => {});

// ----- keyboard -----
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.closest("input, select, textarea, button, [contenteditable], dialog") || t.isContentEditable)) return;
  if (!state.pdfDoc || state.screen === "auth") return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
  else if ((e.key === "ArrowLeft" || e.key === "j") && !els.back30.disabled) { e.preventDefault(); els.back30.click(); }
  else if ((e.key === "ArrowRight" || e.key === "l") && !els.fwd30.disabled) { e.preventDefault(); els.fwd30.click(); }
  else if (e.key === "b" || e.key === "B") { e.preventDefault(); addBookmark(); }
});

// ----- drag a file anywhere onto the page -----
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || !state.user) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && state.user) uploadFile(f);
});

// ----- UI clock: play/pause state, read-along highlight, times -----
setInterval(() => {
  if (document.hidden) return;
  syncPlayButton();
  syncSkipButtons();
  if (state.screen === "reader" && state.pdfDoc) {
    if (raPage !== state.currentPage) renderReadAlong();
    highlightReadAlong();
    updateTimes();
  }
}, 250);

// ----- install as an app -----
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ----- initial UI state -----
applyEngineVisibility();
syncSpeedChip();
syncPlayButton();
setAuthMode("login");

// Kick off session check
init();
