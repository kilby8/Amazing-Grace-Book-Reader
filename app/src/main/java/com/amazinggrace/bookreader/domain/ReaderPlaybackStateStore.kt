package com.amazinggrace.bookreader.domain

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class PlaybackHighlightRange(
    val start: Int,
    val endExclusive: Int
)

object ReaderPlaybackStateStore {
    private val _activeRange = MutableStateFlow<PlaybackHighlightRange?>(null)
    val activeRange: StateFlow<PlaybackHighlightRange?> = _activeRange.asStateFlow()

    fun updateActiveRange(range: PlaybackHighlightRange?) {
        _activeRange.value = range
    }
}
