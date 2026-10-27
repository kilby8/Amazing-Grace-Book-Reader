// Recorded-shape answers from Project Gutenberg and the Internet Archive,
// so the book finder can be tested without the network. Shapes match the
// live services as of 2026-10-27 (OPDS search feed, advancedsearch JSON,
// /metadata JSON, download redirects).
//
// test-finder.mjs uses fakeFetch directly, and starts the server with
// `node -r ./test-finder-fixtures.cjs` and FINDER_FAKE=1, which swaps the
// server's fetch for this one.

const zlib = require("node:zlib");

// ----- a tiny but real EPUB (stored zip) -----
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6);
    head.writeUInt16LE(0, 8); head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    local.push(head, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8); c.writeUInt16LE(0, 10); c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const CHAPTER = (n, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head>
<body><h1>Chapter ${n}</h1><p>${body}</p></body></html>`;

const EPUB = zip([
  ["mimetype", "application/epub+zip"],
  ["META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
  ["OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">pg2701</dc:identifier><dc:title>Moby Dick; Or, The Whale</dc:title><dc:creator>Herman Melville</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`],
  ["OEBPS/c1.xhtml", CHAPTER(1, "Call me Ishmael. Some years ago, never mind how long precisely, having little or no money in my purse, I thought I would sail about a little and see the watery part of the world.")],
  ["OEBPS/c2.xhtml", CHAPTER(2, "I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, and started for Cape Horn and the Pacific.")],
]);

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

