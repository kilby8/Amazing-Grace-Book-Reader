package com.amazinggrace.bookreader.ui

import androidx.lifecycle.ViewModel
import com.amazinggrace.bookreader.domain.ReaderOcrResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

class ReaderViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(ReaderUiState())
    val uiState: StateFlow<ReaderUiState> = _uiState.asStateFlow()

    fun setProcessing(processing: Boolean) {
        _uiState.update { it.copy(isProcessing = processing) }
    }

    fun startOcr() {
        _uiState.update {
            it.copy(
                isProcessing = true,
                statusText = "Running OCR on device..."
            )
        }
    }

    fun applyOcrResult(result: ReaderOcrResult) {
        _uiState.update {
            it.copy(
                parsedText = result.text,
                statusText = result.statusText,
                isProcessing = false
            )
        }
    }

    fun failOcr(message: String) {
        _uiState.update {
            it.copy(
                parsedText = "",
                statusText = "OCR failed: $message",
                isProcessing = false
            )
        }
    }

    fun setStatus(status: String) {
        _uiState.update { it.copy(statusText = status) }
    }

    fun setParsedText(text: String) {
        _uiState.update { it.copy(parsedText = text) }
    }

    fun selectHistoryText(text: String) {
        _uiState.update {
            it.copy(
                parsedText = text,
                statusText = "Loaded scan from history."
            )
        }
    }

    fun restoreSavedSession(text: String) {
        _uiState.update {
            it.copy(
                parsedText = text,
                statusText = "Restored previous reading session."
            )
        }
    }

    fun setVoiceSettings(speechRate: Float, pitch: Float) {
        _uiState.update { it.copy(speechRate = speechRate, pitch = pitch) }
    }

    fun setSpeechRate(speechRate: Float) {
        _uiState.update { it.copy(speechRate = speechRate) }
    }

    fun setPitch(pitch: Float) {
        _uiState.update { it.copy(pitch = pitch) }
    }

    fun setTextScale(textScale: Float) {
        _uiState.update { it.copy(textScale = textScale.coerceIn(0.85f, 1.4f)) }
    }

    fun setHighlightRange(start: Int?, endExclusive: Int?) {
        _uiState.update {
            it.copy(
                activeHighlightStart = start,
                activeHighlightEndExclusive = endExclusive
            )
        }
    }

    fun setHistory(items: List<HistoryUiItem>) {
        _uiState.update { it.copy(historyItems = items) }
    }

    fun setPlaybackHighlight(start: Int?, endExclusive: Int?) {
        setHighlightRange(start, endExclusive)
    }
}
