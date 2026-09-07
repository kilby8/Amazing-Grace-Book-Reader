# DEV — local development for the "Drop PDF + Pocket TTS" feature

This doc covers everything a Windows / PowerShell dev needs to run the
**pocket-tts** path of the Amazing Grace Book Reader app end-to-end. The
feature work itself (Android-side) is described in
[`DESIGN.md`](./DESIGN.md); this file is the dev-environment companion.

If you only need to *use* the app, you do not need any of this. The
Android-side TTS path is still the default; pocket-tts is an opt-in.

## Prerequisites

- **Windows 10 or 11 with PowerShell 5.1+ (or PowerShell 7.x).** All scripts
  in `tools/` are PowerShell-only; no bash or WSL.
- **JDK 17** on `PATH`. The Android build targets `jvmTarget = "17"`.
- **Android SDK** with `platforms;android-35` and `build-tools;35.0.0`. The
  repo's `local.properties` already points at
  `C:\Users\carpe\AppData\Local\Android\Sdk`; edit it if your SDK lives
  elsewhere.
- **Python 3.10+** with the `pocket-tts` venv already set up at
  `C:\Users\carpe\.minimax\experiments\pocket-tts\.venv`. That venv contains
  `pocket_tts`, `fastapi`, and `uvicorn`, all of which `serve_local.py`
  imports.
- **(Optional) An Android emulator or device.** The unit-test gauntlet
  (`./gradlew test`) does not need one. Connecting to pocket-tts from a real
  device or emulator does — see "Configuring the app to point at your local
  server" below.

## First run

From a fresh clone at `C:\Users\carpe\.openclaw\workspace\projects\amazing-grace-book-reader`:

```powershell
# 1. Make sure local.properties is set (it ships with a default).
#    Skip if you've already pointed your SDK at the right place.
Get-Content .\local.properties

# 2. Run the unit-test gauntlet. This is the smoke test for the build env.
.\gradlew.bat test
```

If `./gradlew.bat test` exits 0, your dev env is set up correctly and you can
move on to "Running pocket-tts locally".

> **Note on `assembleDebug`:** the d8 worker OOMs on this Windows host even on
> the unmodified `main` branch, because the AGP-8.5 d8 fork's 2 GB heap is
> close to the limit once `media3` and `pdfbox-android` are merged into the
> dex. This is a known pre-existing issue, not something the
> `feat/pdf-pocket-tts` work introduced. The unit-test gauntlet
> (`./gradlew.bat test`) is the green gate for now; full APK builds will
> need the d8 heap raised once the team gets a machine with enough RAM.

## Running pocket-tts locally

The Android app talks to a local HTTP server (`serve_local.py`) that wraps the
`pocket-tts` model. Start it before launching the app in pocket-tts mode.

```powershell
# Start the server in the background. Writes the PID to .\.pocket-tts.pid
# and waits up to ~30 s for the /health endpoint to come up.
.\tools\launch-pocket-tts.ps1
```

What that does:

- Activates the venv at `C:\Users\carpe\.minimax\experiments\pocket-tts\.venv`
  (if present); otherwise warns and falls back to `python` on PATH.
- Runs `python serve_local.py --port 8765 --voice eve` in the background.
- Binds to `127.0.0.1:8765` (loopback only — no LAN exposure).
- Writes stdout/stderr to `launcher.stdout.log` and `launcher.stderr.log`
  inside the pocket-tts directory.
- Saves the launched PID to `.pocket-tts.pid` in the repo root.

To override the default port or voice:

```powershell
.\tools\launch-pocket-tts.ps1 -Port 9000 -Voice alba
```

To stop the server:

```powershell
.\tools\launch-pocket-tts.ps1 -Kill
```

The launcher is **idempotent**: if a server is already reachable on the
requested URL, it reports that and exits 0 without starting a second
instance.

### Smoke-test the endpoint

Once the launcher reports "pocket-tts is up", confirm the wire protocol with
the bundled probe:

```powershell
# Wait ~5 s after launch for the model to finish pre-encoding the default voice.
Start-Sleep -Seconds 5
.\tools\probe-pocket-tts.ps1
# Expect:
#   PASS: http://127.0.0.1:8765/tts returned a valid WAV
#   HTTP 200
#   Content-Type: audio/wav
#   Body length:  NNNN bytes
#   First 4 bytes: RIFF (WAV magic confirmed)
```

The probe POSTs a short test string to `/tts` and verifies the response is
`audio/wav` starting with the `RIFF` magic. Exits 0 on PASS, 1 on FAIL.
Override the URL with `-BaseUrl` if you launched on a different port.

