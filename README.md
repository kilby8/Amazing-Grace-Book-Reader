# Amazing Grace Reader

Read your books aloud. Drop a PDF or EPUB into a personal library, pick a
voice, hit Play.

The **web app is the primary surface** — a per-user library + reader that
runs in any modern browser, with cloud or local TTS, designed to work
remotely over a tailnet or self-hosted URL.

The Android app (`app/`) is the secondary surface — a Kotlin/Compose port
that talks to a local [pocket-tts](https://github.com/kyutai-labs/pocket-tts)
server. It ships standalone APKs and works offline.

## Web app (`web/`) — primary

Per-user library + read-aloud reader. Three screens (auth · library ·
reader) in one SPA, with a tiny Express backend and SQLite for storage.

**TTS engines (pick in the settings sidebar):**
- **ElevenLabs** *(default)* — cloud, works anywhere you can reach the URL.
  Voice id field, free-tier compatible (`eleven_turbo_v2_5`). API key is
  read by the server from `~/.mavis/elevenlabs_credentials.json` (or
  `ELEVENLABS_API_KEY` env var) and never leaves the server.
- **Browser TTS** — built-in `SpeechSynthesis`. Zero setup, lower quality.
- **Pocket TTS** — local HTTP server (`127.0.0.1:8765`). Best quality when
  the box can reach the server.

**Run it:**
```bash
cd web
npm install
node server.js          # listens on http://127.0.0.1:8770
```

**Storage layout:**
- `data/library.db` — SQLite (WAL mode), `users` + `books` tables
- `data/books/<user-id>/<filename>` — raw uploads, per-user folders
- Both gitignored

**Expose it remotely:**
- Tailscale (default for your own devices) — no extra config, just run on a
  Tailscale-attached box.
- Tailscale Funnel / ngrok — `tailscale funnel --bg 8770` and friends can
  hit it without a tailnet.
- Self-host on a VPS — `infra/setup.sh` provisions Ubuntu 24.04 with
  Caddy, UFW, fail2ban, and the systemd unit. Two recipes:
  - [`DEPLOY.md`](./DEPLOY.md) — Hetzner / DO / Vultr ($3-10/mo) with a real domain
  - [`DEPLOY-oracle.md`](./DEPLOY-oracle.md) — Oracle Cloud Always Free (ARM VM, $0) + DuckDNS free subdomain
- Standalone Caddy on this box — `caddy reverse-proxy --from your.domain --to 127.0.0.1:8770`. Set `SESSION_SECRET` to a random value and flip `cookie.secure` to `true` in `server.js`.

**Tests:**
- `node test-library.mjs` — register/login/upload/per-user isolation/delete (26 checks)
- `node test-pageprint.mjs` — print-page badge in EPUB nav (13 checks)
- `node test-epub.mjs` — EPUB extraction + transport (11 checks)
- `node test-elevenlabs.mjs` — TTS proxy auth gate + live round-trip + browser UI (14 checks)

Run them with the backend up: `node test-library.mjs && node test-pageprint.mjs && node test-epub.mjs && node test-elevenlabs.mjs`.

## Android app (`app/`) — secondary

Native Kotlin + Jetpack Compose port. Captures or imports page images,
extracts text fully on-device with ML Kit OCR, reads aloud with TTS,
saves scans locally with Room history.

- Camera capture with full-resolution FileProvider flow
- Gallery/photo picker import
- On-device OCR via Google ML Kit Text Recognition
- TTS playback controls: Play, Pause, Stop
- True pause/resume from spoken position
- Background playback notification controls (Play/Pause/Stop)
- Media-style lockscreen controls with playback metadata
- Live text highlighting and auto-follow scrolling while speaking
- Voice customization: speech rate and pitch sliders
- Local scan history with delete + undo

**Project structure:**
- `app/src/main/java/com/amazinggrace/bookreader/MainActivity.kt`
- `app/src/main/java/com/amazinggrace/bookreader/ocr/OcrManager.kt`
- `app/src/main/java/com/amazinggrace/bookreader/tts/TtsManager.kt`
- `app/src/main/java/com/amazinggrace/bookreader/tts/PocketTtsClient.kt`
- `app/src/main/java/com/amazinggrace/bookreader/service/ReaderPlaybackService.kt`
- `app/src/main/java/com/amazinggrace/bookreader/history/`
- `app/src/main/java/com/amazinggrace/bookreader/data/ReaderPreferences.kt`
- `app/src/main/java/com/amazinggrace/bookreader/ui/ReaderScreen.kt`

**Build & test:**
```bash
./gradlew test
./gradlew assembleDebug
```

Drop PDF + Pocket TTS (optional opt-in): the Android app can read a PDF
aloud by sending extracted text to a local pocket-tts HTTP server. Built-in
Android TTS remains the default. Launch with `tools\launch-pocket-tts.ps1`,
pick **Pocket TTS** in the engine selector, tap **Open PDF**. Full setup
in [`DEV.md`](./DEV.md).

## Releases

- [v0.1.0](https://github.com/kilby8/Amazing-Grace-Book-Reader/releases/tag/v0.1.0) — drop PDF + pocket-tts, Android debug + release APKs.

## Why web-first

The library system (per-user accounts, uploads, persistence, delete) lives
in the web app — it has a real backend, a real DB, and a real auth flow.
The Android app is offline-only and single-device. Once the web app is
deployed somewhere you can reach (Tailscale, Funnel, VPS), it's the
canonical place to read your books. The Android app stays useful for the
"phone camera + pocket-tts in the field" workflow that doesn't need any
of that infrastructure.
