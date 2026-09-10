package com.amazinggrace.bookreader

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.amazinggrace.bookreader.domain.ReaderAppDependencies
import com.amazinggrace.bookreader.tts.PocketTtsClient
import com.amazinggrace.bookreader.tts.PocketTtsEngine
import com.amazinggrace.bookreader.ui.ReaderScreen
import com.amazinggrace.bookreader.ui.ReaderViewModel

class MainActivity : ComponentActivity() {

    private val viewModel: ReaderViewModel by viewModels()
    private lateinit var dependencies: ReaderAppDependencies

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        dependencies = ReaderAppDependencies.create(
            caller = this,
            context = this,
            cacheDir = cacheDir,
            viewModel = viewModel
        )
        dependencies.uiCoordinator.start()

        setContent {
            val uiState by viewModel.uiState.collectAsStateWithLifecycle()
            MaterialTheme {
                Surface {
                    ReaderScreen(
                        parsedText = uiState.parsedText,
                        statusText = uiState.statusText,
                        isProcessing = uiState.isProcessing,
                        speechRate = uiState.speechRate,
                        pitch = uiState.pitch,
                        textScale = uiState.textScale,
                        activeHighlightStart = uiState.activeHighlightStart,
                        activeHighlightEndExclusive = uiState.activeHighlightEndExclusive,
                        historyItems = uiState.historyItems,
                        ttsEngine = uiState.ttsEngine,
                        pocketTtsBaseUrl = uiState.pocketTtsBaseUrl,
                        pocketTtsVoice = uiState.pocketTtsVoice,
                        onPickImage = { dependencies.activityResultController.launchPhotoPicker() },
                        onTakePhoto = { dependencies.activityResultController.launchCameraCapture() },
                        onPickPdf = { dependencies.activityResultController.launchPdfPicker() },
                        onHistoryItemClick = { item -> dependencies.uiCoordinator.handleHistorySelection(item) },
                        onDeleteHistoryItem = { item ->
                            dependencies.uiCoordinator.deleteHistoryItem(item.id)
                        },
                        onRestoreHistoryItem = { item ->
                            dependencies.uiCoordinator.restoreHistoryItem(item)
                        },
                        onCopyText = { dependencies.textActions.copyToClipboard(uiState.parsedText) },
                        onShareText = { dependencies.textActions.shareText(uiState.parsedText) },
                        onSpeechRateChange = { value ->
                            viewModel.setSpeechRate(value)
                            dependencies.playbackController.updateVoiceSettings(
                                speechRate = value,
                                pitch = uiState.pitch
                            )
                        },
                        onPitchChange = { value ->
                            viewModel.setPitch(value)
                            dependencies.playbackController.updateVoiceSettings(
                                speechRate = uiState.speechRate,
                                pitch = value
                            )
                        },
                        onTextScaleChange = { value ->
                            viewModel.setTextScale(value)
                            dependencies.uiCoordinator.persistTextScale(
                                viewModel.uiState.value.textScale
                            )
                        },
                        onSpeechRateChangeFinished = {
                            dependencies.uiCoordinator.persistVoiceSettings(
                                viewModel.uiState.value.speechRate,
                                viewModel.uiState.value.pitch
                            )
                        },
                        onPitchChangeFinished = {
                            dependencies.uiCoordinator.persistVoiceSettings(
                                viewModel.uiState.value.speechRate,
                                viewModel.uiState.value.pitch
                            )
                        },
                        onTtsEngineChange = { engine ->
                            viewModel.setTtsEngine(engine)
                            dependencies.uiCoordinator.persistTtsEngine(engine)
                            swapTtsEngine(engine)
                        },
                        onPocketTtsBaseUrlChange = { url ->
                            viewModel.setPocketTtsBaseUrl(url)
                            dependencies.uiCoordinator.persistPocketTtsBaseUrl(url)
                        },
                        onPocketTtsVoiceChange = { voice ->
                            viewModel.setPocketTtsVoice(voice)
                            dependencies.uiCoordinator.persistPocketTtsVoice(voice)
                        },
                        onPlay = {
                            dependencies.playbackController.play(
                                text = uiState.parsedText,
                                speechRate = uiState.speechRate,
                                pitch = uiState.pitch
                            )
                        },
                        onPause = { dependencies.playbackController.pause() },
                        onStop = { dependencies.playbackController.stop() }
                    )
                }
            }
        }

        dependencies.activityResultController.requestMediaPermissions()
    }

    override fun onDestroy() {
        dependencies.close()
        super.onDestroy()
    }

    /**
     * Hot-swap the TtsManager's engine to match the user's selection. Per DESIGN §3.2 the
     * v1 behavior on a swap is "stop playback and the user re-taps Play". The pocket-tts
     * engine needs a fresh client because the URL/voice may have just changed.
     */
    private fun swapTtsEngine(engine: String) {
        dependencies.playbackController.stop()
        if (engine == "pocket_tts") {
            val snapshot = viewModel.uiState.value
            val client = PocketTtsClient(
                baseUrl = snapshot.pocketTtsBaseUrl,
                voice = snapshot.pocketTtsVoice
            )
            val pocketEngine = PocketTtsEngine(
                context = applicationContext,
                lifecycle = this.lifecycle,
                client = client,
                tempFileFactory = { name ->
                    val dir = java.io.File(cacheDir, "tts").apply { mkdirs() }
                    java.io.File(dir, name)
                }
            )
            dependencies.ttsManager.setEngine(pocketEngine)
        } else {
            // AndroidTtsEngine — recreate so the next speak starts from a clean state.
            val androidEngine = com.amazinggrace.bookreader.tts.AndroidTtsEngine(
                applicationContext,
                this.lifecycle
            )
            dependencies.ttsManager.setEngine(androidEngine)
        }
    }
}
