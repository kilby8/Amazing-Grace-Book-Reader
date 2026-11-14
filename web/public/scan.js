// Scan pages: photos of a printed book -> OCR in the browser -> an EPUB
// saved to My books, which then plays like any other book. See SCAN.md.
//
// OCR is Tesseract.js (WebAssembly), loaded from jsDelivr the first time
// someone opens the scanner; nothing is sent to a server until the finished
// book is saved. Photos are cleaned up first (lighting flattened, contrast
// stretched), because shadows and a curled page are what trip OCR up most.
import { cleanPage, finishBook, suggestOrder, buildEpub, LOW_CONFIDENCE } from "./scan-text.js";

const TESS_VERSION = "5.1.1";
const CDN = "https://cdn.jsdelivr.net/npm";
const TESS_PATHS = {
  workerPath: `${CDN}/tesseract.js@${TESS_VERSION}/dist/worker.min.js`,
  corePath: `${CDN}/tesseract.js-core@${TESS_VERSION}`,
  langPath: `${CDN}/@tesseract.js-data/eng@1.0.0/4.0.0_best_int`,
};
const MAX_SIDE = 2600;   // big enough for small print, small enough to be quick
const MIN_SIDE = 1600;

const $ = (id) => document.getElementById(id);
let els = null;
let opts = null;
let nextId = 1;
const pages = [];        // { id, file, url, rotation, status, text, head, pageNumber, confidence, words, error, edited }
let workerPromise = null;
let running = false;
let progress = 0;        // 0..1 within the page being read
let saving = false;

// ---------- OCR engine ----------
function loadWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await import(`${CDN}/tesseract.js@${TESS_VERSION}/dist/tesseract.esm.min.js`);
      const create = Tesseract.createWorker || (Tesseract.default && Tesseract.default.createWorker);
      const worker = await create("eng", 1, {
        ...TESS_PATHS,
        logger: (m) => {
          if (m.status === "recognizing text") {
            progress = m.progress || 0;
            renderProgress();
          } else if (/loading|initializ/.test(m.status || "")) {
            setNote("Getting the text reader ready (first time only, about 5 MB)…");
          }
        },
      });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// ---------- Image clean-up ----------
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    // Older Safari: no options bag; fall back to an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (_) {
        throw new Error(/hei[cf]$/i.test(file.name || "") || /hei[cf]/i.test(file.type || "")
          ? "This browser can't open HEIC photos. Choose them from your phone, or save them as JPEG."
          : "This file couldn't be opened as a photo");
      }
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Draw the photo upright and at a working size, then flatten the lighting:
// each pixel is divided by the brightness around it, so a shadow across the
// page or a dim corner turns into the same white paper. Then stretch the
// contrast so the ink is properly dark.
export async function preparePhoto(file, rotation = 0, cleanup = {}) {
  const bmp = await decode(file);
  const w0 = bmp.width || bmp.naturalWidth;
  const h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error("This photo could not be opened");
  const long = Math.max(w0, h0);
  const X = cleanup;
  const maxSide = X.maxSide || MAX_SIDE;
  const minSide = X.minSide || MIN_SIDE;
  const scale = long > maxSide ? maxSide / long : long < minSide ? minSide / long : 1;
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const turned = rotation % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? h : w;
  canvas.height = turned ? w : h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  if (bmp.close) bmp.close();
  flatten(ctx, canvas.width, canvas.height, X);
  return canvas;
}

