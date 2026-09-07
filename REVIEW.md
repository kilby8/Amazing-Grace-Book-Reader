# Code Review — Amazing Grace Book Reader (pre-PDF/pocket-tts)

Reviewer: Mavis (orchestrator)
Date: 2026-09-07
Branch: `main` @ `a5ae033` (upstream `kilby8/Amazing-Grace-Book-Reader`)
Scope: parts the new "drop PDF + pocket-tts readback" feature will touch, plus structural notes for the team.

## Verdict

**Ready to extend.** Architecture is clean, the existing controllers are exactly the right seams to splice PDF import and a network-backed TTS into, and the playback stack is already loosely coupled (`TtsManager` is consumed only by the service and the playback controller — swapping its internals is local). Build is green; the gauntlet for the new feature is `./gradlew test` + a pocket-tts server smoke probe.

## What's good

- **Composition-root DI without frameworks.** `ReaderAppDependencies.create(...)` (`domain/ReaderAppDependencies.kt`) wires everything by hand. This is the right call for an app this size — no Dagger/Hilt overhead, and the constructor signatures ARE the contract. The new `PocketTtsClient` slots in here cleanly.
- **State store pattern is solid.** `ReaderPlaybackStateStore` is a `StateFlow` shared between service and UI coordinator. We can publish pocket-tts streaming state the same way.
- **MediaSession + foreground service is the right shape.** `ReaderPlaybackService` already handles `ACTION_PREPARE_TEXT / PLAY / PAUSE / STOP / UPDATE_SETTINGS` and the lockscreen UI. Once `TtsManager` can hand off audio bytes (instead of producing them itself), the service contract doesn't change at all.
- **DataStore for prefs is well-scoped.** `ReaderPreferencesSnapshot` will grow by exactly two fields (pocket-tts base URL, voice id) — no schema change.
- **Test surface is small but real.** `PlaybackSessionStateTest` (unit), `ReaderPreferencesTest` + `ScanHistoryDaoTest` (instrumentation). The new feature adds at least one unit test for the HTTP client.

## What needs to change for the feature

### 1. `TtsManager` is a sealed single-impl abstraction

Currently `TtsManager` (235 lines, `tts/TtsManager.kt`) is the *only* TTS implementation and is concrete — `android.speech.tts.TextToSpeech` is constructed in the field initializer. The class is consumed by `ReaderPlaybackService` (line 135) and `ReaderPlaybackController`. Adding a pocket-tts path means either:

- **Option A (chosen): introduce a `SpeechEngine` interface.** `AndroidTtsEngine` wraps the current TtsManager body; `PocketTtsEngine` posts text to the HTTP endpoint and plays the returned WAV. `TtsManager` becomes a thin facade that delegates. The `UtteranceProgressListener` highlight range becomes a best-effort estimator in the pocket-tts path (WAV duration → char offset) and the real Android one in the Android path.
- Option B: add `usePocketTts: Boolean` to `TtsManager` and branch internally. Rejected — too much code in one class, harder to test.

### 2. Highlight range semantics change

Pocket TTS does not emit per-word timing data, so the current `onRangeStart` callback in `TtsManager` (line 106) is meaningless for the pocket-tts path. Two acceptable degradations:

- v1: hide the active-highlight UI when the engine is `PocketTts` (the highlight flow is wired to `activeRange` being non-null; just don't update it).
- v2: estimate char position from `(audioProgressMs / totalDurationMs) * textLength` and emit a synthetic range every N ms. Optional, ship later.

`v1 ships with no live highlight in pocket-tts mode. This is documented as a known limitation in DESIGN.md, not hidden.`

### 3. PDF text extraction library

`android.graphics.pdf.PdfRenderer` (API 21+) only rasterizes pages to bitmaps — it does NOT extract text. We need a real text extractor.

**Pick: `com.tom-roush:pdfbox-android:2.0.27.0`** (Apache 2.0, ~6 MB AAR, actively maintained, the de-facto choice for Android PDF text extraction). Alternative considered: `org.apache.pdfbox:pdfbox` core — works on Android with the `Robolectric` shim but is ~30 MB; rejected.

### 4. HTTP client

None in the project today. Pick: **OkHttp 4.12.0**. Reasons: standard, supports multipart form bodies (we need `voice_url` form field plus optional `voice_wav` file), has a coroutines-friendly adapter (`okhttp-coroutines` via `kotlinx-coroutines-jdk8` or just `withContext(Dispatchers.IO)`), and a `MockWebServer` we can use for tests.

### 5. Cleartext HTTP for the dev server

Android 9+ blocks cleartext HTTP by default. The dev pocket-tts server is `http://127.0.0.1:8765/tts` (emulator → host uses `10.0.2.2`). We need:

- A `res/xml/network_security_config.xml` allowing cleartext to those two hosts (production-ready for v1, since the server is meant to be local-only).
- `<application android:networkSecurityConfig="@xml/network_security_config">` in the manifest.

### 6. `ReaderActivityResultController` needs a PDF picker

It currently handles `PickVisualMedia` (image only) and `TakePicture`. Add a third launcher using `ActivityResultContracts.OpenDocument(arrayOf("application/pdf"))` that hands the content URI to a new `PdfImportController.processDocument(uri)`.

### 7. `ReaderPreferences` grows by 2 fields

- `ttsEngine: String` — `"android"` (default) or `"pocket_tts"`.
- `pocketTtsBaseUrl: String` — default `"http://10.0.2.2:8765"`.
- `pocketTtsVoice: String` — default `"eve"`.

Backward-compat: old DataStore values default to the existing Android TTS path, so existing installs keep working.

### 8. Service-streaming audio: a new class, not a `MediaPlayer` hack

`MediaPlayer` works for local files. For streaming, use **ExoPlayer (`androidx.media3:media3-exoplayer:1.4.1`)** — it's already a transitive dep of the `media` library and is the right tool for HTTP audio. The new `PocketTtsEngine` will:

1. POST text → save the WAV stream to a temp file in `cacheDir`.
2. Hand the temp file path to an ExoPlayer.
3. Expose `playbackStatus` and `activeRange` (estimated or null) the same way `TtsManager` does.

Why not stream directly: the pocket-tts endpoint's `Transfer-Encoding: chunked` WAV is a full WAV header + body, and ExoPlayer can read it, but for v1 we want a known-good file path (debugging + offline replay). A temp file is fine — it's `cacheDir`, the OS reclaims it.

## What is NOT in scope (explicitly out)

- **Cloud TTS fallback** (Google Cloud TTS, ElevenLabs, etc.) — pocket-tts local only for v1.
- **Per-page PDF navigation** (jump to page 7, page 12). v1 concatenates the whole PDF into one text blob and reads it as a single playback session. The `multiPageEntries` mechanism already in the WIP (clone 1, uncommitted) is the natural extension point for v2.
- **Voice enrollment** (the `pocket_tts` package has an `enroll.py` script that builds a custom voice from a 10-second WAV). v1 ships with built-in voices only (`eve`, `alba`, `lola`, ...).
- **Replacing the Android TTS path** (the old `TtsManager` body keeps working for users who don't run a pocket-tts server). v1 is additive.
- **James's in-flight WIP** (PageNumberExtractor, ImageBitmapLoader mods, accessibility state). Those are James's own dev work in clone 1; the team works in clone 2 and doesn't touch them.

## Test surface for the new feature

- **Unit** (in `app/src/test/...`):
  - `PocketTtsClientTest` — uses OkHttp's `MockWebServer`. Verifies: request body shape (multipart form with `text` field), default voice fallback, error mapping (4xx → `PocketTtsException`, 5xx → `PocketTtsException`, network error → `IOException`).
  - `PdfTextExtractorTest` — uses a fixture PDF in `app/src/test/resources/`. Verifies: page text concatenated with double newlines, empty pages skipped, exception on corrupted PDF.
- **Instrumentation** (in `app/src/androidTest/...`):
  - `PocketTtsPreferenceTest` — saves a `pocketTtsBaseUrl` and reads it back across DataStore restart.
- **Integration smoke** (script, not a test):
  - `tools/probe-pocket-tts.ps1` — POSTs "hello world" to `http://127.0.0.1:8765/tts`, verifies the response is `audio/wav` and starts with `RIFF`. Runnable on a dev box with pocket-tts serving.

## File ownership for the team (anti-collision)

| Worker | Owns (write/edit) | Touches only | Out of scope |
|---|---|---|---|
| `coder` (Cody) | `tts/PocketTtsClient.kt`, `tts/SpeechEngine.kt`, `tts/PocketTtsEngine.kt`, `tts/AndroidTtsEngine.kt`, `tts/TtsManager.kt` (refactor), `domain/ReaderActivityResultController.kt`, `domain/PdfImportController.kt`, `domain/ReaderAppDependencies.kt` (wiring), `data/ReaderPreferences.kt`, `ui/ReaderScreen.kt` (button only), `AndroidManifest.xml`, `res/xml/network_security_config.xml`, `app/build.gradle.kts` | – | everything else |
| `general` (Jamie) | `tools/launch-pocket-tts.ps1`, `tools/probe-pocket-tts.ps1`, `tools/pocket-tts-requirements.txt` (if needed), `app/src/test/.../PocketTtsClientTest.kt` (mock HTTP only), `DEV.md`, `README.md` (append) | `app/build.gradle.kts` (add OkHttp + pdfbox-android + media3 only — but coder also needs to touch it, so coordinate via PR) | app source code outside tests |
| `verifier` (Kai) | `tests/gauntlet-output/2026-09-07-PDF-pocket-tts.txt` (write-only, log) | runs `./gradlew test`, `./gradlew lint`, smoke probe | any source file |

The two writes to `app/build.gradle.kts` are a real risk. **Resolution:** Cody owns the file end-to-end and lands OkHttp + pdfbox-android + media3 in the same commit. Jamie does not touch it. Jamie's `PocketTtsClientTest` uses OkHttp's `MockWebServer`, which requires `com.squareup.okhttp3:mockwebserver` in `testImplementation` — Cody adds that line.

## Open decisions (none block the team)

1. **Voice picker UI** — text field only ("enter a voice name like `eve`"), or a dropdown? Recommend text field for v1, dropdown in v2 when we ship enrollment.
2. **Pocket-tts base URL default** — `http://10.0.2.2:8765` (Android emulator → host) is correct for the emulator. Real device on the same WiFi needs the host's LAN IP, which is dynamic. v1 ships the emulator default; the settings UI lets the user override. Document the real-device flow in `DEV.md`.
3. **PDF size limit** — pocket-tts works best on chunks ≤ ~5000 chars. We should chunk a long PDF into 2-3K-char segments and concatenate the returned WAVs. v1 keeps it simple: send the whole text, hope for the best. v2 adds chunking.

## Build env (verified)

- Gradle 8.7
- JDK 21 (`C:\Program Files\Android\openjdk\jdk-21.0.8`)
- Android SDK at `C:\Users\carpe\AppData\Local\Android\Sdk` (platform-35, build-tools 35.0.0)
- `local.properties` is configured
- `./gradlew test` is GREEN as of HEAD `a5ae033`

## What this review is NOT

This is a structural review scoped to the new feature. It is not:
- A full security audit (the file-paths XML, DataStore usage, and the future cleartext config warrant a separate pass).
- A performance review (the new HTTP call + temp-file write is a long-tail concern; profile in v2).
- A11y (the highlight deprecation in pocket-tts mode needs a settings note).
