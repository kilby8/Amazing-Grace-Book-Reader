# DESIGN — "Drop PDF, read aloud with pocket-tts"

Status: **DRAFT v1, ready for team execution**
Owner: Mavis (orchestrator)
Date: 2026-09-07
Target branch: `feat/pdf-pocket-tts` (off `main` @ `a5ae033`)
Companion docs: `REVIEW.md` (this folder), `DEV.md` (the dev-environment doc the team writes alongside)

## 1. What we're building

Add a "drop PDF" path to the existing Amazing Grace Book Reader app that:

1. Lets the user pick a PDF from device storage (no new permissions — uses `OpenDocument`).
2. Extracts the text (Apache pdfbox-android).
3. Sends the text to a local **pocket-tts** server (`POST /tts`, multipart `text=...`).
4. Saves the returned WAV to a temp file, plays it via ExoPlayer, supports pause/resume/stop.
5. Keeps the existing Android TTS path as a user-selectable option (default unchanged).

User-visible UX (v1):

- New "Open PDF" button in the existing top toolbar of `ReaderScreen`, next to the "Take photo" / "Pick image" buttons.
- New "TTS engine" row in the existing voice/text settings (text-scale and voice sliders are already there): a small two-state selector ("Android (built-in) / Pocket TTS (local server)"). Below it, when Pocket TTS is selected, a text field for the server URL (default `http://10.0.2.2:8765`) and a text field for the voice id (default `eve`).
- Existing play / pause / stop buttons keep working.
- The "live highlight" feature is **silently disabled** in pocket-tts mode (no timing data). A small "Pocket TTS — no word highlighting" note appears under the text in that mode. No regression in Android-TTS mode.

## 2. Architecture (the seam)

### 2.1 New abstraction: `SpeechEngine`

```kotlin
// app/src/main/java/com/amazinggrace/bookreader/tts/SpeechEngine.kt
package com.amazinggrace.bookreader.tts

import kotlinx.coroutines.flow.StateFlow

interface SpeechEngine {
    val playbackStatus: StateFlow<TtsManager.PlaybackStatus>
    val activeRange: StateFlow<TtsManager.ActiveTextRange?>

    /** Load and start speaking `text`. Idempotent — restart on the same text starts from the beginning. */
    fun speak(text: String)

    /** Pause at the current position. No-op if not playing. */
    fun pause()

    /** Stop and release audio resources. */
    fun stop()

    /** Reset internal state for a brand-new text. */
    fun resetForNewText(text: String)

    fun updateSpeechRate(rate: Float)
    fun updatePitch(pitch: Float)
}
```

`TtsManager` becomes a thin facade:

```kotlin
class TtsManager(context: Context, lifecycle: Lifecycle) : DefaultLifecycleObserver {
    // keeps existing public API: speak, pause, stop, resetForNewText, updateSpeechRate, updatePitch,
    // isPaused, activeRange, playbackStatus

    internal var engine: SpeechEngine = AndroidTtsEngine(context, lifecycle)
        private set

    fun setEngine(newEngine: SpeechEngine) {
        engine.stop()
        engine = newEngine
    }
    // delegates the rest
}
```

### 2.2 `AndroidTtsEngine` (extract existing body)

Just lift the current `TtsManager` body into `tts/AndroidTtsEngine.kt` implementing `SpeechEngine`. No behavior change. The highlight range callback stays as-is (`UtteranceProgressListener` gives us real timing data).

### 2.3 `PocketTtsEngine` (new)

```kotlin
class PocketTtsEngine(
    private val context: Context,
    private val lifecycle: Lifecycle,
    private val client: PocketTtsClient,
    private val tempFileFactory: (String) -> File
) : SpeechEngine {

    private val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()
    private val _playbackStatus = MutableStateFlow(PlaybackStatus.IDLE)
    private val _activeRange = MutableStateFlow<ActiveTextRange?>(null)  // always null in v1

    override val playbackStatus: StateFlow<PlaybackStatus> = _playbackStatus.asStateFlow()
    override val activeRange: StateFlow<ActiveTextRange?> = _activeRange.asStateFlow()

    private var currentText: String = ""

    override fun speak(text: String) {
        if (text.isBlank()) return
        currentText = text
        lifecycle.coroutineScope.launch {
            _playbackStatus.value = PlaybackStatus.PLAYING
            try {
                val wavFile = client.synthesizeToFile(text, tempFileFactory)
                exoPlayer.setMediaItem(MediaItem.fromUri(wavFile.toURI().toString()))
                exoPlayer.prepare()
                exoPlayer.playWhenReady = true
            } catch (e: Exception) {
                _playbackStatus.value = PlaybackStatus.STOPPED
                // surface error via the existing ReaderPlaybackStateStore or a callback
            }
        }
    }
    // pause/stop/resetForNewText/updateSpeechRate/updatePitch: forward to exoPlayer
}
```