function flatten(ctx, W, H, X = {}) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const n = W * H;
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  // A light blur first takes the edge off sensor grain in a dim photo.
  const soften = X.denoise ?? 1;
  if (soften) gray.set(boxBlur(gray, W, H, soften));

  // Background = local brightness, from a small copy of the page where the
  // text is blurred away (max then mean, so ink doesn't darken the paper).
  const f = Math.max(4, Math.round(Math.max(W, H) / 160));
  const sw = Math.ceil(W / f);
  const sh = Math.ceil(H / f);
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let m = 0;
      const y1 = Math.min(H, (y + 1) * f);
      const x1 = Math.min(W, (x + 1) * f);
      for (let yy = y * f; yy < y1; yy++) {
        const row = yy * W;
        for (let xx = x * f; xx < x1; xx++) if (gray[row + xx] > m) m = gray[row + xx];
      }
      small[y * sw + x] = m;
    }
  }
  const bg = boxBlur(maxFilter(small, sw, sh, 2), sw, sh, 4);
  const outside = surroundings(gray, W, H, f, sw, sh, small);

  // Gray / background -> 0..1 (1 = paper). Pick black and white points from
  // the histogram so faint print and grey paper both end up crisp.
  const ratio = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, y / f - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, x / f - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = bg[y0 * sw + x0];
      const b = bg[y0 * sw + x0 + 1];
      const c = bg[(y0 + 1) * sw + x0];
      const e = bg[(y0 + 1) * sw + x0 + 1];
      const back = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
      const r = Math.min(1, gray[y * W + x] / Math.max(back, 24));
      ratio[y * W + x] = r;
      if (!outside[Math.floor(y / f) * sw + Math.floor(x / f)]) hist[Math.round(r * 255)]++;
    }
  }
  let counted = 0;
  for (let v = 0; v < 256; v++) counted += hist[v];
  let acc = 0;
  let black = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= counted * 0.01) { black = v / 255; break; }
  }
  black = Math.min(black, 0.55);
  // White point: just under where most of the paper sits, so the grain of
  // a dim photo turns pure white. Left grey, Tesseract can take a whole
  // page of speckle for a picture and skip it.
  let seen = 0;
  let median = 1;
  for (let v = 255; v >= 0; v--) {
    seen += hist[v];
    if (seen >= counted * 0.5) { median = v / 255; break; }
  }
  // Spread of the paper's brightness, from the half of the paper that's
  // darker than the median (ink is a small share of a page).
  let below = 0;
  let spread = 0.03;
  for (let v = Math.round(median * 255); v >= 0; v--) {
    below += hist[v];
    if (below >= counted * 0.25) { spread = Math.max(0.01, median - v / 255); break; }
  }
  const white = X.white || Math.min(0.95, Math.max(0.6, median - 1.5 * spread));
  const span = Math.max(0.2, white - black);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (outside[Math.floor(i / W / f) * sw + Math.floor((i % W) / f)]) {
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = 255;
      continue;
    }
    let v = (ratio[i] - black) / span;
    v = v <= 0 ? 0 : v >= 1 ? 1 : v;
    const o = Math.round(255 * v);
    d[j] = d[j + 1] = d[j + 2] = o;
    d[j + 3] = 255;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(img, 0, 0);
}

