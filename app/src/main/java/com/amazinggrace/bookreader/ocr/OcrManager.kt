package com.amazinggrace.bookreader.ocr

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext

class OcrManager : TextExtractor {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    override suspend fun extractText(bitmap: Bitmap): OcrExtractionResult = withContext(Dispatchers.Default) {
        val image = InputImage.fromBitmap(bitmap, 0)
        val result = recognizer.process(image).await()
        val normalizedText = result.text.trim()

        when {
            normalizedText.isBlank() -> {
                OcrExtractionResult.Failure(
                    "No text detected. Please make sure the text is clear, well-lit, and try again."
                )
            }

            normalizedText.length < MIN_ACCEPTED_CHAR_COUNT -> {
                OcrExtractionResult.Failure(
                    "Text looks unclear. Try a closer, sharper photo with better contrast."
                )
            }

            else -> OcrExtractionResult.Success(normalizedText)
        }
    }

    fun close() {
        recognizer.close()
    }

    private companion object {
        const val MIN_ACCEPTED_CHAR_COUNT = 12
    }
}