`PocketTtsClient` (new):

```kotlin
class PocketTtsClient(
    private val baseUrl: String,
    private val voice: String,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)  // TTS synthesis can be slow
        .build()
) {
    /**
     * Synthesizes [text] and writes the returned WAV to [tempFile] (factory builds the path).
     * Throws PocketTtsException on 4xx/5xx, IOException on network errors.
     */
    suspend fun synthesizeToFile(text: String, tempFileFactory: (String) -> File): File = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("text", text)
            .apply { if (voice.isNotBlank()) addFormDataPart("voice_url", voice) }
            .build()

        val request = Request.Builder()
            .url("$baseUrl/tts")
            .post(body)
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw PocketTtsException("pocket-tts returned ${response.code}: ${response.body?.string()}")
            }
            val bytes = response.body?.bytes()
                ?: throw PocketTtsException("pocket-tts returned empty body")
            val file = tempFileFactory("pocket_tts_${System.currentTimeMillis()}.wav")
            file.writeBytes(bytes)
            file
        }
    }
}

class PocketTtsException(message: String) : RuntimeException(message)
```

### 2.4 `PdfImportController` (new)

```kotlin
class PdfImportController(
    private val context: Context,
    private val viewModel: ReaderViewModel,
    private val playbackController: ReaderPlaybackController
) {
    suspend fun processDocument(uri: Uri) {
        if (viewModel.uiState.value.isProcessing) return
        viewModel.startOcr()  // reuse the existing "processing" flag
        runCatching {
            context.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input) { "could not open PDF at $uri" }
                PdfTextExtractor.extract(input)
            }
        }.onSuccess { text ->
            viewModel.applyOcrResult(/* fake a result that just carries the text */)
            playbackController.prepareText(text)
        }.onFailure { error ->
            viewModel.failOcr(error.message ?: "could not read PDF")
        }
    }
}
```

`PdfTextExtractor` (new, pure function — easy to test):

```kotlin
object PdfTextExtractor {
    /**
     * Extracts text from every page of the PDF, joining pages with a blank line.
     * Returns the concatenated text. Throws on corrupted PDFs.
     */
    fun extract(input: InputStream): String {
        PDDocument.load(input).use { doc ->
            val stripper = PDFTextStripper()
            return buildString {
                for (i in 1..doc.numberOfPages) {
                    stripper.startPage = i
                    stripper.endPage = i
                    val pageText = stripper.getText(doc).trim()
                    if (pageText.isNotEmpty()) {
                        if (isNotEmpty()) append("\n\n")
                        append(pageText)
                    }
                }
            }
        }
    }
}
```

### 2.5 `ReaderActivityResultController` gets a PDF launcher

Add a third launcher:

```kotlin
private val pdfPickerLauncher = caller.registerForActivityResult(
    ActivityResultContracts.OpenDocument()
) { uri ->
    if (uri == null) {
        onStatusMessage("No PDF selected.")
        return@registerForActivityResult
    }
    onPdfSelected(uri)
}

fun launchPdfPicker() {
    pdfPickerLauncher.launch(arrayOf("application/pdf"))
}
```

The constructor takes one more callback: `onPdfSelected: (Uri) -> Unit`.

### 2.6 `ReaderAppDependencies` wires the new pieces

```kotlin
val activityResultController = ReaderActivityResultController(
    caller = caller,
    context = context,
    cacheDir = cacheDir,
    onImageSelected = { uri, backingFile -> /* unchanged */ },
    onPdfSelected = { uri ->
        activity.lifecycleScope.launch { pdfImportController.processDocument(uri) }
    },
    onStatusMessage = { /* unchanged */ }
)

val pocketTtsClient = PocketTtsClient(
    baseUrl = prefs.pocketTtsBaseUrl,
    voice = prefs.pocketTtsVoice
)
val pdfImportController = PdfImportController(context, viewModel, playbackController)
val ttsManager = TtsManager(applicationContext, lifecycle).apply {
    if (prefs.ttsEngine == "pocket_tts") {
        setEngine(PocketTtsEngine(applicationContext, lifecycle, pocketTtsClient, ::tempWavFile))
    }
}
```

