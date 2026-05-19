package com.amazinggrace.bookreader.domain

import android.graphics.Bitmap
import com.amazinggrace.bookreader.ocr.OcrExtractionResult
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
        return when (val extraction = textExtractor.extractText(bitmap)) {
            is OcrExtractionResult.Success -> {
                withContext(Dispatchers.IO) {
                    sessionWriter.saveLastParsedText(extraction.text)
                    historyWriter.saveScan(extraction.text)
                }

                ReaderOcrResult(
                    text = extraction.text,
                    statusText = "OCR complete. Ready to play audio."
                )
            }

            is OcrExtractionResult.Failure -> {
                withContext(Dispatchers.IO) {
                    sessionWriter.saveLastParsedText("")
                }

                ReaderOcrResult(
                    text = "",
                    statusText = extraction.message
                )
            }
        }
    }
}
