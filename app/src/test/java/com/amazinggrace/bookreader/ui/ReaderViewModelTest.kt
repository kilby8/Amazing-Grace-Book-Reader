package com.amazinggrace.bookreader.ui

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class ReaderViewModelTest {

    @Test
    fun setVoiceSettings_updatesSpeechRateAndPitch() {
        val viewModel = ReaderViewModel()

        viewModel.setVoiceSettings(speechRate = 1.4f, pitch = 0.8f)

        val state = viewModel.uiState.value
        assertThat(state.speechRate).isEqualTo(1.4f)
        assertThat(state.pitch).isEqualTo(0.8f)
    }

    @Test
    fun setHistory_replacesHistoryItems() {
        val viewModel = ReaderViewModel()
        val item = HistoryUiItem(
            id = 1,
            createdAtEpochMillis = 100,
            textSnippet = "Snippet",
            fullText = "Full text"
        )

        viewModel.setHistory(listOf(item))

        val state = viewModel.uiState.value
        assertThat(state.historyItems).hasSize(1)
        assertThat(state.historyItems.first().id).isEqualTo(1)
    }

    @Test
    fun setHighlightRange_updatesState() {
        val viewModel = ReaderViewModel()

        viewModel.setHighlightRange(start = 5, endExclusive = 12)

        val state = viewModel.uiState.value
        assertThat(state.activeHighlightStart).isEqualTo(5)
        assertThat(state.activeHighlightEndExclusive).isEqualTo(12)
    }
}
