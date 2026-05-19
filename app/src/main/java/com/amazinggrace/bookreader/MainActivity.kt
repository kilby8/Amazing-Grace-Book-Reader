package com.amazinggrace.bookreader

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch

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
    val scope = rememberCoroutineScope()

    var extractedText by remember { mutableStateOf("") }
    var selectedImageUri by remember { mutableStateOf<Uri?>(null) }
    var statusMessage by remember { mutableStateOf("Select a screenshot to extract text.") }

    val requiredReadPermission = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
    }

    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        selectedImageUri = uri
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            imagePickerLauncher.launch("image/*")
        } else {
            statusMessage = "Gallery access permission is required to pick screenshots."
        }
    }

    LaunchedEffect(selectedImageUri) {
        selectedImageUri?.let { uri ->
            statusMessage = "Running OCR..."
            runCatching {
                extractedText = ocrManager.extractText(uri)
                if (extractedText.isBlank()) {
                    statusMessage = "No text found in the selected image."
                } else {
                    statusMessage = "Text extracted successfully."
                }
            }.onFailure {
                extractedText = ""
                statusMessage = "OCR failed: ${it.localizedMessage ?: "Unknown error"}"
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
            onClick = {
                val isPermissionGranted = ContextCompat.checkSelfPermission(
                    context,
                    requiredReadPermission
                ) == PackageManager.PERMISSION_GRANTED

                if (isPermissionGranted || Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                    imagePickerLauncher.launch("image/*")
                } else {
                    permissionLauncher.launch(requiredReadPermission)
                }
            }
        ) {
            Text(text = stringResource(R.string.pick_image))
        }

        Text(
            text = statusMessage,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary
        )

        Text(
            text = if (extractedText.isBlank()) "Extracted text appears here." else extractedText,
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
                    scope.launch {
                        if (ttsManager.playbackState == TtsManager.PlaybackState.PAUSED) {
                            ttsManager.resume()
                        } else {
                            ttsManager.speak(extractedText)
                        }
                    }
                }
            ) {
                Text(stringResource(R.string.play))
            }

            Button(
                modifier = Modifier.weight(1f),
                onClick = { ttsManager.pause() }
            ) {
                Text(stringResource(R.string.pause))
            }

            Button(
                modifier = Modifier.weight(1f),
                onClick = { ttsManager.stop() }
            ) {
                Text(stringResource(R.string.stop))
            }
        }

        Spacer(modifier = Modifier.height(4.dp))
    }
}
