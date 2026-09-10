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
import com.amazinggrace.bookreader.tts.PocketTtsClient
import com.amazinggrace.bookreader.tts.PocketTtsEngine
import com.amazinggrace.bookreader.tts.TtsManager
import com.amazinggrace.bookreader.ui.ReaderViewModel
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.io.File

class ReaderAppDependencies private constructor(
    val activityResultController: ReaderActivityResultController,
    val scanController: ReaderScanController,
    val uiCoordinator: ReaderUiCoordinator,
    val textActions: ReaderTextActions,
    val playbackController: ReaderPlaybackController,
    val sessionRepository: ReaderSessionRepository,
    val historyRepository: ScanHistoryRepository,
    val ttsManager: TtsManager,
    private val ocrManager: OcrManager
) {

    fun close() {
        ocrManager.close()
    }

    companion object {
        fun create(
            caller: ActivityResultCaller,
            context: Context,
            cacheDir: File,
            viewModel: ReaderViewModel
        ): ReaderAppDependencies {
            val ocrManager = OcrManager()
            val readerPreferences = ReaderPreferences(context)
            val sessionRepository = ReaderSessionRepository(readerPreferences)
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
            val pdfImportController = PdfImportController(
                context = context,
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

            // Read the persisted prefs synchronously here so the ttsManager is constructed
            // with the correct engine. ReaderPreferences.loadSnapshot() is suspend; we
            // block in a runBlocking at the composition root only.
            val snapshot = kotlinx.coroutines.runBlocking { readerPreferences.loadSnapshot() }

            val lifecycle = (context as ComponentActivity).lifecycle
            val ttsManager = TtsManager(context.applicationContext, lifecycle).apply {
                if (snapshot.ttsEngine == "pocket_tts") {
                    val pocketTtsClient = PocketTtsClient(
                        baseUrl = snapshot.pocketTtsBaseUrl,
                        voice = snapshot.pocketTtsVoice
                    )
                    setEngine(
                        PocketTtsEngine(
                            context = context.applicationContext,
                            lifecycle = lifecycle,
                            client = pocketTtsClient,
                            tempFileFactory = { name -> tempWavFile(cacheDir, name) }
                        )
                    )
                }
            }

            val activityResultController = ReaderActivityResultController(
                caller = caller,
                context = context,
                cacheDir = cacheDir,
                onImageSelected = { uri ->
                    (context as ComponentActivity).lifecycleScope.launch {
                        scanController.processImage(uri)
                    }
                },
                onPdfSelected = { uri ->
                    (context as ComponentActivity).lifecycleScope.launch {
                        pdfImportController.processDocument(uri)
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
                ttsManager = ttsManager,
                ocrManager = ocrManager
            )
        }

        private fun tempWavFile(cacheDir: File, name: String): File {
            val dir = File(cacheDir, "tts").apply { mkdirs() }
            return File(dir, name)
        }
    }
}
