# Scan pages

Turn photos of a printed book into a book you can listen to.

**Where:** Library → **Scan pages** (or choose / drop photos with **Add book**).

## How it works

1. Take a photo of each page, or choose photos already on the device. Photos
   are put in file-name order (phones number them in the order they were
   taken) and can be moved with the arrows or dragged on a computer.
2. Each photo is read **in the browser** with [Tesseract.js] 5.1.1
   (WebAssembly, English `4.0.0_best_int` data, about 5 MB, fetched once
   from jsDelivr and then cached by the browser). Nothing is uploaded until
   the book is saved.
3. Before reading, the photo is cleaned up (`preparePhoto` in
   `public/scan.js`): turned upright using its EXIF orientation, sized to
   1600–2600 px, the lighting flattened (each pixel divided by the
   brightness around it, so a shadow or dim corner becomes plain paper), the
   table around the page painted white, and the contrast stretched.
4. A weak read (few words or low confidence) is tried again with firmer
   clean-up, then sideways and upside down. The best read wins.
5. The text is tidied (`public/scan-text.js`): running heads and page numbers
   come out (the printed number is kept as the page label), words hyphenated
   at line ends are mended, specks at the paper's edge are dropped, lines are
   joined into paragraphs using indents, and a bar read for a capital I is
   fixed. Words split across two pages are mended when the book is made.
6. Pages the reader is less sure of are marked **Check this page** with the
   text open to fix. If the printed page numbers say the photos are out of
   order, **Put in page order** appears.
7. **Make book** builds an EPUB 3 (one page per spine item, printed page
   numbers in the page list) and saves it through the normal upload, so it
   lives in My books, can be shared, and plays with every voice. The player
   counts a scanned book in pages, not chapters.

## Setup

No server changes beyond the content security policy, which must allow the
OCR engine in **both** `server.js` and the deploy kit's `vercel.json`:

- `script-src` adds `'wasm-unsafe-eval'`
- `connect-src` adds `https://cdn.jsdelivr.net`

## Tests

`npm run test:scan` (`CHROME=… CDN_DIR=… node test-scan.mjs`). Without
CHROME/CDN_DIR only the text and EPUB rules run. For the browser part,
CDN_DIR also needs the unpacked npm packages `tesseract.js@5.1.1`,
`tesseract.js-core@5.1.1` and `@tesseract.js-data/eng@1.0.0` under
`CDN_DIR/npm/<package>/` (`test-cdn.mjs` serves them as jsDelivr).

Fixtures in `test-fixtures/scan/` are photos of four printed pages of
original text (`pages.json`): `IMG_*` are ordinary phone photos (one
sideways, two out of order), `DIM_*` are dim, blurred, tilted, curled and
low resolution. Results on 2026-11-14: ordinary photos 100% of words right,
dim ones 97–99%, about 5 s a page on a laptop.

## Limits

- English only for now (other languages are one more data file each).
- Handwriting, very ornate type and pages with pictures or columns read
  less well; tables come out as plain lines.
- Two pages in one photo work but read better as one page per photo.
- iPhone HEIC photos open on the phone itself; a desktop browser that can't
  open HEIC says so.

[Tesseract.js]: https://github.com/naptha/tesseract.js
