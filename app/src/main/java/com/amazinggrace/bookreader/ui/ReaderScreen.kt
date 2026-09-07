package com.amazinggrace.bookreader.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Divider
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

@Composable
fun ReaderScreen(
    parsedText: String,
    statusText: String,
    isProcessing: Boolean,
    speechRate: Float,
    pitch: Float,
    textScale: Float,
    activeHighlightStart: Int?,
    activeHighlightEndExclusive: Int?,
    historyItems: List<HistoryUiItem>,
    ttsEngine: String,
    pocketTtsBaseUrl: String,
    pocketTtsVoice: String,
    onPickImage: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickPdf: () -> Unit,
    onHistoryItemClick: (HistoryUiItem) -> Unit,
    onDeleteHistoryItem: (HistoryUiItem) -> Unit,
    onRestoreHistoryItem: (HistoryUiItem) -> Unit,
    onCopyText: () -> Unit,
    onShareText: () -> Unit,
    onSpeechRateChange: (Float) -> Unit,
    onPitchChange: (Float) -> Unit,
    onTextScaleChange: (Float) -> Unit,
    onSpeechRateChangeFinished: () -> Unit,
    onPitchChangeFinished: () -> Unit,
    onTtsEngineChange: (String) -> Unit,
    onPocketTtsBaseUrlChange: (String) -> Unit,
    onPocketTtsVoiceChange: (String) -> Unit,
    onPlay: () -> Unit,
    onPause: () -> Unit,
    onStop: () -> Unit
) {
    val drawerState = androidx.compose.material3.rememberDrawerState(
        initialValue = androidx.compose.material3.DrawerValue.Closed
    )
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var showVoiceSettings by rememberSaveable { mutableStateOf(false) }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Recent Scans",
                        style = MaterialTheme.typography.titleLarge
                    )
                    Divider()
                    if (historyItems.isEmpty()) {
                        Text(
                            text = "No scans saved yet.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        historyItems.forEach { item ->
                            val formattedTime = remember(item.createdAtEpochMillis) {
                                SimpleDateFormat("MMM d, yyyy h:mm a", Locale.getDefault())
                                    .format(Date(item.createdAtEpochMillis))
                            }

                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        onHistoryItemClick(item)
                                        scope.launch { drawerState.close() }
                                    }
                                    .padding(vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Text(
                                        modifier = Modifier.weight(1f),
                                        text = item.textSnippet,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium
                                    )
                                    TextButton(onClick = {
                                        onDeleteHistoryItem(item)
                                        scope.launch {
                                            val result = snackbarHostState.showSnackbar(
                                                message = "Scan deleted",
                                                actionLabel = "Undo",
                                                duration = SnackbarDuration.Short
                                            )
                                            if (result == androidx.compose.material3.SnackbarResult.ActionPerformed) {
                                                onRestoreHistoryItem(item)
                                            }
                                        }
                                    }) {
                                        Text("Delete")
                                    }
                                }
                                Text(
                                    text = formattedTime,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Divider()
                            }
                        }
                    }
                }
            }
        }
    ) {
        Scaffold(
            snackbarHost = {
                SnackbarHost(hostState = snackbarHostState)
            },
            bottomBar = {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onPlay,
                        enabled = parsedText.isNotBlank()
                    ) {
                        Text("Play")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onPause,
                        enabled = parsedText.isNotBlank()
                    ) {
                        Text("Pause")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onStop,
                        enabled = parsedText.isNotBlank()
                    ) {
                        Text("Stop")
                    }
                }
            }
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onTakePhoto,
                        enabled = !isProcessing
                    ) {
                        Text("Take Photo")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = onPickImage,
                        enabled = !isProcessing
                    ) {
                        Text(if (isProcessing) "Processing..." else "Import Screenshot")
                    }
                    OutlinedButton(
                        modifier = Modifier.weight(1f),
                        onClick = onPickPdf,
                        enabled = !isProcessing
                    ) {
                        Icon(Icons.Filled.PictureAsPdf, contentDescription = null)
                        Spacer(Modifier.width(4.dp))
                        Text("Open PDF")
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = { scope.launch { drawerState.open() } }
                    ) {
                        Text("History")
                    }
                    Button(
                        modifier = Modifier.weight(1f),
                        onClick = { showVoiceSettings = !showVoiceSettings }
                    ) {
                        Text(if (showVoiceSettings) "Hide Voice Settings" else "Show Voice Settings")
                    }
                }

                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                val showOcrIssue = statusText.startsWith("OCR failed") ||
                    statusText.startsWith("No text found") ||
                    statusText.startsWith("No text detected") ||
                    statusText.startsWith("Text looks unclear")
                if (showOcrIssue) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.errorContainer)
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)
                        ) {
                            Text(
                                text = "OCR needs a clearer image",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                            Text(
                                text = "Try better lighting, tighter crop, and higher contrast.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                        }
                    }
                }

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        TextButton(onClick = { onTextScaleChange(0.9f) }) {
                            Text("Text Small")
                        }
                        TextButton(onClick = { onTextScaleChange(1.0f) }) {
                            Text("Text Medium")
                        }
                        TextButton(onClick = { onTextScaleChange(1.2f) }) {
                            Text("Text Large")
                        }
                    }
                }

                if (showVoiceSettings) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp)
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                text = "Voice Settings",
                                style = MaterialTheme.typography.titleMedium
                            )

                            Text(
                                text = "TTS Engine",
                                style = MaterialTheme.typography.titleSmall
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                FilterChip(
                                    selected = ttsEngine == "android",
                                    onClick = { onTtsEngineChange("android") },
                                    label = { Text("Android") }
                                )
                                FilterChip(
                                    selected = ttsEngine == "pocket_tts",
                                    onClick = { onTtsEngineChange("pocket_tts") },
                                    label = { Text("Pocket TTS") }
                                )
                            }
                            if (ttsEngine == "pocket_tts") {
                                OutlinedTextField(
                                    value = pocketTtsBaseUrl,
                                    onValueChange = onPocketTtsBaseUrlChange,
                                    label = { Text("Server URL") },
                                    singleLine = true,
                                    modifier = Modifier.fillMaxWidth()
                                )
                                OutlinedTextField(
                                    value = pocketTtsVoice,
                                    onValueChange = onPocketTtsVoiceChange,
                                    label = { Text("Voice") },
                                    singleLine = true,
                                    modifier = Modifier.fillMaxWidth()
                                )
                                Text(
                                    text = "Pocket TTS has no word-level timing, so live highlight is off in this mode.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }

                            Text(
                                text = "Speech Rate: ${"%.2f".format(speechRate)}x",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Slider(
                                value = speechRate,
                                onValueChange = onSpeechRateChange,
                                onValueChangeFinished = onSpeechRateChangeFinished,
                                valueRange = 0.5f..2.0f
                            )

                            Text(
                                text = "Pitch: ${"%.2f".format(pitch)}x",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Slider(
                                value = pitch,
                                onValueChange = onPitchChange,
                                onValueChangeFinished = onPitchChangeFinished,
                                valueRange = 0.5f..2.0f
                            )
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    IconButton(
                        onClick = onCopyText,
                        enabled = parsedText.isNotBlank()
                    ) {
                        Icon(
                            imageVector = Icons.Filled.ContentCopy,
                            contentDescription = "Copy text"
                        )
                    }
                    IconButton(
                        onClick = onShareText,
                        enabled = parsedText.isNotBlank()
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Share,
                            contentDescription = "Share text"
                        )
                    }
                }

                Card(
                    modifier = Modifier
                        .fillMaxSize(),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    val textScrollState = rememberScrollState()
                    val textToRender = if (parsedText.isBlank()) {
                        "Parsed text will appear here after OCR is complete."
                    } else {
                        parsedText
                    }

                    val highlightedText: AnnotatedString = remember(
                        textToRender,
                        parsedText,
                        activeHighlightStart,
                        activeHighlightEndExclusive
                    ) {
                        buildHighlightedText(
                            text = textToRender,
                            shouldHighlight = parsedText.isNotBlank(),
                            start = activeHighlightStart,
                            endExclusive = activeHighlightEndExclusive
                        )
                    }

                    LaunchedEffect(textToRender, activeHighlightStart, activeHighlightEndExclusive) {
                        if (parsedText.isBlank() || activeHighlightStart == null) {
                            return@LaunchedEffect
                        }

                        val maxValue = textScrollState.maxValue
                        if (maxValue <= 0 || textToRender.isEmpty()) {
                            return@LaunchedEffect
                        }

                        val ratio = activeHighlightStart.toFloat() / textToRender.length.toFloat()
                        val targetScroll = (ratio * maxValue)
                            .roundToInt()
                            .coerceIn(0, maxValue)
                        textScrollState.animateScrollTo(targetScroll)
                    }

                    Text(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(textScrollState)
                            .padding(16.dp),
                        text = highlightedText,
                        style = MaterialTheme.typography.bodyLarge.copy(
                            fontSize = (18f * textScale).sp,
                            lineHeight = (28f * textScale).sp
                        )
                    )
                }
            }
        }
    }
}

private fun buildHighlightedText(
    text: String,
    shouldHighlight: Boolean,
    start: Int?,
    endExclusive: Int?
): AnnotatedString {
    if (!shouldHighlight || start == null || endExclusive == null) {
        return AnnotatedString(text)
    }

    val safeStart = start.coerceIn(0, text.length)
    val safeEnd = endExclusive.coerceIn(0, text.length)
    if (safeStart >= safeEnd) {
        return AnnotatedString(text)
    }

    return buildAnnotatedString {
        append(text)
        addStyle(
            style = SpanStyle(background = Color(0x66FFF176)),
            start = safeStart,
            end = safeEnd
        )
    }
}
