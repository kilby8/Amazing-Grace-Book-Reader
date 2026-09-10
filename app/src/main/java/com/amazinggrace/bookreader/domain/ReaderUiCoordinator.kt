package com.amazinggrace.bookreader.domain

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.lifecycleScope
import com.amazinggrace.bookreader.data.ReaderSessionRepository
import com.amazinggrace.bookreader.ui.HistoryUiItem
import com.amazinggrace.bookreader.ui.ReaderViewModel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class ReaderUiCoordinator(
    private val lifecycleOwner: LifecycleOwner,
    private val viewModel: ReaderViewModel,
    private val sessionRepository: ReaderSessionRepository,
    private val historyRepository: com.amazinggrace.bookreader.history.ScanHistoryRepository,
    private val playbackController: ReaderPlaybackController
) {

    fun start() {
        lifecycleOwner.lifecycleScope.launch {
            loadPersistedSession()
        }

        lifecycleOwner.lifecycleScope.launch {
            lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    ReaderPlaybackStateStore.activeRange.collectLatest { range ->
                        viewModel.setPlaybackHighlight(
                            start = range?.start,
                            endExclusive = range?.endExclusive
                        )
                    }
                }
                launch {
                    historyRepository.observeHistory().collectLatest { historyItems ->
                        viewModel.setHistory(historyItems)
                    }
                }
            }
        }
    }

    fun persistSelectedText(text: String) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.saveLastParsedText(text)
        }
    }

    fun handleHistorySelection(item: HistoryUiItem) {
        viewModel.selectHistoryText(item.fullText)
        playbackController.prepareText(item.fullText)
        persistSelectedText(item.fullText)
    }

    fun persistVoiceSettings(speechRate: Float, pitch: Float) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.saveVoiceSettings(speechRate, pitch)
        }
    }

    fun persistTextScale(textScale: Float) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.saveTextScale(textScale)
        }
    }

    fun persistTtsEngine(engine: String) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.saveTtsEngine(engine)
        }
    }

    fun persistPocketTtsBaseUrl(url: String) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.savePocketTtsBaseUrl(url)
        }
    }

    fun persistPocketTtsVoice(voice: String) {
        lifecycleOwner.lifecycleScope.launch {
            sessionRepository.savePocketTtsVoice(voice)
        }
    }

    fun deleteHistoryItem(id: Long) {
        lifecycleOwner.lifecycleScope.launch {
            historyRepository.deleteById(id)
        }
    }

    fun restoreHistoryItem(item: HistoryUiItem) {
        lifecycleOwner.lifecycleScope.launch {
            historyRepository.restore(item)
        }
    }

    private suspend fun loadPersistedSession() {
        val snapshot = sessionRepository.loadSnapshot()
        viewModel.setVoiceSettings(snapshot.speechRate, snapshot.pitch)
        viewModel.setTextScale(snapshot.textScale)
        viewModel.setTtsEngine(snapshot.ttsEngine)
        viewModel.setPocketTtsBaseUrl(snapshot.pocketTtsBaseUrl)
        viewModel.setPocketTtsVoice(snapshot.pocketTtsVoice)
        playbackController.updateVoiceSettings(snapshot.speechRate, snapshot.pitch)

        if (snapshot.lastParsedText.isNotBlank()) {
            viewModel.restoreSavedSession(snapshot.lastParsedText)
            playbackController.prepareText(snapshot.lastParsedText)
        }
    }
}
