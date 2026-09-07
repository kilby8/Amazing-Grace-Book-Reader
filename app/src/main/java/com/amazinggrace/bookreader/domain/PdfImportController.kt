package com.amazinggrace.bookreader.domain

import android.content.Context
import android.net.Uri
import com.amazinggrace.bookreader.ui.ReaderViewModel

/**
 * Mirrors [ReaderScanController] but for PDFs: open the URI, extract the text via
 * [PdfTextExtractor], update the view model, and hand the text to the playback controller.
 */
class PdfImportController(
    private val context: Context,
    private val viewModel: ReaderViewModel,
    private val playbackController: ReaderPlaybackController
) {

    suspend fun processDocument(uri: Uri) {
        if (viewModel.uiState.value.isProcessing) return
        viewModel.startOcr()

        runCatching {
            context.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input) { "could not open PDF at $uri" }
                PdfTextExtractor.ensureInitialized(context)
                PdfTextExtractor.extract(input)
            }
        }.onSuccess { text ->
            viewModel.applyOcrResult(
                ReaderOcrResult(
                    text = text,
                    statusText = "PDF loaded. Ready to play audio."
                )
            )
            playbackController.prepareText(text)
        }.onFailure { error ->
            viewModel.failOcr(error.message ?: "could not read PDF")
        }
    }
}
