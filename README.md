# Amazing-Grace-Book-Reader

Native Android app (Kotlin + Jetpack Compose) that:
- Captures or imports page images
- Extracts text fully on-device with ML Kit OCR
- Reads text aloud with TextToSpeech
- Supports pause/resume from last spoken offset
- Continues playback with screen locked via foreground playback service
- Saves recent scans locally with Room history

## Key Features

- Camera capture with full-resolution FileProvider flow
- Gallery/photo picker import
- On-device OCR via Google ML Kit Text Recognition
- TTS playback controls: Play, Pause, Stop
- True pause/resume from spoken position
- Background playback notification controls (Play/Pause/Stop)
- Media-style lockscreen controls with playback metadata
- Live text highlighting and auto-follow scrolling while speaking
- Voice customization: speech rate and pitch sliders
- Reader accessibility controls: small/medium/large text size
- OCR issue guidance banner for low-quality scans
- Local scan history with delete + undo and retention limit (200)
- Copy to clipboard and share extracted text
- Session restore for last text and voice settings using DataStore

## Project Structure

- app/src/main/java/com/amazinggrace/bookreader/MainActivity.kt
- app/src/main/java/com/amazinggrace/bookreader/ocr/OcrManager.kt
- app/src/main/java/com/amazinggrace/bookreader/tts/TtsManager.kt
- app/src/main/java/com/amazinggrace/bookreader/tts/PlaybackSessionState.kt
- app/src/main/java/com/amazinggrace/bookreader/service/ReaderPlaybackService.kt
- app/src/main/java/com/amazinggrace/bookreader/history/
- app/src/main/java/com/amazinggrace/bookreader/data/ReaderPreferences.kt
- app/src/main/java/com/amazinggrace/bookreader/ui/ReaderScreen.kt

## Build & Test

Prerequisites:
- JDK 17
- Android SDK installed and configured

If your local Android SDK is not auto-detected, create local.properties:

sdk.dir=/path/to/android/sdk

Commands:

./gradlew test
./gradlew assembleDebug

## Automated Tests

- Unit tests:
	- app/src/test/java/com/amazinggrace/bookreader/tts/PlaybackSessionStateTest.kt
- Instrumentation tests:
	- app/src/androidTest/java/com/amazinggrace/bookreader/history/ScanHistoryDaoTest.kt
	- app/src/androidTest/java/com/amazinggrace/bookreader/data/ReaderPreferencesTest.kt
