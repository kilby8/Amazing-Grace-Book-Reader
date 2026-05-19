package com.amazinggrace.bookreader.ocr

import android.graphics.Bitmap

interface TextExtractor {
    suspend fun extractText(bitmap: Bitmap): String
}
