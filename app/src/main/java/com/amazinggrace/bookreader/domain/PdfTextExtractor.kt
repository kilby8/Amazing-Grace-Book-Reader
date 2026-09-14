package com.amazinggrace.bookreader.domain

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.amazinggrace.bookreader.ocr.OcrExtractionResult
import com.amazinggrace.bookreader.ocr.OcrManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Renders every page of a PDF to a bitmap, runs ML Kit OCR via [OcrManager], and
 * concatenates the recognized text (pages joined with a blank line). Pages that
 * yield no text are skipped. Throws on a corrupted PDF, a missing
 * [ParcelFileDescriptor], or a render failure.
 *
 * Uses the platform's built-in [PdfRenderer] (API 21+; this app's minSdk is 24)
 * instead of pdfbox-android so the dexed classpath stays small enough for d8's
 * 2 GB worker heap on memory-constrained dev machines. Trade-off: PDF text is
 * now "render to bitmap, then OCR" rather than "extract embedded text" — slower,
 * but acceptable for the v1 "drop PDF" flow.
 */
object PdfTextExtractor {

    // Lazy so the ML Kit recognizer is not allocated until a PDF is actually
    // imported. The recognizer holds a long-lived native handle.
    private val ocrManager: OcrManager by lazy { OcrManager() }

    /**
     * Renders each page of the PDF at [uri] to a bitmap and runs ML Kit OCR.
     * Pages that produce no text are skipped; pages are joined with "\n\n".
     *
     * @throws IllegalStateException if the content URI cannot be opened.
     * @throws java.io.IOException if the PDF is corrupted or unreadable.
     */
    suspend fun extract(context: Context, uri: Uri): String = withContext(Dispatchers.IO) {
        val pfd: ParcelFileDescriptor = context.contentResolver.openFileDescriptor(uri, "r")
            ?: error("could not open PDF at $uri")

        pfd.use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
                val totalPages = renderer.pageCount
                if (totalPages == 0) return@use ""

                val out = StringBuilder()
                for (i in 0 until totalPages) {
                    renderer.openPage(i).use { page ->
                        val pageWidth = (page.width * RENDER_SCALE).toInt().coerceAtLeast(1)
                        val pageHeight = (page.height * RENDER_SCALE).toInt().coerceAtLeast(1)
                        val bitmap = Bitmap.createBitmap(
                            pageWidth,
                            pageHeight,
                            Bitmap.Config.ARGB_8888
                        ).apply {
                            // Fill white so a transparent region doesn't render as
                            // black, which ML Kit then misreads as text.
                            eraseColor(Color.WHITE)
                        }
                        try {
                            // render() lives on Page, not on PdfRenderer. The
                            // four-arg (Bitmap, Rect, Matrix, int) signature has
                            // been stable since API 21, so the same call works
                            // for the whole minSdk..compileSdk range. (The old
                            // PdfRenderer.render(Page, ...) signature was removed
                            // in API 35.)
                            page.render(
                                bitmap,
                                null,
                                null,
                                PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY
                            )
                            when (val result = ocrManager.extractText(bitmap)) {
                                is OcrExtractionResult.Success -> {
                                    val pageText = result.text.trim()
                                    if (pageText.isNotEmpty()) {
                                        if (out.isNotEmpty()) out.append("\n\n")
                                        out.append(pageText)
                                    }
                                }
                                is OcrExtractionResult.Failure -> {
                                    // Skip pages that yield no detectable text —
                                    // mirrors the original "drop empty
                                    // PDFTextStripper results" behavior.
                                }
                            }
                        } finally {
                            bitmap.recycle()
                        }
                    }
                }
                out.toString()
            }
        }
    }

    // 2x scale balances memory footprint (a Letter page at 2x is ~8 MB in
    // ARGB_8888) against OCR accuracy. ML Kit recommends ~300 DPI for
    // reliable recognition, which 2x achieves on a typical 72-DPI source PDF.
    private const val RENDER_SCALE = 2.0f
}