// The table or bedspread around the page: dark cells (well below the
// paper's brightness) reached from the photo's edge, grown a little so the
// paper's own edge goes too. Painted white, it can't be read as letters.
// Text never sits there, so getting this slightly wrong costs nothing.
function surroundings(gray, W, H, f, sw, sh, paperMax) {
  const mean = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let s = 0; let c = 0;
      for (let yy = y * f; yy < Math.min(H, (y + 1) * f); yy++) {
        for (let xx = x * f; xx < Math.min(W, (x + 1) * f); xx++) {
          s += gray[yy * W + xx];
          c++;
        }
      }
      mean[y * sw + x] = s / c;
    }
  }
  const sorted = Float32Array.from(paperMax).sort();
  const paper = sorted[Math.floor(sorted.length * 0.9)];
  // Averaged over a cell, a table or bedspread is one even dark tone: a
  // sharp peak at the dark end of the histogram. Flood in from the photo's
  // edge over cells near that tone. Paper in shadow is still well above it,
  // so it and its print are left alone.
  const hist = new Float32Array(256);
  for (let i = 0; i < mean.length; i++) hist[Math.min(255, Math.round(mean[i]))]++;
  let peak = -1;
  let best = 0;
  for (let v = 2; v < Math.min(253, paper * 0.5); v++) {
    const h = hist[v - 2] + hist[v - 1] + hist[v] + hist[v + 1] + hist[v + 2];
    if (h > best) { best = h; peak = v; }
  }
  if (peak < 0) return new Uint8Array(sw * sh);
  let cluster = 0;
  for (let i = 0; i < mean.length; i++) if (Math.abs(mean[i] - peak) <= peak * 0.3 + 3) cluster++;
  if (cluster < mean.length * 0.04) return new Uint8Array(sw * sh);
  const limit = Math.min(peak * 1.5 + 4, paper * 0.45);
  const dark = (i) => mean[i] < limit;
  const out = new Uint8Array(sw * sh);
  const stack = [];
  for (let x = 0; x < sw; x++) stack.push(x, (sh - 1) * sw + x);
  for (let y = 0; y < sh; y++) stack.push(y * sw, y * sw + sw - 1);
  let count = 0;
  while (stack.length) {
    const i = stack.pop();
    if (out[i] || !dark(i)) continue;
    out[i] = 1;
    count++;
    const x = i % sw;
    const y = (i - x) / sw;
    if (x > 0) stack.push(i - 1);
    if (x < sw - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - sw);
    if (y < sh - 1) stack.push(i + sw);
  }
  if (!count || count > sw * sh * 0.85) return new Uint8Array(sw * sh);
  // Grow by two cells to take the paper's edge and its shadow.
  let grown = out;
  for (let k = 0; k < 2; k++) {
    const next = Uint8Array.from(grown);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (grown[y * sw + x]) continue;
        if ((x > 0 && grown[y * sw + x - 1]) || (x < sw - 1 && grown[y * sw + x + 1]) ||
            (y > 0 && grown[(y - 1) * sw + x]) || (y < sh - 1 && grown[(y + 1) * sw + x])) next[y * sw + x] = 1;
      }
    }
    grown = next;
  }
  return grown;
}

function maxFilter(src, w, h, r) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const v = src[yy * w + xx];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0; let c = 0;
      for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += src[y * w + xx]; c++; }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0; let c = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) { s += tmp[yy * w + x]; c++; }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

// ---------- Reading one page ----------
async function readOne(worker, canvas) {
  const { data } = await worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true, hocr: false, tsv: false });
  return cleanPage({ width: canvas.width, height: canvas.height, blocks: data.blocks || [] });
}

const score = (r) => r.words * r.confidence;
const weak = (r) => r.words < 30 || r.confidence < 60;

// Tesseract sometimes finds nothing on a page it reads perfectly with the
// contrast set a touch differently (it takes the page for a picture, or
// misjudges the tilt). So a weak read is tried again with firmer clean-up,
// and then, if still weak, the other ways round. The best read wins.
const CLEANUPS = [{}, { white: 0.82 }, { white: 0.78, denoise: 2 }];

async function readPage(page) {
  const worker = await loadWorker();
  const base = page.rotation;
  let best = null;
  const attempt = async (rot, cleanup) => {
    const canvas = await preparePhoto(page.file, rot, cleanup);
    const r = await readOne(worker, canvas);
    if (!best || score(r) > score(best) * 1.15) {
      best = r;
      page.rotation = rot;
    }
    return r;
  };
  for (const c of CLEANUPS) {
    await attempt(base, c);
    if (!weak(best)) return best;
  }
  // Still very little readable text: the photo is probably sideways or
  // upside down (unless the reader turned it themselves).
  if (!page.userRotated) {
    for (const turn of [90, 270, 180]) {
      for (const c of CLEANUPS.slice(0, 2)) {
        const r = await attempt((base + turn) % 360, c);
        if (!weak(r)) break;
      }
      if (!weak(best) && best.confidence > 80) break;
    }
  }
  return best;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const page = pages.find((p) => p.status === "queued");
      if (!page) break;
      page.status = "reading";
      progress = 0;
      render();
      try {
        const r = await readPage(page);
        if (page.status !== "reading") continue; // removed or re-queued meanwhile
        Object.assign(page, {
          status: "done",
          text: r.text,
          head: r.head,
          pageNumber: r.pageNumber,
          confidence: r.confidence,
          words: r.words,
          edited: false,
        });
      } catch (e) {
        if (page.status === "reading") {
          page.status = "error";
          page.error = /fetch|network|failed to load|import/i.test(e.message || "")
            ? "Could not load the text reader. Check your connection and try again."
            : e.message || "Could not read this photo";
        }
      }
      render();
    }
  } finally {
    running = false;
    setNote("");
    render();
  }
}

