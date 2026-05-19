package com.amazinggrace.bookreader

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

class OcrManager(private val context: Context) {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    suspend fun extractText(uri: Uri): String = withContext(Dispatchers.IO) {
        val image = InputImage.fromFilePath(context, uri)
        recognize(image)
    }

    suspend fun extractText(bitmap: Bitmap): String = withContext(Dispatchers.IO) {
        val image = InputImage.fromBitmap(bitmap, 0)
        recognize(image)
    }

    private suspend fun recognize(image: InputImage): String = suspendCancellableCoroutine { continuation ->
        recognizer
            .process(image)
            .addOnSuccessListener {
                if (continuation.isActive) continuation.resume(it.text)
            }
            .addOnFailureListener {
                if (continuation.isActive) continuation.resumeWithException(it)
            }
    }

    fun close() {
        recognizer.close()
    }
}