`tempWavFile(name)`:

```kotlin
private fun tempWavFile(name: String): File {
    val dir = File(context.cacheDir, "tts").apply { mkdirs() }
    return File(dir, name)
}
```

### 2.7 `ReaderPreferences` grows by 3 fields

```kotlin
data class ReaderPreferencesSnapshot(
    val lastParsedText: String,
    val speechRate: Float,
    val pitch: Float,
    val textScale: Float,
    val ttsEngine: String,           // new: "android" | "pocket_tts"
    val pocketTtsBaseUrl: String,    // new: default "http://10.0.2.2:8765"
    val pocketTtsVoice: String       // new: default "eve"
)

companion object {
    val TTS_ENGINE: Preferences.Key<String> = stringPreferencesKey("tts_engine")
    val POCKET_TTS_BASE_URL: Preferences.Key<String> = stringPreferencesKey("pocket_tts_base_url")
    val POCKET_TTS_VOICE: Preferences.Key<String> = stringPreferencesKey("pocket_tts_voice")
}
```

Setters:

```kotlin
suspend fun saveTtsEngine(engine: String) { /* clamp to "android" or "pocket_tts" */ }
suspend fun savePocketTtsBaseUrl(url: String) { /* validate http(s):// */ }
suspend fun savePocketTtsVoice(voice: String) { /* trim, no empty */ }
```

Defaults on read: `ttsEngine = "android"`, `pocketTtsBaseUrl = "http://10.0.2.2:8765"`, `pocketTtsVoice = "eve"`. Existing installs pick up the defaults transparently.

### 2.8 Manifest + network security

`AndroidManifest.xml` adds:

```xml
<application
    ...
    android:networkSecurityConfig="@xml/network_security_config"
    ...>
```

