package com.amazinggrace.bookreader.domain

import android.content.Context
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.InputStream

/**
 * Pure function that turns a PDF [InputStream] into a single concatenated text blob. Pages
 * are joined with a blank line; pages that produce no text are skipped. Throws on a corrupted
 * PDF.
 *
 * NOTE: [ensureInitialized] MUST be called once with an Android [Context] before [extract]
 * is called. Production callers do this in [com.amazinggrace.bookreader.MainActivity.onCreate].
 * The init is exposed as a separate method so the pure extraction logic stays testable on
 * the JVM (the AAR's Android-stubs package is not loadable without Robolectric, so we
 * keep Android-only setup out of the unit-test path).
 */
object PdfTextExtractor {

    /**
     * Initialize the PDFBox font/asset loader. Idempotent. Call once at app start with an
     * Android Context. Not required for the unit test path, which only verifies the
     * joining logic and corrupted-input contract.
     */
    fun ensureInitialized(context: Context) {
        PDFBoxResourceLoader.init(context.applicationContext)
    }

    /**
     * Extract text from every page of the PDF, joining pages with a blank line.
     * Returns the concatenated text. Throws on corrupted PDFs.
     */
    fun extract(input: InputStream): String {
        return PDDocument.load(input).use { doc ->
            val stripper = PDFTextStripper()
            buildString {
                for (i in 1..doc.numberOfPages) {
                    stripper.startPage = i
                    stripper.endPage = i
                    val pageText = stripper.getText(doc).trim()
                    if (pageText.isNotEmpty()) {
                        if (isNotEmpty()) append("\n\n")
                        append(pageText)
                    }
                }
            }
        }
    }
}
