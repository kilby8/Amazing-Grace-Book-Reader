package com.amazinggrace.bookreader

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    ReaderScreen()
                }
            }
        }
    }
}

@Composable
private fun ReaderScreen() {
    val context = LocalContext.current
    val ocrManager = remember { OcrManager(context) }
    val ttsManager = remember { TtsManager(context) }

    var extractedText by remember { mutableStateOf("") }
    var selectedImageUri by remember { mutableStateOf<Uri?>(null) }
    var statusMessage by remember { mutableStateOf(context.getString(R.string.status_select_screenshot)) }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        selectedImageUri = uri
    }

    LaunchedEffect(selectedImageUri) {
        selectedImageUri?.let { uri ->
            statusMessage = context.getString(R.string.status_running_ocr)
            runCatching {
                extractedText = ocrManager.extractText(uri)
                if (extractedText.isBlank()) {
                    statusMessage = context.getString(R.string.status_no_text_found)
                } else {
                    statusMessage = context.getString(R.string.status_text_extracted)
                }
            }.onFailure {
                extractedText = ""
                statusMessage = context.getString(
                    R.string.status_ocr_failed,
                    it.localizedMessage ?: "Unknown error"
                )
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            ttsManager.shutdown()
            ocrManager.close()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Button(
            onClick = { imagePickerLauncher.launch("image/*") }
        ) {
            Text(text = stringResource(R.string.pick_image))
        }

        Text(
            text = statusMessage,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary
        )

        Text(
            text = if (extractedText.isBlank()) stringResource(R.string.placeholder_extracted_text) else extractedText,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            style = MaterialTheme.typography.bodyLarge
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                modifier = Modifier.weight(1f),
                onClick = {
                    if (extractedText.isBlank()) {
                        statusMessage = context.getString(R.string.status_no_text_to_play)
                        return@Button
                    }

                    when (ttsManager.playbackState) {
                        TtsManager.PlaybackState.PAUSED -> {
                            ttsManager.resume()
                            statusMessage = context.getString(R.string.status_playback_restarted)
                        }
                        TtsManager.PlaybackState.PLAYING -> {
                            statusMessage = context.getString(R.string.status_already_playing)
                        }
                        else -> {
                            ttsManager.speak(extractedText)
                            statusMessage = context.getString(R.string.status_playback_started)
                        }
                    }
                }
            ) {
                Text(stringResource(R.string.play))
            }

            Button(
                modifier = Modifier.weight(1f),
                onClick = {
                    if (ttsManager.playbackState == TtsManager.PlaybackState.PLAYING) {
                        ttsManager.pause()
                        statusMessage = context.getString(R.string.status_playback_paused)
                    } else {
                        statusMessage = context.getString(R.string.status_nothing_playing)
                    }
                }
            ) {
                Text(stringResource(R.string.pause))
            }

            Button(
                modifier = Modifier.weight(1f),
                onClick = {
                    if (ttsManager.playbackState != TtsManager.PlaybackState.STOPPED) {
                        ttsManager.stop()
                        statusMessage = context.getString(R.string.status_playback_stopped)
                    } else {
                        statusMessage = context.getString(R.string.status_playback_already_stopped)
                    }
                }
            ) {
                Text(stringResource(R.string.stop))
            }
        }

        Spacer(modifier = Modifier.height(4.dp))
    }
}
