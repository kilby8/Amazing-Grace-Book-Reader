package com.amazinggrace.bookreader.domain

import android.content.ContentResolver
import android.graphics.Bitmap
import android.net.Uri
import com.amazinggrace.bookreader.ocr.ImageBitmapLoader
import com.amazinggrace.bookreader.ui.ReaderViewModel

class ReaderScanController(
    private val contentResolver: ContentResolver,
    private val imageBitmapLoader: ImageBitmapLoader,
    private val readerOcrCoordinator: ReaderOcrCoordinator,
    private val viewModel: ReaderViewModel,
    private val playbackController: ReaderPlaybackController
) {

    suspend fun processImage(uri: Uri) {
        if (viewModel.uiState.value.isProcessing) return
        val bitmap = imageBitmapLoader.load(contentResolver, uri)
        processBitmap(bitmap)
    }

    suspend fun processBitmap(bitmap: Bitmap) {
        viewModel.startOcr()

        runCatching {
            readerOcrCoordinator.process(bitmap)
        }.onSuccess { result ->
            viewModel.applyOcrResult(result)
            playbackController.prepareText(result.text)
        }.onFailure { error ->
            viewModel.failOcr(error.message ?: "unknown error")
        }
    }
}