// ---------- Adding pages ----------
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function addPhotos(fileList) {
  const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name));
  if (!files.length) return 0;
  // Phones name photos in the order they were taken (IMG_0412, IMG_0413…).
  files.sort((a, b) => natural.compare(a.name, b.name) || a.lastModified - b.lastModified);
  for (const file of files) {
    pages.push({ id: nextId++, file, url: URL.createObjectURL(file), rotation: 0, status: "queued", text: "", confidence: 0, words: 0 });
  }
  render();
  pump();
  return files.length;
}

// ---------- UI ----------
export function initScanner(options) {
  opts = options;
  els = {
    dialog: $("scanDialog"),
    close: $("scanClose"),
    take: $("scanTake"),
    choose: $("scanChoose"),
    camera: $("scanCamera"),
    picker: $("scanPicker"),
    list: $("scanList"),
    empty: $("scanEmpty"),
    note: $("scanNote"),
    bar: $("scanBar"),
    progress: $("scanProgress"),
    order: $("scanOrder"),
    orderBtn: $("scanOrderBtn"),
    title: $("scanTitle"),
    author: $("scanAuthor"),
    save: $("scanSave"),
    discard: $("scanDiscard"),
    error: $("scanError"),
  };
  els.take.addEventListener("click", () => els.camera.click());
  els.choose.addEventListener("click", () => els.picker.click());
  for (const input of [els.camera, els.picker]) {
    input.addEventListener("change", (e) => {
      addPhotos(e.target.files);
      e.target.value = "";
    });
  }
  els.close.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (e) => { if (e.target === els.dialog) els.dialog.close(); });
  els.orderBtn.addEventListener("click", () => {
    const order = suggestOrder(pages.map((p) => ({ pageNumber: p.status === "done" ? p.pageNumber : null })));
    if (!order) return;
    const copy = order.map((i) => pages[i]);
    pages.splice(0, pages.length, ...copy);
    render();
  });
  els.discard.addEventListener("click", () => {
    if (pages.length && !window.confirm("Remove all the pages you've added?")) return;
    reset();
  });
  els.save.addEventListener("click", save);
  els.title.addEventListener("input", renderFooter);
  els.list.addEventListener("click", onListClick);
  els.list.addEventListener("input", (e) => {
    const ta = e.target.closest("textarea[data-id]");
    if (!ta) return;
    const page = pages.find((p) => p.id === Number(ta.dataset.id));
    if (page) {
      page.text = ta.value;
      page.edited = true;
      renderFooter();
    }
  });
  // Typing pauses list updates; catch up once the text box is left.
  els.list.addEventListener("focusout", (e) => {
    if (e.target.matches("textarea[data-id]")) setTimeout(render, 0);
  });
  // Drag a page to a new place (desktop); phones use the arrows.
  let dragId = null;
  els.list.addEventListener("dragstart", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    dragId = Number(li.dataset.id);
    e.dataTransfer.effectAllowed = "move";
  });
  els.list.addEventListener("dragover", (e) => { if (dragId) e.preventDefault(); });
  els.list.addEventListener("drop", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!dragId || !li) return;
    e.preventDefault();
    const from = pages.findIndex((p) => p.id === dragId);
    const to = pages.findIndex((p) => p.id === Number(li.dataset.id));
    dragId = null;
    if (from < 0 || to < 0 || from === to) return;
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
    render();
  });
  els.list.addEventListener("dragend", () => { dragId = null; });
  // Drop photos onto the open scanner.
  els.dialog.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  els.dialog.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addPhotos(e.dataTransfer.files);
  });
  render();
}