// ----- Project Gutenberg OPDS search -----
function opdsEntry(n, title, author) {
  return `<entry>
<updated>2026-10-27T04:08:04Z</updated>
<id>https://www.gutenberg.org/ebooks/${n}.opds</id>
<title>${title}</title>
<content type="text">${author}</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/${n}.opds"/>
<link type="image/png" rel="http://opds-spec.org/image/thumbnail" href="data:image/png;base64,iVBORw0KGgo="/>
</entry>`;
}
function opds(entries) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>http://www.gutenberg.org/ebooks/search.opds/</id>
<title>Books</title>
<entry>
<updated>2026-10-27T04:08:04Z</updated>
<id>https://www.gutenberg.org/ebooks/search.opds/?sort_order=title</id>
<title>Sort Alphabetically by Title</title>
<content type="text">Sort Alphabetically by Title</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/search.opds/?sort_order=title"/>
</entry>
${entries.join("\n")}
</feed>`;
}

// ----- Internet Archive -----
const IA_ITEMS = {
  mobydickorwhale01melvuoft: {
    doc: { identifier: "mobydickorwhale01melvuoft", title: "Moby-Dick; or, The whale", creator: "Melville, Herman, 1819-1891", year: "1922", downloads: 136525 },
    metadata: { title: "Moby-Dick; or, The whale", collection: ["robarts", "toronto"] },
    files: [
      { name: "mobydickorwhale01melvuoft.epub", format: "EPUB", size: "1433807" },
      { name: "mobydickorwhale01melvuoft.pdf", format: "Text PDF", size: "29450706" },
    ],
  },
  mobydickorwhale02melvuoft: {
    doc: { identifier: "mobydickorwhale02melvuoft", title: "Moby-Dick; or, The whale", creator: "Melville, Herman, 1819-1891", year: "1922", downloads: 60000, volume: "2" },
    metadata: { title: "Moby-Dick; or, The whale", collection: ["robarts", "toronto"] },
    files: [{ name: "mobydickorwhale02melvuoft.pdf", format: "Text PDF", size: "30554694" }],
  },
  mobydick00melv_1: {
    doc: { identifier: "mobydick00melv_1", title: "Moby Dick;", creator: "Melville, Herman, 1819-1891", year: "1851", downloads: 32321 },
    metadata: { title: "Moby Dick;", collection: ["americana"] },
    files: [{ name: "mobydick00melv_1.pdf", format: "Text PDF", size: "20000000" }],
  },
  mobydicklending0000melv: {
    doc: { identifier: "mobydicklending0000melv", title: "Moby Dick (Illustrated Classics)", creator: "Melville, Herman", year: "1990", downloads: 9000 },
    metadata: { title: "Moby Dick (Illustrated Classics)", collection: ["inlibrary", "printdisabled"] },
    files: [{ name: "mobydicklending0000melv.pdf", format: "Text PDF", size: "9000000", private: "true" }],
  },
  whalinghugescan: {
    doc: { identifier: "whalinghugescan", title: "The Whale and its Captors", creator: "Cheever, Henry T.", year: "1850", downloads: 800 },
    metadata: { title: "The Whale and its Captors", collection: ["americana"] },
    files: [
      { name: "whalinghugescan.pdf", format: "Text PDF", size: String(80 * 1024 * 1024) },
      { name: "whalinghugescan.epub", format: "EPUB", size: "900000" },
    ],
  },
  sneakyredirect: {
    doc: { identifier: "sneakyredirect", title: "Moby Dick Redirected", creator: "Nobody", downloads: 1 },
    metadata: { title: "Moby Dick Redirected", collection: ["americana"] },
    files: [{ name: "sneakyredirect.pdf", format: "Text PDF", size: "1000" }],
  },
  flakymirror: {
    doc: { identifier: "flakymirror", title: "Moby Dick Flaky Mirror", creator: "Nobody", downloads: 1 },
    metadata: { title: "Moby Dick Flaky Mirror", collection: ["americana"] },
    files: [{ name: "flakymirror.pdf", format: "Text PDF", size: "1000" }],
  },
  notapdf: {
    doc: { identifier: "notapdf", title: "Moby Dick Not A PDF", creator: "Nobody", downloads: 1 },
    metadata: { title: "Moby Dick Not A PDF", collection: ["americana"] },
    files: [{ name: "notapdf.pdf", format: "Text PDF", size: "1000" }],
  },
};

const seen = []; // every URL fakeFetch was asked for

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

async function fakeFetch(input, opts = {}) {
  const url = new URL(String(input));
  seen.push(url.toString());
  const host = url.hostname;

  if (host === "www.gutenberg.org") {
    if (url.pathname === "/ebooks/search.opds/") {
      const q = (url.searchParams.get("query") || "").toLowerCase();
      if (q.includes("boom")) return new Response("Server error", { status: 500 });
      if (q.includes("moby") || q.includes("whale")) {
        return new Response(opds([
          opdsEntry(2701, "Moby Dick; Or, The Whale", "Herman Melville"),
          opdsEntry(2489, "Moby-Dick; or, The Whale", "Herman Melville"),
          opdsEntry(15, "Moby-Dick &amp; Other Tales", "Herman Melville"),
          opdsEntry(20000, "The treasury of David, Volume 1 (of 6), Psalm 1-26 : Containing an original exposition of the book of Psalms; a collection of illustrative extracts", "C. H. Spurgeon"),
          opdsEntry(21816, "The Confidence-Man: His Masquerade", "Herman Melville"),
        ]), { headers: { "Content-Type": "application/atom+xml" } });
      }
      return new Response(opds([]), { headers: { "Content-Type": "application/atom+xml" } });
    }
    let m = /^\/ebooks\/(\d+)\.epub3\.images$/.exec(url.pathname);
    if (m) return m[1] === "15" ? new Response("Not found", { status: 404 }) : redirect(`/cache/epub/${m[1]}/pg${m[1]}-images-3.epub`);
    m = /^\/ebooks\/(\d+)\.epub\.images$/.exec(url.pathname);
    if (m) return redirect(`https://www.gutenberg.org/cache/epub/${m[1]}/pg${m[1]}-images.epub`);
    if (/^\/cache\/epub\/\d+\/pg\d+-images(-3)?\.epub$/.test(url.pathname)) {
      return new Response(EPUB, { headers: { "Content-Type": "application/epub+zip", "Content-Length": String(EPUB.length) } });
    }
    return new Response("Not found", { status: 404 });
  }

  if (host === "archive.org") {
    if (url.pathname === "/advancedsearch.php") {
      const q = url.searchParams.get("q") || "";
      const docs = /moby|whale|boom/i.test(q) ? Object.values(IA_ITEMS).map((i) => i.doc) : [];
      return json({ responseHeader: { status: 0 }, response: { numFound: docs.length, start: 0, docs } });
    }
    let m = /^\/metadata\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const item = IA_ITEMS[decodeURIComponent(m[1])];
      return item ? json({ metadata: item.metadata, files: item.files }) : json({});
    }
    m = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id === "sneakyredirect") return redirect("http://169.254.169.254/latest/meta-data/");
      if (!IA_ITEMS[id]) return new Response("Not found", { status: 404 });
      return redirect(`https://ia800100.us.archive.org/1/items/${id}/${m[2]}`);
    }
    return new Response("Not found", { status: 404 });
  }

  if (/\.us\.archive\.org$/.test(host)) {
    const m = /^\/1\/items\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m && m[1] === "flakymirror" && !fakeFetch.flaked) {
      fakeFetch.flaked = true;
      throw new TypeError("fetch failed");
    }
    if (m && m[1] === "notapdf") return new Response("<html>Please log in</html>", { headers: { "Content-Type": "text/html" } });
    if (m && m[2].endsWith(".pdf")) return new Response(PDF, { headers: { "Content-Type": "application/pdf" } });
    if (m && m[2].endsWith(".epub")) return new Response(EPUB, { headers: { "Content-Type": "application/epub+zip" } });
    return new Response("Not found", { status: 404 });
  }

  throw new TypeError(`fetch failed: test fixtures don't know ${url.hostname}`);
}

module.exports = { fakeFetch, seen, EPUB, PDF, IA_ITEMS };

// Preloaded into the server for the end-to-end checks: outside requests
// get the fixtures, everything else (Supabase is unused here) is refused.
if (process.env.FINDER_FAKE === "1") {
  globalThis.fetch = fakeFetch;
}
