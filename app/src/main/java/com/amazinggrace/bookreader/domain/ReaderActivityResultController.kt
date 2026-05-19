package com.amazinggrace.bookreader.domain

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.result.ActivityResultCaller
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

class ReaderActivityResultController(
    caller: ActivityResultCaller,
    private val context: Context,
    private val cacheDir: File,
    private val onImageSelected: (Uri) -> Unit,
    private val onStatusMessage: (String) -> Unit
) {
    private var pendingCaptureUri: Uri? = null

    private val mediaPermissionLauncher = caller.registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        // Photo picker remains available even if permissions are denied.
    }

    private val cameraLauncher = caller.registerForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        val captureUri = pendingCaptureUri
        pendingCaptureUri = null

        if (!success || captureUri == null) {
            onStatusMessage("No photo captured.")
            return@registerForActivityResult
        }

        onImageSelected(captureUri)
    }

    private val cameraPermissionLauncher = caller.registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            val captureUri = createImageCaptureUri()
            pendingCaptureUri = captureUri
            cameraLauncher.launch(captureUri)
        } else {
            onStatusMessage("Camera permission denied.")
        }
    }

    private val pickerLauncher = caller.registerForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) {
            onStatusMessage("No image selected.")
            return@registerForActivityResult
        }

        onImageSelected(uri)
    }

    fun requestMediaPermissions() {
        val permissions = mediaRuntimePermissions()
        if (permissions.isNotEmpty()) {
            mediaPermissionLauncher.launch(permissions.toTypedArray())
        }
    }

    fun launchPhotoPicker() {
        pickerLauncher.launch(
            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        )
    }

    fun launchCameraCapture() {
        val hasCameraPermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED

        if (hasCameraPermission) {
            val captureUri = createImageCaptureUri()
            pendingCaptureUri = captureUri
            cameraLauncher.launch(captureUri)
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun mediaRuntimePermissions(): List<String> {
        val permissions = mutableListOf<String>()
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

        return permissions
    }

    private fun createImageCaptureUri(): Uri {
        val imageDirectory = File(cacheDir, "images").apply { mkdirs() }
        val imageFile = File.createTempFile("capture_", ".jpg", imageDirectory)
        return FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            imageFile
        )
    }
}