## Configuring the app to point at your local server

The Android app picks its pocket-tts server URL from a DataStore-backed
preference. The default is **`http://10.0.2.2:8765`** — the magic IP that
maps to the host machine's loopback from inside an Android emulator. That
matches the launcher default above, so out of the box:

1. Run `.\tools\launch-pocket-tts.ps1` on the host.
2. Launch the app in an Android emulator.
3. In the app, switch the TTS engine selector to **Pocket TTS** (in the
   settings sheet under the text area). The Server URL field will already
   read `http://10.0.2.2:8765`; the Voice field will read `eve`.
4. Tap **Open PDF** to pick a PDF, then **Play**. The text is sent to
   pocket-tts, the returned WAV is played via ExoPlayer.

For a **physical device** on the same Wi-Fi as the dev machine, replace
`10.0.2.2` with the dev machine's LAN IP, e.g. `http://192.168.1.42:8765`.
The app's `network_security_config.xml` only permits cleartext to
`10.0.2.2`, `127.0.0.1`, and `localhost`; for other addresses you'll need to
add the dev IP to the `<domain>` list (Cody owns that file, per
`DESIGN.md` §6) and rebuild.

The voice field is sent as the `voice_url` form field to the server. Built-in
voice names (`eve`, `alba`, `lola`, ...) work out of the box; `http(s)://`
and `hf://` URLs also work.

## Troubleshooting

### "pocket-tts is not reachable at http://127.0.0.1:8765"

The launcher is not running. Run `.\tools\launch-pocket-tts.ps1` (or
`launch-pocket-tts.ps1 -Kill` first if a stale pidfile points at a dead
process).

### Launcher exits with "did not respond within 30s"

The model is still loading. On cold start, the first request can take 20-30s
while the default voice gets pre-encoded. Check the log files for progress:

```powershell
Get-Content 'C:\Users\carpe\.minimax\experiments\pocket-tts\launcher.stderr.log' -Tail 30
```

Wait a bit longer, then re-run `.\tools\probe-pocket-tts.ps1`. The
`TTSModel loaded` line marks when the model is ready.

### Probe returns "expected Content-Type to start with 'audio/wav'"

Either the server returned an error (check the probe's body output for the
JSON error), or you're hitting a different service on that port. The
launcher refuses to start a second instance if a server is already
reachable, so a port collision is the most common cause — try a different
port: `launch-pocket-tts.ps1 -Port 9000` and
`probe-pocket-tts.ps1 -BaseUrl http://127.0.0.1:9000`.

### App says "pocket-tts returned 4xx" on Play

The app reached the server but the request was rejected. Most common cause:
**empty text** (the `/tts` endpoint rejects whitespace-only input with
HTTP 400). Less common: the voice you specified isn't a built-in name and
isn't a valid `http(s)://`, `hf://`, or file path. Try `eve` first; if that
works, your voice identifier is the problem.

### App says "pocket-tts returned 5xx" / "voice setup failed"

Server-side issue. Check `launcher.stderr.log` in the pocket-tts
directory. The model failed to encode the voice (corrupt wav file,
unsupported format, etc.). Reverting to a built-in name (`eve`) confirms
whether the issue is the voice asset or the install.

### "could not connect" from a physical device

You're hitting the Android cleartext-traffic block. The app's
`network_security_config.xml` only permits cleartext to `10.0.2.2`,
`127.0.0.1`, and `localhost`. Use one of those (10.0.2.2 from an emulator,
or a USB-reverse-tethered loopback), or escalate to Cody to add the dev
machine's LAN IP to the allowlist.

## Running tests

The unit-test gauntlet is the only test gate in v1.

```powershell
# All unit tests (PlaybacksSessionState, PdfTextExtractor, TtsManagerFacade,
# PocketTtsClient, etc.).
.\gradlew.bat test

# Just the new pocket-tts client test:
.\gradlew.bat test --tests "*PocketTtsClientTest" --info
```

`PocketTtsClientTest` uses OkHttp's `MockWebServer` and `Truth` for
assertions. It is plain JUnit (no Robolectric) because `PocketTtsClient` is
pure JVM + OkHttp. The full gauntlet takes <30 s on a warm dev machine.

`./gradlew.bat assembleDebug` is **out of scope** for v1's test gate — the
d8 worker OOMs on this Windows host (see "First run" above). Treat
`./gradlew.bat test` as the green light.
