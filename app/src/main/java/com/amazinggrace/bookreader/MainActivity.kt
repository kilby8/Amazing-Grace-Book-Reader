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
                        onPickImage = { dependencies.activityResultController.launchPhotoPicker() },
                        onTakePhoto = { dependencies.activityResultController.launchCameraCapture() },
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
}
