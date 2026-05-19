package com.amazinggrace.bookreader.ui

data class ReaderUiState(
    val parsedText: String = "",
    val statusText: String = "Pick a screenshot to parse text on-device.",
    val isProcessing: Boolean = false,
    val speechRate: Float = 1.0f,
    val pitch: Float = 1.0f,
    val textScale: Float = 1.0f,
    val activeHighlightStart: Int? = null,
    val activeHighlightEndExclusive: Int? = null,
    val historyItems: List<HistoryUiItem> = emptyList()
)
