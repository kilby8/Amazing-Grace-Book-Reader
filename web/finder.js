// Book finder: searches free, legal book sources (Project Gutenberg and
// the Internet Archive's public-domain texts) and downloads a chosen
// result so the server can put it in the reader's library. See FINDER.md.
//
// The browser only ever sends a result id ("gutenberg:2701",
// "ia:mobydickorwhale01melvuoft"). The URL to fetch is built here from that
// id, and redirects are only followed to the sources' own hosts, so the
// finder can't be pointed at arbitrary URLs.

const USER_AGENT = "AmazingGraceReader/1.0 (book finder; +https://amazing-grace-reader.vercel.app)";
const SEARCH_TIMEOUT_MS = 9000;
const META_TIMEOUT_MS = 4000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 100;
const MAX_QUERY = 120;
const PER_SOURCE = 12;

const ALLOWED_HOSTS = [/^(www\.)?gutenberg\.org$/, /^(.+\.)?archive\.org$/];

const SOURCES = {
  gutenberg: { name: "Project Gutenberg", home: "https://www.gutenberg.org" },
  ia: { name: "Internet Archive", home: "https://archive.org" },
};

const ID_PATTERNS = {
  gutenberg: /^\d{1,7}$/,
  ia: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
};

// Internet Archive collections whose books can only be borrowed.
const IA_LENDING = ["inlibrary", "printdisabled", "lendinglibrary", "internetarchivebooks"];

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function words(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "by", "in", "to"]);

// How well a result's title and author cover the query, 0..1.
function matchScore(query, title, author) {
  const q = words(query).filter((w) => !STOP.has(w));
  if (q.length === 0) return 0;
  const have = new Set([...words(title), ...words(author)]);
  return q.filter((w) => have.has(w)).length / q.length;
}

// "Moby-Dick; or, The whale" and "Moby Dick" are the same book.
function bookKey(title, author) {
  const t = words(String(title || "").split(/[;:(]/)[0]).filter((w) => !STOP.has(w)).join(" ");
  const a = words(author).sort().slice(0, 2).join(" ");
  return `${t}|${a}`;
}

// IA creators look like "Melville, Herman, 1819-1891".
function tidyAuthor(a) {
  if (Array.isArray(a)) a = a[0];
  if (!a) return "";
  let s = String(a).replace(/,?\s*\d{3,4}\s*-\s*(\d{3,4})?\.?$/, "").trim();
  const parts = s.split(/,\s*/);
  if (parts.length === 2 && !/\s/.test(parts[0])) s = `${parts[1]} ${parts[0]}`;
  return s.replace(/\s+/g, " ").trim();
}

function tidyTitle(t) {
  if (Array.isArray(t)) t = t[0];
  return String(t || "").replace(/\s+/g, " ").replace(/[\s;:,/.]+$/, "").trim() || "Untitled";
}

function cleanQuery(q) {
  return String(q || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
}

function parseId(id) {
  const m = /^([a-z]+):(.+)$/.exec(String(id || ""));
  if (!m || !ID_PATTERNS[m[1]] || !ID_PATTERNS[m[1]].test(m[2])) return null;
  return { source: m[1], key: m[2] };
}

function isAllowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(url.hostname));
  } catch (_) {
    return false;
  }
}

