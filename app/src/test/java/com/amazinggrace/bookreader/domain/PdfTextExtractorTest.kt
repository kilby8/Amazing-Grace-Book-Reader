package com.amazinggrace.bookreader.domain

import android.net.Uri
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/**
 * Tests for [PdfTextExtractor.extract]. We don't exercise the happy path
 * (render + ML Kit OCR) on the JVM: Robolectric's PdfRenderer is a stub
 * that does not implement real rasterization, and pulling in the ML Kit
 * native bundle for unit tests is not worth the cost. The contract we DO
 * verify here is "a non-PDF must not produce non-empty text" — on a real
 * device PdfRenderer throws IOException, under Robolectric it silently
 * returns 0 pages and extract() returns the empty string. Either is
 * acceptable; non-empty text from a non-PDF would be a real bug.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class PdfTextExtractorTest {

    private fun fixture(name: String): ByteArray {
        val stream = javaClass.classLoader!!.getResourceAsStream(name)
            ?: error("Test fixture $name missing from app/src/test/resources")
        return stream.use { it.readBytes() }
    }

    @Test
    fun corruptedFixture_isNotAPdf() {
        val bytes = fixture("corrupted.pdf")
        // The corrupted file is just text — it should not even claim to be a PDF.
        assertThat(bytes.take(5).toByteArray().decodeToString()).doesNotContain("%PDF-")
    }

    @Test
    fun multipageFixture_isLoadable() {
        // Smoke test: the fixture PDF we ship is structurally a valid PDF, so the
        // byte signature check (header + EOF) passes. The actual extraction is
        // exercised on a device or in a Robolectric environment with a real
        // PdfRenderer, but the fixture must be valid for any future Android-side
        // test to be meaningful.
        val bytes = fixture("multipage.pdf")
        assertThat(bytes.size).isGreaterThan(0)
        assertThat(bytes.take(5).toByteArray().decodeToString()).startsWith("%PDF-")
    }

    @Test
    fun extract_rejectsGarbageBytes() {
        val context = RuntimeEnvironment.getApplication()
        val tmpFile = File(context.cacheDir, "garbage.pdf").apply {
            // Same content as the corrupted.pdf fixture: the PDF magic is
            // absent, so PdfRenderer must reject it on a real device. Under
            // Robolectric the native renderer is stubbed, so we accept either
            // an exception or an empty result — what we MUST NOT get is
            // non-empty text from a non-PDF.
            writeText(
                "Failed to parse PDF: Invalid PDF structure.. " +
                    "The file may be corrupt, encrypted, or not a real PDF."
            )
        }
        try {
            val uri = Uri.fromFile(tmpFile)
            val result = runBlocking {
                runCatching { PdfTextExtractor.extract(context, uri) }
            }

            if (result.isFailure) {
                // Real-device path: PdfRenderer throws IOException on a
                // malformed file. Any exception type is acceptable —
                // production code surfaces the message via viewModel.failOcr().
                return
            }

            // Robolectric stub path: PdfRenderer silently returns 0 pages,
            // so extract() returns an empty string. The contract is that we
            // never produce non-empty text from a non-PDF.
            assertThat(result.getOrThrow()).isEmpty()
        } finally {
            tmpFile.delete()
        }
    }
}
