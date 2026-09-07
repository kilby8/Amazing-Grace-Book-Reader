package com.amazinggrace.bookreader.tts

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Talks to a local pocket-tts server. The default constructor wires sensible HTTP timeouts
 * (TTS synthesis can be slow on long passages); pass a custom [OkHttpClient] for tests.
 */
class PocketTtsClient(
    private val baseUrl: String,
    private val voice: String,
    private val httpClient: OkHttpClient = defaultClient()
) {

    /**
     * POSTs [text] (and the configured [voice]) to `{baseUrl}/tts` as multipart form data and
     * writes the returned WAV bytes to a file produced by [tempFileFactory]. The factory is
     * injected so the caller controls the location (e.g. `cacheDir/tts/...`).
     *
     * @throws PocketTtsException on a non-2xx response or an empty body
     * @throws java.io.IOException on network errors
     */
    suspend fun synthesizeToFile(
        text: String,
        tempFileFactory: (String) -> File
    ): File = withContext(Dispatchers.IO) {
        val builder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("text", text)
        if (voice.isNotBlank()) {
            builder.addFormDataPart("voice_url", voice)
        }
        val body = builder.build()

        val request = Request.Builder()
            .url("$baseUrl/tts")
            .post(body)
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw PocketTtsException(
                    "pocket-tts returned ${response.code}: ${response.body?.string()}"
                )
            }
            val bytes = response.body?.bytes()
                ?: throw PocketTtsException("pocket-tts returned empty body")
            val file = tempFileFactory("pocket_tts_${System.currentTimeMillis()}.wav")
            file.writeBytes(bytes)
            file
        }
    }

    private companion object {
        @Suppress("unused")  // OkHttp requires a media type even for raw bytes
        private val OCTET_STREAM = "application/octet-stream".toMediaTypeOrNull()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build()
    }
}
