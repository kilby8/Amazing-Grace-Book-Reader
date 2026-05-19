package com.amazinggrace.bookreader.domain

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.amazinggrace.bookreader.ocr.TextExtractor
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReaderOcrCoordinatorTest {

    @Test
    fun process_withNonBlankText_savesSessionAndHistory() = runBlocking {
        val extractor = FakeExtractor("Amazing text")
        val sessionWriter = FakeSessionWriter()
        val historyWriter = FakeHistoryWriter()
        val coordinator = ReaderOcrCoordinator(extractor, sessionWriter, historyWriter)

        val result = coordinator.process(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))

        assertThat(result.text).isEqualTo("Amazing text")
        assertThat(result.statusText).isEqualTo("OCR complete. Ready to play audio.")
        assertThat(sessionWriter.savedTexts).containsExactly("Amazing text")
        assertThat(historyWriter.savedScans).containsExactly("Amazing text")
    }

    @Test
    fun process_withBlankText_savesSessionOnly() = runBlocking {
        val extractor = FakeExtractor("")
        val sessionWriter = FakeSessionWriter()
        val historyWriter = FakeHistoryWriter()
        val coordinator = ReaderOcrCoordinator(extractor, sessionWriter, historyWriter)

        val result = coordinator.process(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888))

        assertThat(result.text).isEmpty()
        assertThat(result.statusText).isEqualTo("No text found in image.")
        assertThat(sessionWriter.savedTexts).containsExactly("")
        assertThat(historyWriter.savedScans).isEmpty()
    }

    private class FakeExtractor(private val nextText: String) : TextExtractor {
        override suspend fun extractText(bitmap: Bitmap): String = nextText
    }

    private class FakeSessionWriter : SessionTextWriter {
        val savedTexts = mutableListOf<String>()

        override suspend fun saveLastParsedText(text: String) {
            savedTexts += text
        }
    }

    private class FakeHistoryWriter : HistoryTextWriter {
        val savedScans = mutableListOf<String>()

        override suspend fun saveScan(fullText: String) {
            savedScans += fullText
        }
    }
}