`res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.0.2.2</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

This permits cleartext only to the dev server addresses; everywhere else requires HTTPS. Production-ready for the v1 "local-only" threat model.

### 2.9 `app/build.gradle.kts` deps (additions)

```kotlin
dependencies {
    // ... existing ...

    // PDF text extraction
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")

    // HTTP client
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Audio playback for pocket-tts
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-common:1.4.1")
}
```

## 3. UI

### 3.1 New "Open PDF" button in the existing toolbar

In `ReaderScreen.kt`, next to the existing "Take photo" and "Pick image" buttons (which currently live in a `Row` near the top), add a third button:

```kotlin
OutlinedButton(onClick = onPickPdf) {
    Icon(Icons.Default.PictureAsPdf, contentDescription = null)
    Spacer(Modifier.width(4.dp))
    Text("Open PDF")
}
```

The activity passes `onPickPdf = { dependencies.activityResultController.launchPdfPicker() }`.

### 3.2 TTS engine selector in the settings sheet

The existing settings sheet (text scale + voice sliders) is below the text area. Add a new section above the text-scale row:

```kotlin
SettingsSection(title = "TTS Engine") {
    Row {
        FilterChip(selected = ttsEngine == "android", onClick = { onTtsEngineChange("android") }, label = { Text("Android") })
        Spacer(Modifier.width(8.dp))
        FilterChip(selected = ttsEngine == "pocket_tts", onClick = { onTtsEngineChange("pocket_tts") }, label = { Text("Pocket TTS") })
    }
    if (ttsEngine == "pocket_tts") {
        OutlinedTextField(value = pocketTtsBaseUrl, onValueChange = onPocketTtsBaseUrlChange, label = { Text("Server URL") })
        OutlinedTextField(value = pocketTtsVoice, onValueChange = onPocketTtsVoiceChange, label = { Text("Voice") })
        Text("Pocket TTS has no word-level timing, so live highlight is off in this mode.", style = MaterialTheme.typography.bodySmall)
    }
}
```

`MainActivity.kt` wires these to `viewModel.setTtsEngine(...)` and `dependencies.uiCoordinator.persistTtsEngine(...)`. The engine swap is a hot operation: changing the chip stops the current playback, recreates the engine, and (if Pocket TTS is now selected) hands off playback to the new engine. For v1, the simplest acceptable behavior: changing the engine stops playback and the user re-taps Play.

## 4. Data model changes (none)

No new tables, no Room migrations, no DataStore version bump (preferences are version-less by design). The three new DataStore keys are additive; old installs get the defaults.

## 5. Test plan

| Test | Type | Owner | What it covers |
|---|---|---|---|
| `PocketTtsClientTest` | Unit | Jamie | multipart request shape, default voice, 4xx/5xx mapping, network error, response body is bytes |
| `PdfTextExtractorTest` | Unit | Cody | multi-page concatenation, empty-page skip, corrupted PDF throws |
| `PocketTtsPreferenceTest` | Instrumentation | Cody | save and reload `pocketTtsBaseUrl` across DataStore restart |
| `TtsManagerFacadeTest` | Unit | Cody | `setEngine(...)` swaps engine, `speak(...)` delegates to the new engine |
| `tools/probe-pocket-tts.ps1` | Script | Jamie | integration smoke: POST to /tts, verify WAV magic |

`./gradlew test` runs unit tests. `connectedAndroidTest` needs an emulator — out of scope for v1 (we ship without it and note the limitation).

## 6. File-touch summary (the contract between workers)

| File | Action | Owner |
|---|---|---|
| `tts/SpeechEngine.kt` | NEW | Cody |
| `tts/AndroidTtsEngine.kt` | NEW (extracted from TtsManager body) | Cody |
| `tts/PocketTtsEngine.kt` | NEW | Cody |
| `tts/PocketTtsClient.kt` | NEW | Cody |
| `tts/PocketTtsException.kt` | NEW | Cody |
| `tts/TtsManager.kt` | MODIFIED (becomes facade) | Cody |
| `domain/PdfImportController.kt` | NEW | Cody |
| `domain/PdfTextExtractor.kt` | NEW | Cody |
| `domain/ReaderActivityResultController.kt` | MODIFIED (add PDF launcher) | Cody |
| `domain/ReaderAppDependencies.kt` | MODIFIED (wire new pieces) | Cody |
| `data/ReaderPreferences.kt` | MODIFIED (3 new fields) | Cody |
| `ui/ReaderScreen.kt` | MODIFIED (button + engine selector only) | Cody |
| `MainActivity.kt` | MODIFIED (wire new UI callbacks) | Cody |
| `AndroidManifest.xml` | MODIFIED (networkSecurityConfig) | Cody |
| `res/xml/network_security_config.xml` | NEW | Cody |
| `app/build.gradle.kts` | MODIFIED (3 new deps) | Cody |
| `tools/launch-pocket-tts.ps1` | NEW | Jamie |
| `tools/probe-pocket-tts.ps1` | NEW | Jamie |
| `app/src/test/.../PocketTtsClientTest.kt` | NEW | Jamie |
| `DEV.md` | NEW | Jamie |
| `README.md` | MODIFIED (append) | Jamie |

No two workers touch the same file. This is enforced by the team plan and verified by the verifier.

## 7. Out of scope (explicit)

- **Live word highlight in pocket-tts mode** (no timing data; v2 can estimate from audio progress).
- **Cloud TTS fallback** (no Google Cloud, no ElevenLabs, no Kokoro).
- **Per-page navigation in PDFs** (v1 concatenates everything into one text blob).
- **Voice enrollment** (built-in voices only).
- **The WIP in James's clone 1** (PageNumberExtractor, accessibility state, ImageBitmapLoader mods). The team works in clone 2; James merges at his discretion.
- **Replacing the Android TTS path** — it stays as a user-selectable alternative.

## 8. Acceptance criteria (the verifier's checklist)

- `./gradlew test` exits 0 on `feat/pdf-pocket-tts` HEAD.
- `./gradlew lint` exits 0 (or only emits pre-existing warnings; new warnings are failures).
- `tools/probe-pocket-tts.ps1` against a running `serve_local.py --port 8765` returns a WAV with the `RIFF` magic in the first 4 bytes.
- `PocketTtsClientTest` and `PdfTextExtractorTest` are green.
- The README has a "Drop PDF + Pocket TTS" section that tells the user how to launch the dev server and where to point the URL field.
- No file in §6 is modified by the wrong worker (verifier confirms with `git diff main..feat/pdf-pocket-tts --name-only`).
- The Android TTS path still works (regression check): build a debug APK, run unit tests, confirm `AndroidTtsEngine` is constructed by default.
- Manifest, network security config, and the three new DataStore keys are present in the diff.

## 9. Time budget

- Cody: ~3 hours for the Android side (largest surface area — TtsManager facade, two new engines, PDF pipeline, UI, manifest, prefs).
- Jamie: ~1 hour for dev tooling + the one unit test.
- Kai (verifier): ~30 min for the gauntlet, including a real probe against a running pocket-tts server.
- Manager (Mavis): monitor + cycle decisions, ~30 min active.

If a worker reports a blocker, Mavis decides: steer, retry, or escalate to James.
