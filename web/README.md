# Grace Reader (web)

Drop a PDF. It reads itself to you. No build step, no install, no native app.

## Run it

Either open `index.html` directly in a browser, or serve the folder over HTTP
(file:// URLs sometimes block CDN module imports in stricter browsers):

```
cd web
python -m http.server 8765
# then open http://127.0.0.1:8765/
```

A sample PDF is bundled at `multipage.pdf` — drop it on the page to confirm
text extraction and the read-aloud flow before pointing at your own files.

## Engines

- **Browser TTS** (default). Uses the Web Speech API (`SpeechSynthesis`).
  Zero infrastructure, works offline, picks up the OS's installed voices.
- **Pocket TTS** (opt-in). POSTs each chunk to a local pocket-tts server and
  plays the returned WAV. Default URL is `http://127.0.0.1:8765`; change it
  in the UI if your server runs elsewhere. Default voice is `eve`; the
  Pocket TTS server's `eve`/`alba`/`lola` built-ins are the only ones the
  dropdown suggests, but any built-in name (or `http(s)://`, `hf://`, local
  file path) is accepted.

To run pocket-tts locally, see
`C:\Users\carpe\.minimax\experiments\pocket-tts\serve_local.py` (port 8765
by default; `python serve_local.py --port 8765 --voice eve`).

## Controls

- Drop a PDF on the page, or click the drop zone to pick one.
- Play / Pause / Stop. Prev / Next jump pages. The page-number box jumps to
  any page. Speed slider: 0.5× – 2.0×. Switching the engine mid-playback
  restarts the current page on the new engine.
- The "Extracted text" panel at the bottom shows the raw text the page is
  about to read, for sanity-checking the PDF parser output.

## Privacy

Everything runs in the browser. PDFs are read locally via `FileReader`; text
goes to the TTS engine only (your OS speech engine, or the pocket-tts
server you point at). No analytics, no remote calls except the pdf.js
CDN and your pocket-tts URL.
