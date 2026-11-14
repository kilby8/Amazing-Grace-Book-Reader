// Photos of book pages -> clean text -> an EPUB the reader already plays.
// Pure functions, no DOM: the browser scanner (scan.js) and the Node tests
// (test-scan.mjs) both use them. See SCAN.md.
//
//   cleanPage(ocr)          one page's OCR lines -> { text, pageNumber, confidence, head }
//   finishBook(pages)       drop running heads, mend words split across pages
//   buildEpub(JSZip, book)  -> Promise<Blob> (EPUB 3, one spine item per page)

// Words the OCR is less sure of than this get the page flagged for a look.
export const LOW_CONFIDENCE = 72;

const PAGE_NUMBER = /^[\[(]?(\d{1,4}|[ivxlcdm]{1,7})[\])]?$/i;
// "12  THE GREAT HOUSE" or "THE GREAT HOUSE  13": a running head with its number.
const HEAD_WITH_NUMBER = /^(\d{1,4})\s+(.{2,60})$|^(.{2,60}?)\s+(\d{1,4})$/;

function letters(s) {
  return (s.match(/\p{L}/gu) || []).length;
}

// OCR tidy-ups that are safe on any English text.
export function tidy(s) {
  return s
    .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff")
    .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
    .replace(/[­​]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ([,.;:!?])(?=\s|$)/g, "$1")
    // Tesseract's favourite slip: a capital I read as a bar.
    .replace(/(^|[\s“"])\|(?=[\s'’,.]|$)/g, "$1I")
    .replace(/([(\[“]) /g, "$1")
    .replace(/ ([)\]”])/g, "$1")
    .trim();
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Is this a line of noise (the edge of the facing page, a smudge, a
// thumb)? Real lines have mostly letters, or the OCR was sure of them.
function isJunk(line) {
  const t = line.text;
  const n = letters(t);
  if (!t) return true;
  if (PAGE_NUMBER.test(t)) return false;
  if (n === 0) return true;
  if (n / t.replace(/\s/g, "").length < 0.5 && line.confidence < 60) return true;
  if (line.confidence < 30 && n < 12) return true;
  return false;
}

// Specks at the edge of the paper get read as stray letters at the start
// or end of a line ("i  the ground with a patience ... as  4"). Drop short,
// unsure words at either end that aren't real one- or two-letter words.
const SHORT_WORDS = new Set(["a", "i", "o", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it", "me", "my", "no", "of", "oh", "on", "or", "so", "to", "up", "us", "we", "ah", "am", "ay", "eh", "ha", "ho", "lo", "ye", "&"]);
function edgeJunk(w) {
  const t = String(w.text || "").trim();
  if (!t) return true;
  const bare = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!bare) return !/^["“”'‘’(\[—–-]+$/.test(t) || w.confidence < 50;
  if (bare.length > 2) return false;
  if (/^\d+$/.test(bare)) return w.confidence < 60;
  return !SHORT_WORDS.has(bare.toLowerCase()) && w.confidence < 75;
}
function trimEdgeJunk(line) {
  const ws = Array.isArray(line.words) ? line.words.filter((w) => String(w.text || "").trim()) : null;
  if (!ws || !ws.length) return String(line.text || "").replace(/\s+/g, " ");
  let a = 0;
  let b = ws.length;
  // Only trim when the word is set apart from its neighbour by a gap wider
  // than normal word spacing, or is plainly unsure.
  const gap = (i, j) => Math.abs((ws[j].bbox ? ws[j].bbox.x0 : 0) - (ws[i].bbox ? ws[i].bbox.x1 : 0));
  const h = ws[0].bbox ? Math.max(8, ws[0].bbox.y1 - ws[0].bbox.y0) : 20;
  while (b - a > 1 && edgeJunk(ws[a]) && (gap(a, a + 1) > h * 0.9 || ws[a].confidence < 40)) a++;
  while (b - a > 1 && edgeJunk(ws[b - 1]) && (gap(b - 2, b - 1) > h * 0.9 || ws[b - 1].confidence < 40)) b--;
  if (b - a === 1 && edgeJunk(ws[a]) && ws[a].confidence < 40) return "";
  return ws.slice(a, b).map((w) => String(w.text).trim()).join(" ");
}

// ocr: { width, height, blocks: [{ paragraphs: [{ lines: [{ text, confidence, bbox:{x0,y0,x1,y1} }] }] }] }
// (the shape Tesseract.js returns). Blocks are kept in Tesseract's reading
// order, which handles two pages in one photo.
export function cleanPage(ocr) {
  const width = ocr.width || 1000;
  let lines = [];
  (ocr.blocks || []).forEach((block, bi) => {
    (block.paragraphs || []).forEach((para, pi) => {
      (para.lines || []).forEach((l) => {
        lines.push({
          text: tidy(trimEdgeJunk(l)),
          confidence: Number(l.confidence) || 0,
          bbox: l.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
          block: bi,
          para: `${bi}.${pi}`,
        });
      });
    });
  });
  const dropped = [];
  lines = lines.filter((l) => {
    const junk = isJunk(l);
    if (junk && l.text) dropped.push(l.text);
    return !junk;
  });

  // Page number and running head: only at the very top or very bottom.
  let pageNumber = null;
  let head = null;
  const byY = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const lineH = median(lines.map((l) => l.bbox.y1 - l.bbox.y0)) || 20;
  const takeEdge = (l, top) => {
    if (!l) return;
    if (PAGE_NUMBER.test(l.text)) {
      if (/\d/.test(l.text)) pageNumber = pageNumber ?? Number(l.text.replace(/\D/g, ""));
      l.drop = true;
      return;
    }
    if (!top || lines.length < 4) return;
    const m = l.text.match(HEAD_WITH_NUMBER);
    // Alone on its line, clearly above the text below it.
    const next = byY[byY.indexOf(l) + 1];
    const apart = !next || next.bbox.y0 - l.bbox.y1 > lineH * 0.6 || next.para !== l.para;
    if (m && apart && l.text.length <= 70) {
      pageNumber = pageNumber ?? Number(m[1] || m[4]);
      head = (m[2] || m[3]).trim();
      l.drop = true;
    } else if (apart && l.text.length <= 60) {
      head = l.text; // maybe a running head; finishBook drops it if it repeats
      l.maybeHead = true;
    }
  };
  takeEdge(byY[0], true);
  takeEdge(byY[byY.length - 1], false);
  if (byY.length > 1 && byY[1] && !byY[0].maybeHead && byY[0].drop) takeEdge(byY[1], true);
  lines = lines.filter((l) => !l.drop);

  // Lines -> paragraphs. A new paragraph starts at a new Tesseract block or
  // paragraph, an indented first line, a short line ending a sentence, or a
  // bigger gap than usual between lines.
  // Margins are measured from nearby lines, so a photo taken at a slight
  // angle (margins drifting down the page) still reads right.
  const isLong = (l) => l.bbox.x1 - l.bbox.x0 > width * 0.25;
  const near = (i, key) => {
    const xs = [];
    for (let k = Math.max(0, i - 4); k <= Math.min(lines.length - 1, i + 4); k++) {
      if (lines[k].block === lines[i].block && isLong(lines[k])) xs.push(lines[k].bbox[key]);
    }
    return xs.length ? median(xs) : lines[i].bbox[key];
  };
  const textW = median(lines.filter(isLong).map((l) => l.bbox.x1 - l.bbox.x0)) || width * 0.6;
  const indented = lines.map((l, i) => i > 0 && lines[i - 1].block === l.block &&
    l.bbox.x0 - near(i, "x0") > textW * 0.025 && Math.abs(lines[i - 1].bbox.x0 - near(i - 1, "x0")) < textW * 0.02);
  // Most books mark a new paragraph with an indent. When this page does,
  // that's the signal to go by; Tesseract's own guesses are only used on
  // pages without indents (block paragraphs with space between).
  const usesIndent = indented.some(Boolean);
  const paras = [];
  let cur = null;
  let prev = null;
  lines.forEach((l, i) => {
    let fresh = !cur || l.block !== prev.block;
    if (!fresh) {
      const right = near(i - 1, "x1");
      const ends = /[.!?:"”’)]$/.test(prev.text);
      const indent = indented[i];
      const shortPrev = right - prev.bbox.x1 > textW * 0.1 && ends;
      const gap = l.bbox.y0 - prev.bbox.y1 > lineH * 1.1;
      // Tesseract's own breaks only count at the end of a sentence: on a
      // tilted photo it can put every line in a paragraph of its own.
      fresh = indent || shortPrev || gap || (!usesIndent && l.para !== prev.para && ends);
    }
    if (fresh) {
      cur = { lines: [], maybeHead: !!l.maybeHead };
      paras.push(cur);
    }
    cur.lines.push(l);
    prev = l;
  });
  const out = paras.map((p) => ({ text: joinLines(p.lines.map((l) => l.text)), maybeHead: p.maybeHead }));

  let chars = 0;
  let weighted = 0;
  for (const l of lines) {
    chars += l.text.length;
    weighted += l.text.length * l.confidence;
  }
  return {
    text: out.map((p) => p.text).filter(Boolean).join("\n\n"),
    head: out.length && out[0].maybeHead ? out[0].text : head,
    pageNumber,
    confidence: chars ? Math.round(weighted / chars) : 0,
    words: lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0),
    dropped,
  };
}

// Join the lines of one paragraph, mending words hyphenated at line ends.
export function joinLines(lines) {
  let s = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!s) s = line;
    else if (/\p{Ll}-$/u.test(s) && /^\p{Ll}/u.test(line)) s = s.slice(0, -1) + line;
    else if (/[—–]$/.test(s) || /^[—–]/.test(line)) s += line;
    else s += " " + line;
  }
  return tidy(s);
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}]+/gu, "");

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Two running heads match if they're nearly the same letters: OCR may
// misread a letter or catch a speck after the last word.
export function sameHead(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = Math.min(x.length, y.length);
  if (short < 5) return false;
  if (x.startsWith(y) || y.startsWith(x)) return Math.abs(x.length - y.length) <= 2;
  return editDistance(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.15));
}

// pages: [{ text, head, pageNumber }] in reading order.
// Returns [{ text, label }]: running heads that repeat (or match the book
// title) are dropped, and a word split across two pages is mended.
export function finishBook(pages, { title = "" } = {}) {
  const texts = pages.map((p) => {
    let text = String(p.text || "").replace(/\r\n?/g, "\n").trim();
    if (!p.head) return text;
    const repeats = pages.filter((q) => q !== p && sameHead(q.head, p.head)).length > 0;
    if (repeats || sameHead(p.head, title)) {
      const first = text.split("\n\n")[0];
      if (sameHead(first, p.head)) text = text.slice(first.length).trim();
    }
    return text;
  });
  for (let i = 0; i + 1 < texts.length; i++) {
    const m = texts[i].match(/(\p{L}+)-$/u);
    const n = texts[i + 1].match(/^(\p{Ll}+)([^\s]*)\s*/u);
    if (m && n) {
      texts[i] = texts[i].slice(0, -1) + n[1] + n[2];
      texts[i + 1] = texts[i + 1].slice(n[0].length);
    }
  }
  return pages.map((p, i) => ({
    text: texts[i],
    label: p.pageNumber != null ? String(p.pageNumber) : null,
  })).filter((p) => p.text);
}

// True when the pages carry page numbers that disagree with their order.
export function suggestOrder(pages) {
  if (pages.length < 2 || pages.some((p) => p.pageNumber == null)) return null;
  const order = pages.map((p, i) => i).sort((a, b) => pages[a].pageNumber - pages[b].pageNumber || a - b);
  return order.some((v, i) => v !== i) ? order : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// book: { title, author, pages: [{ text, label }] } -> EPUB Blob.
export async function buildEpub(JSZip, { title, author, pages, id }) {
  const zip = new JSZip();
  const uid = id || `urn:uuid:${(globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now()}`;
  const pad = (i) => String(i + 1).padStart(4, "0");
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  const items = [];
  const spine = [];
  const toc = [];
  const pageList = [];
  pages.forEach((p, i) => {
    const name = `page-${pad(i)}.xhtml`;
    const label = p.label || String(i + 1);
    const body = String(p.text).split(/\n\s*\n/).map((para) => para.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)
      .map((para) => `    <p>${esc(para)}</p>`).join("\n");
    zip.file(`OEBPS/${name}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Page ${esc(label)}</title></head>
  <body>
    <section id="p${pad(i)}" epub:type="bodymatter">
    <span epub:type="pagebreak" id="pg${pad(i)}" title="${esc(label)}"></span>
${body}
    </section>
  </body>
</html>`);
    items.push(`    <item id="p${pad(i)}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="p${pad(i)}"/>`);
    toc.push(`        <li><a href="${name}">Page ${esc(label)}</a></li>`);
    pageList.push(`        <li><a href="${name}#pg${pad(i)}">${esc(label)}</a></li>`);
  });
  zip.file("OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>${esc(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc"><h1>${esc(title)}</h1>
      <ol>
${toc.join("\n")}
      </ol>
    </nav>
    <nav epub:type="page-list" hidden="">
      <ol>
${pageList.join("\n")}
      </ol>
    </nav>
  </body>
</html>`);
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  zip.file("OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(uid)}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
${author ? `    <dc:creator>${esc(author)}</dc:creator>\n` : ""}    <dc:language>en</dc:language>
    <dc:source>Scanned from photos of printed pages</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${items.join("\n")}
  </manifest>
  <spine>
${spine.join("\n")}
  </spine>
</package>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE" });
}
