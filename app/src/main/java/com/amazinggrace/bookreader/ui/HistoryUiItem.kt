package com.amazinggrace.bookreader.ui

data class HistoryUiItem(
    val id: Long,
    val createdAtEpochMillis: Long,
    val textSnippet: String,
    val fullText: String
)
