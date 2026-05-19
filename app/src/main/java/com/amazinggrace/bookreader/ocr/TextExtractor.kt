package com.amazinggrace.bookreader.ocr

import android.graphics.Bitmap

sealed class OcrExtractionResult {
    data class Success(val text: String) : OcrExtractionResult()
    data class Failure(val message: String) : OcrExtractionResult()
}

interface TextExtractor {
    suspend fun extractText(bitmap: Bitmap): OcrExtractionResult
}
