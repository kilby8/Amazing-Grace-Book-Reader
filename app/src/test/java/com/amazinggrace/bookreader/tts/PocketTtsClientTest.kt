package com.amazinggrace.bookreader.tts

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets

/**
 * Unit tests for [PocketTtsClient]. Covers the four contract scenarios named
 * in DESIGN.md §5 (test plan) and §2.3 (the client signature itself):
 *
 *   (a) The request body is a multipart form with `text` and `voice_url`.
 *   (b) On HTTP 200, the response bytes are written to the file produced by
 *       the factory the caller passed in.
 *   (c) On a non-2xx response, [PocketTtsException] is thrown.
 *   (d) On a network-level failure, [IOException] propagates.
 *
 * No Robolectric: the client only uses OkHttp + standard java.io, so a plain
 * JUnit4 runner is enough. That keeps the test fast and the dependency surface
 * narrow (we already pull in OkHttp 4.12.0 and MockWebServer for prod use).
 */
class PocketTtsClientTest {

    @get:Rule
    val tempFolder: TemporaryFolder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var capturedFile: File
    private var fileFactoryCalls: Int = 0

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        capturedFile = File(tempFolder.root, "pocket_tts.wav").also { it.createNewFile() }
        fileFactoryCalls = 0
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    /**
     * File factory the production caller (PocketTtsEngine) supplies. We track
     * how many times the client invokes it so we can assert "exactly once per
     * synthesizeToFile call" in the happy path.
     */
    private fun testFileFactory(name: String): File {
        fileFactoryCalls++
        assertThat(name).endsWith(".wav")
        return capturedFile
    }

    @Test
    fun synthesizeToFile_sendsMultipartFormWithTextAndVoice() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "audio/wav")
                .setBody(Buffer().write(wavBytes()))
        )

        val client = PocketTtsClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            voice = "eve"
        )

        client.synthesizeToFile("Amazing grace, how sweet the sound", ::testFileFactory)

        val recorded = server.takeRequest()
        // (a) Method + path
        assertThat(recorded.method).isEqualTo("POST")
        assertThat(recorded.path).isEqualTo("/tts")
        // (a) Multipart content type
        val contentType = recorded.getHeader("Content-Type") ?: ""
        assertThat(contentType).startsWith("multipart/form-data")
        // (a) Both form fields are present, with the right names and values.
        // The recorded body is the raw multipart payload; for small fields
        // reading it as UTF-8 is fine and lets us assert without re-parsing.
        val body = recorded.body.readUtf8()
        assertThat(body).contains("name=\"text\"")
        assertThat(body).contains("Amazing grace, how sweet the sound")
        assertThat(body).contains("name=\"voice_url\"")
        assertThat(body).contains("eve")
    }

    @Test
    fun synthesizeToFile_writesResponseBytesToTempFile() = runBlocking {
        val payload = wavBytes(bytePattern = 0x42)
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "audio/wav")
                .setBody(Buffer().write(payload))
        )

        val client = PocketTtsClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            voice = "eve"
        )

        val written = client.synthesizeToFile("Hello", ::testFileFactory)

        assertThat(written).isEqualTo(capturedFile)
        assertThat(fileFactoryCalls).isEqualTo(1)
        // The file on disk should be byte-for-byte the response body. Using
        // a recognisable pattern in the payload (every byte = 0x42) makes
        // this a sharp assertion instead of a length check.
        val onDisk = capturedFile.readBytes()
        assertThat(onDisk).isEqualTo(payload)
        assertThat(onDisk.size).isEqualTo(payload.size)
    }

    @Test
    fun synthesizeToFile_4xxResponseThrowsPocketTtsException() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(400)
                .setHeader("Content-Type", "application/json")
                .setBody("{\"detail\":\"text cannot be empty\"}")
        )

        val client = PocketTtsClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            voice = "eve"
        )

        val thrown = runCatching {
            client.synthesizeToFile("ignored", ::testFileFactory)
        }.exceptionOrNull()

        assertThat(thrown).isInstanceOf(PocketTtsException::class.java)
        // The factory must not have been called — we never produced a file.
        assertThat(fileFactoryCalls).isEqualTo(0)
        // The error message embeds the status code so on-device logs are
        // actionable without re-running the request.
        assertThat(thrown!!.message).contains("400")
    }

    @Test
    fun synthesizeToFile_5xxResponseThrowsPocketTtsException() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setHeader("Content-Type", "text/plain")
                .setBody("voice setup failed: boom")
        )

        val client = PocketTtsClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            voice = "eve"
        )

        val thrown = runCatching {
            client.synthesizeToFile("ignored", ::testFileFactory)
        }.exceptionOrNull()

        assertThat(thrown).isInstanceOf(PocketTtsException::class.java)
        assertThat(fileFactoryCalls).isEqualTo(0)
        assertThat(thrown!!.message).contains("500")
    }

    @Test
    fun synthesizeToFile_networkFailureThrowsIOException() = runBlocking {
        // SocketPolicy.DISCONNECT_AT_START makes MockWebServer close the
        // socket before any HTTP response is written, which surfaces to OkHttp
        // as an IOException — exactly the "network error" path DESIGN.md §2.3
        // says should NOT be wrapped in PocketTtsException.
        server.enqueue(
            MockResponse()
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
        )

        val client = PocketTtsClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            voice = "eve"
        )

        val thrown = runCatching {
            client.synthesizeToFile("ignored", ::testFileFactory)
        }.exceptionOrNull()

        // (d) Network error must propagate as IOException, not be re-wrapped
        // in PocketTtsException (PocketTtsException is reserved for
        // non-2xx HTTP responses and empty bodies per the contract).
        assertThat(thrown).isInstanceOf(IOException::class.java)
        assertThat(thrown).isNotInstanceOf(PocketTtsException::class.java)
        assertThat(fileFactoryCalls).isEqualTo(0)
    }

    // -- helpers ------------------------------------------------------------

    /**
     * A small but valid-looking WAV blob: 'RIFF' + little-endian 32-bit size
     * + 'WAVE' header followed by a body of N copies of [bytePattern]. We
     * don't need a parseable WAV for the client (it just writes the bytes
     * verbatim); the magic bytes are what the probe script and any
     * downstream player check for.
     */
    private fun wavBytes(byteCount: Int = 64, bytePattern: Byte = 0x42): ByteArray {
        val riff = "RIFF".toByteArray(StandardCharsets.US_ASCII)
        val wave = "WAVE".toByteArray(StandardCharsets.US_ASCII)
        val body = ByteArray(byteCount) { bytePattern }
        // RIFF size field is a 32-bit little-endian count of the bytes that
        // follow the size field itself. The header past this point is the
        // 4-byte 'WAVE' tag plus the body, so 4 + body.size.
        val sizeBytes = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(4 + body.size)
            .array()
        return riff + sizeBytes + wave + body
    }
}
