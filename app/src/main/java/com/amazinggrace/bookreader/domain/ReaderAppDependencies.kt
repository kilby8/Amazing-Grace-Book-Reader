package com.amazinggrace.bookreader.domain

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultCaller
import com.amazinggrace.bookreader.data.ReaderPreferences
import com.amazinggrace.bookreader.data.ReaderSessionRepository
import com.amazinggrace.bookreader.history.ReaderDatabase
import com.amazinggrace.bookreader.history.ScanHistoryRepository
import com.amazinggrace.bookreader.ocr.ImageBitmapLoader
import com.amazinggrace.bookreader.ocr.OcrManager
import com.amazinggrace.bookreader.ui.ReaderViewModel
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class ReaderAppDependencies private constructor(
    val activityResultController: ReaderActivityResultController,
    val scanController: ReaderScanController,
    val uiCoordinator: ReaderUiCoordinator,
    val textActions: ReaderTextActions,
    val playbackController: ReaderPlaybackController,
    val sessionRepository: ReaderSessionRepository,
    val historyRepository: ScanHistoryRepository,
    private val ocrManager: OcrManager
) {

    fun close() {
        ocrManager.close()
    }

    companion object {
        fun create(
            caller: ActivityResultCaller,
            context: Context,
            cacheDir: java.io.File,
            viewModel: ReaderViewModel
        ): ReaderAppDependencies {
            val ocrManager = OcrManager()
            val sessionRepository = ReaderSessionRepository(ReaderPreferences(context))
            val historyRepository = ScanHistoryRepository(
                ReaderDatabase.getInstance(context).scanHistoryDao()
            )
            val textActions = ReaderTextActions(context)
            val playbackController = ReaderPlaybackController(context)
            val readerOcrCoordinator = ReaderOcrCoordinator(
                textExtractor = ocrManager,
                sessionWriter = sessionRepository,
                historyWriter = historyRepository
            )
            val scanController = ReaderScanController(
                contentResolver = context.contentResolver,
                imageBitmapLoader = ImageBitmapLoader(),
                readerOcrCoordinator = readerOcrCoordinator,
                viewModel = viewModel,
                playbackController = playbackController
            )
            val uiCoordinator = ReaderUiCoordinator(
                lifecycleOwner = context as ComponentActivity,
                viewModel = viewModel,
                sessionRepository = sessionRepository,
                historyRepository = historyRepository,
                playbackController = playbackController
            )
            val activityResultController = ReaderActivityResultController(
                caller = caller,
                context = context,
                cacheDir = cacheDir,
                onImageSelected = { uri ->
                    (context as ComponentActivity).lifecycleScope.launch {
                        scanController.processImage(uri)
                    }
                },
                onStatusMessage = { message ->
                    viewModel.setStatus(message)
                }
            )

            return ReaderAppDependencies(
                activityResultController = activityResultController,
                scanController = scanController,
                uiCoordinator = uiCoordinator,
                textActions = textActions,
                playbackController = playbackController,
                sessionRepository = sessionRepository,
                historyRepository = historyRepository,
                ocrManager = ocrManager
            )
        }
    }
}