function createFinder({ fetchImpl = globalThis.fetch, maxBytes = 50 * 1024 * 1024 } = {}) {
  const cache = new Map();

  async function get(url, { timeout = SEARCH_TIMEOUT_MS, accept } = {}) {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, ...(accept ? { Accept: accept } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
    return res;
  }

  // ----- Project Gutenberg -----
  async function searchGutenberg(q) {
    const url = `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}`;
    const xml = await (await get(url, { accept: "application/atom+xml" })).text();
    const out = [];
    for (const entry of xml.split(/<entry>/).slice(1)) {
      const id = /<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/.exec(entry);
      if (!id) continue; // navigation entries ("sort by", "next page")
      const title = /<title>([\s\S]*?)<\/title>/.exec(entry);
      const author = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry);
      const n = id[1];
      out.push({
        id: `gutenberg:${n}`,
        source: "gutenberg",
        sourceName: SOURCES.gutenberg.name,
        title: tidyTitle(decodeXml(title && title[1])),
        author: decodeXml(author && author[1]),
        year: null,
        kind: "epub",
        size: null,
        cover: `https://www.gutenberg.org/cache/epub/${n}/pg${n}.cover.medium.jpg`,
        pageUrl: `https://www.gutenberg.org/ebooks/${n}`,
        rank: out.length,
      });
      if (out.length >= PER_SOURCE) break;
    }
    return out;
  }

  // ----- Internet Archive -----
  function iaTerms(q) {
    // Keep words only: no Lucene syntax from the user reaches the query.
    return words(q).filter((w) => !STOP.has(w) || words(q).length === 1).slice(0, 12).join(" ");
  }

  async function iaFiles(identifier) {
    const res = await get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { timeout: META_TIMEOUT_MS });
    const j = await res.json();
    if (!j || !j.metadata) throw new Error("Internet Archive item not found");
    const md = j.metadata;
    const collections = [].concat(md.collection || []);
    const restricted = String(md["access-restricted-item"] || "").toLowerCase() === "true";
    if (restricted || collections.some((c) => IA_LENDING.includes(c))) {
      throw new Error("That Internet Archive book can only be borrowed, not downloaded");
    }
    const files = (j.files || []).filter((f) => f.private !== "true" && f.private !== true);
    const size = (f) => Number(f.size) || 0;
    const fits = (f) => size(f) > 0 && size(f) <= maxBytes;
    const pdf = files.find((f) => f.format === "Text PDF" && fits(f))
      || files.find((f) => /\.pdf$/i.test(f.name) && /pdf/i.test(f.format || "") && fits(f));
    const epub = files.find((f) => /\.epub$/i.test(f.name) && fits(f));
    const pick = pdf || epub;
    if (!pick) {
      const big = files.find((f) => /\.(pdf|epub)$/i.test(f.name));
      throw new Error(big ? "That book is larger than the 50 MB limit" : "No PDF or EPUB for that book");
    }
    return {
      kind: pick === pdf ? "pdf" : "epub",
      size: size(pick),
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${pick.name.split("/").map(encodeURIComponent).join("/")}`,
    };
  }

  async function searchArchive(q) {
    const terms = iaTerms(q);
    if (!terms) return [];
    const query = [
      `(title:(${terms}) OR creator:(${terms}))`,
      "mediatype:texts",
      "(format:pdf OR format:epub)",
      ...IA_LENDING.map((c) => `NOT collection:${c}`),
      "NOT access-restricted-item:true",
    ].join(" AND ");
    const params = new URLSearchParams({ q: query, rows: "40", output: "json" });
    for (const f of ["identifier", "title", "creator", "year", "date", "downloads"]) params.append("fl[]", f);
    const j = await (await get(`https://archive.org/advancedsearch.php?${params}`)).json();
    const docs = (j.response && j.response.docs) || [];
    // Several scans of one book are common; keep the most downloaded.
    docs.sort((a, b) => (Number(b.downloads) || 0) - (Number(a.downloads) || 0));
    const seen = new Set();
    const out = [];
    for (const d of docs) {
      if (!d.identifier || !ID_PATTERNS.ia.test(d.identifier)) continue;
      const title = tidyTitle(d.title);
      const author = tidyAuthor(d.creator);
      const k = bookKey(title, author);
      if (seen.has(k)) continue;
      seen.add(k);
      const year = Number(d.year) || Number(String(d.date || "").slice(0, 4)) || null;
      out.push({
        id: `ia:${d.identifier}`,
        source: "ia",
        sourceName: SOURCES.ia.name,
        title,
        author,
        year,
        kind: "pdf",
        size: null,
        cover: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
        pageUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
        downloads: Number(d.downloads) || 0,
        rank: out.length,
      });
      if (out.length >= PER_SOURCE) break;
    }
    // Find out which format each will come as, and its size. Items that
    // turn out to be unavailable are dropped; a slow answer keeps "PDF".
    await Promise.all(out.slice(0, 8).map(async (r) => {
      try {
        const f = await iaFiles(r.id.slice(3));
        r.kind = f.kind;
        r.size = f.size;
      } catch (e) {
        if (!/timeout|abort/i.test(String(e && (e.name + e.message)))) r.drop = true;
      }
    }));
    return out.filter((r) => !r.drop);
  }

  const searchers = { gutenberg: searchGutenberg, ia: searchArchive };

  async function search(rawQuery) {
    const q = cleanQuery(rawQuery);
    if (q.length < 2) return { query: q, results: [], sources: [] };
    const cacheKey = q.toLowerCase();
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    const settled = await Promise.all(Object.entries(searchers).map(async ([source, fn]) => {
      const started = Date.now();
      try {
        const results = await fn(q);
        return { source, name: SOURCES[source].name, ok: true, count: results.length, ms: Date.now() - started, results };
      } catch (e) {
        return { source, name: SOURCES[source].name, ok: false, error: String((e && e.message) || e), ms: Date.now() - started, results: [] };
      }
    }));

    // Best match first; Gutenberg wins ties (proofread text reads better
    // aloud than a scan's OCR), then each source's own order.
    const all = settled.flatMap((s) => s.results);
    for (const r of all) {
      r.score = matchScore(q, r.title, r.author) * 10
        + (r.source === "gutenberg" ? 0.5 : 0)
        - r.rank * 0.15;
      delete r.rank;
    }
    all.sort((a, b) => b.score - a.score);
    for (const r of all) delete r.score;

    const value = {
      query: q,
      results: all,
      sources: settled.map(({ results, ...s }) => s),
    };
    // Don't keep a half-failed answer around.
    if (settled.every((s) => s.ok)) {
      cache.set(cacheKey, { at: Date.now(), value });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return value;
  }

  // Where to download a result from: { kind, url }.
  async function resolveDownload(id) {
    const p = parseId(id);
    if (!p) throw Object.assign(new Error("Unknown book"), { status: 400 });
    if (p.source === "gutenberg") {
      return {
        kind: "epub",
        urls: [
          `https://www.gutenberg.org/ebooks/${p.key}.epub3.images`,
          `https://www.gutenberg.org/ebooks/${p.key}.epub.images`,
          `https://www.gutenberg.org/ebooks/${p.key}.epub.noimages`,
        ],
      };
    }
    const f = await iaFiles(p.key);
    return { kind: f.kind, urls: [f.url] };
  }

  async function fetchFollowing(url) {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!isAllowedUrl(current)) throw new Error("The download went somewhere unexpected");
      const res = await fetchImpl(current, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), current).toString();
        continue;
      }
      return res;
    }
    throw new Error("Too many redirects");
  }

  async function readCapped(res) {
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw Object.assign(new Error("That book is larger than the 50 MB limit"), { status: 413 });
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw Object.assign(new Error("That book is larger than the 50 MB limit"), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  function looksLike(kind, buf) {
    if (kind === "pdf") return buf.subarray(0, 1024).includes("%PDF");
    return buf[0] === 0x50 && buf[1] === 0x4b; // "PK": EPUB is a zip
  }

  // Download a result. Returns { kind, buffer }.
  async function download(id) {
    const target = await resolveDownload(id);
    let lastError = null;
    for (const url of target.urls) {
      const res = await fetchFollowing(url);
      if (!res.ok) {
        lastError = new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
        if (res.body) await res.body.cancel().catch(() => {});
        continue;
      }
      const buffer = await readCapped(res);
      if (!looksLike(target.kind, buffer)) {
        lastError = new Error(`That download wasn't a ${target.kind.toUpperCase()} file`);
        continue;
      }
      return { kind: target.kind, buffer };
    }
    throw Object.assign(lastError || new Error("Download failed"), { status: 502 });
  }

  return { search, resolveDownload, download };
}

module.exports = { createFinder, parseId, matchScore, bookKey, tidyAuthor, isAllowedUrl, SOURCES };