export function openScanner(files) {
  if (!els.title.value) els.title.value = defaultTitle();
  if (typeof els.dialog.showModal === "function") { if (!els.dialog.open) els.dialog.showModal(); }
  else els.dialog.setAttribute("open", "");
  if (files && files.length) addPhotos(files);
  // Start fetching the OCR engine now so the first page doesn't wait.
  loadWorker().catch(() => {});
  render();
}

function defaultTitle() {
  const d = new Date();
  return `Scanned pages, ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function reset() {
  for (const p of pages) URL.revokeObjectURL(p.url);
  pages.length = 0;
  els.title.value = defaultTitle();
  els.author.value = "";
  els.error.hidden = true;
  render();
}

function onListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = Number(btn.closest("li[data-id]").dataset.id);
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const page = pages[i];
  const act = btn.dataset.act;
  if (act === "up" && i > 0) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
  else if (act === "down" && i < pages.length - 1) [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
  else if (act === "remove") {
    URL.revokeObjectURL(page.url);
    page.status = "removed";
    pages.splice(i, 1);
  } else if (act === "rotate" || act === "retry") {
    if (act === "rotate") {
      page.rotation = (page.rotation + 90) % 360;
      page.userRotated = true;
    }
    page.status = "queued";
    page.error = null;
    pump();
  } else return;
  render();
  // Keep focus on the same control after the list re-renders.
  const again = els.list.querySelector(`li[data-id="${id}"] button[data-act="${act}"]`);
  if (again) again.focus();
}

function setNote(msg) {
  if (els && els.note) {
    els.note.textContent = msg;
    els.note.hidden = !msg;
  }
}

function renderProgress() {
  if (!els) return;
  const total = pages.length;
  const done = pages.filter((p) => p.status === "done" || p.status === "error").length;
  const busy = pages.some((p) => p.status === "reading" || p.status === "queued");
  els.progress.hidden = !busy;
  if (busy) {
    const i = pages.findIndex((p) => p.status === "reading");
    els.bar.style.width = `${Math.round(((done + progress) / Math.max(total, 1)) * 100)}%`;
    els.progress.querySelector("span.scan-progress-label").textContent =
      i >= 0 ? `Reading page ${i + 1} of ${total}${progress ? ` · ${Math.round(progress * 100)}%` : ""}` : "Getting ready…";
    if (i >= 0) setNote("");
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusHtml(p) {
  if (p.status === "queued") return `<span class="scan-state">Waiting</span>`;
  if (p.status === "reading") return `<span class="scan-state scan-state-busy">Reading…</span>`;
  if (p.status === "error") return `<span class="scan-state scan-state-err">${esc(p.error)}</span>`;
  if (!p.text.trim()) return `<span class="scan-state scan-state-err">No text found. Try rotating, or retake it closer.</span>`;
  const low = p.confidence < LOW_CONFIDENCE && !p.edited;
  const words = p.text.split(/\s+/).filter(Boolean).length;
  return `<span class="scan-state ${low ? "scan-state-warn" : "scan-state-ok"}">${low ? "Check this page" : "Ready"} · ${words} words${p.pageNumber != null ? ` · printed page ${p.pageNumber}` : ""}</span>`;
}

function render() {
  if (!els) return;
  els.empty.hidden = pages.length > 0;
  els.list.hidden = pages.length === 0;
  // Keep open text boxes open across re-renders.
  const open = new Set([...els.list.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  const active = document.activeElement && document.activeElement.closest && document.activeElement.closest("textarea[data-id]");
  if (active) return renderFooter(); // don't rebuild under someone typing
  els.list.innerHTML = pages.map((p, i) => {
    const low = p.status === "done" && p.confidence < LOW_CONFIDENCE && !p.edited;
    return `<li class="scan-page" data-id="${p.id}" draggable="true">
      <div class="scan-thumb"><img src="${p.url}" alt="" style="transform: rotate(${p.rotation}deg)" loading="lazy" /></div>
      <div class="scan-body">
        <div class="scan-row">
          <strong class="scan-num">Page ${i + 1}</strong>
          ${statusHtml(p)}
        </div>
        <div class="scan-actions">
          <button type="button" class="btn-icon-round" data-act="up" aria-label="Move page ${i + 1} earlier" ${i === 0 ? "disabled" : ""}><svg width="18" height="18" aria-hidden="true"><use href="#i-up"/></svg></button>
          <button type="button" class="btn-icon-round" data-act="down" aria-label="Move page ${i + 1} later" ${i === pages.length - 1 ? "disabled" : ""}><svg width="18" height="18" aria-hidden="true"><use href="#i-down"/></svg></button>
          <button type="button" class="btn-icon-round" data-act="rotate" aria-label="Turn page ${i + 1} a quarter turn and read it again" ${p.status === "reading" ? "disabled" : ""}><svg width="18" height="18" aria-hidden="true"><use href="#i-rotate"/></svg></button>
          ${p.status === "error" ? `<button type="button" class="btn btn-ghost btn-small" data-act="retry">Try again</button>` : ""}
          <button type="button" class="btn-icon-round" data-act="remove" aria-label="Remove page ${i + 1}"><svg width="18" height="18" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </div>
      </div>
      ${p.status === "done" ? `<details class="scan-text" data-id="${p.id}" ${open.has(String(p.id)) || low ? "open" : ""}>
        <summary>${low ? "Some words may be wrong. Read it over and fix anything." : "See or fix the text"}</summary>
        <textarea class="field-control" data-id="${p.id}" rows="8" aria-label="Text of page ${i + 1}">${esc(p.text)}</textarea>
      </details>` : ""}
    </li>`;
  }).join("");
  renderProgress();
  renderFooter();
}

function renderFooter() {
  const ready = pages.filter((p) => p.status === "done" && p.text.trim());
  const busy = pages.some((p) => p.status === "reading" || p.status === "queued");
  const order = !busy && suggestOrder(pages.map((p) => ({ pageNumber: p.status === "done" ? p.pageNumber : null })));
  els.order.hidden = !order;
  els.save.disabled = saving || busy || !ready.length || !els.title.value.trim();
  els.save.querySelector("span").textContent = saving
    ? "Saving…"
    : busy ? "Reading pages…" : `Make book${ready.length ? ` (${ready.length} page${ready.length === 1 ? "" : "s"})` : ""}`;
  els.discard.hidden = !pages.length;
}

async function save() {
  const title = els.title.value.trim();
  const author = els.author.value.trim();
  const ready = pages.filter((p) => p.status === "done" && p.text.trim());
  if (!title || !ready.length) return;
  saving = true;
  els.error.hidden = true;
  renderFooter();
  try {
    if (typeof JSZip === "undefined") throw new Error("reload the page and try again");
    const book = finishBook(ready.map((p) => ({ text: p.text, head: p.edited ? null : p.head, pageNumber: p.pageNumber })), { title });
    if (!book.length) throw new Error("no text to save");
    const blob = await buildEpub(JSZip, { title, author, pages: book });
    const safe = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Scanned book";
    const file = new File([blob], `${safe}.epub`, { type: "application/epub+zip" });
    await opts.saveBook(file, { title, author });
    reset();
    els.dialog.close();
  } catch (e) {
    els.error.textContent = `Could not save the book: ${e.message}`;
    els.error.hidden = false;
  } finally {
    saving = false;
    renderFooter();
  }
}

// For tests.
export const _pages = pages;
