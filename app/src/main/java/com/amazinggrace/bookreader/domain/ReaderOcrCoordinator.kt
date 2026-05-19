package com.amazinggrace.bookreader.domain

import android.graphics.Bitmap
import com.amazinggrace.bookreader.ocr.TextExtractor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

interface SessionTextWriter {
    suspend fun saveLastParsedText(text: String)
}

interface HistoryTextWriter {
    suspend fun saveScan(fullText: String)
}

data class ReaderOcrResult(
    val text: String,
    val statusText: String
)

class ReaderOcrCoordinator(
    private val textExtractor: TextExtractor,
    private val sessionWriter: SessionTextWriter,
    private val historyWriter: HistoryTextWriter
) {

    suspend fun process(bitmap: Bitmap): ReaderOcrResult {
        val text = textExtractor.extractText(bitmap)

        withContext(Dispatchers.IO) {
            sessionWriter.saveLastParsedText(text)
            if (text.isNotBlank()) {
                historyWriter.saveScan(text)
            }
        }

        val statusText = if (text.isBlank()) {
            "No text found in image."
        } else {
            "OCR complete. Ready to play audio."
        }

        return ReaderOcrResult(text = text, statusText = statusText)
    }
}
