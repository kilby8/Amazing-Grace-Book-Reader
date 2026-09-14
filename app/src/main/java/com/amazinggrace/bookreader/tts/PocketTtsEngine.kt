package com.amazinggrace.bookreader.tts

import android.content.Context
import android.media.MediaPlayer
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/**
 * SpeechEngine backed by a local pocket-tts server. Synthesizes the text via HTTP, writes
 * the returned WAV to a temp file, then plays it through the platform [MediaPlayer].
 *
 * v1 limitation: [activeRange] is always null — the server does not emit per-word timing,
 * so the live-highlight UI is silently disabled in this mode. See DESIGN.md §1.
 *
 * v1 limitation: [updateSpeechRate] and [updatePitch] are no-ops. MediaPlayer's
 * `PlaybackParams` could in principle carry rate (API 23+), but pocket-tts already
 * accepts rate on its `/tts` endpoint via the request body, and re-sending the same
 * text at a different rate mid-stream requires the engine to track per-character
 * offsets. Wire this up when the v2 engine has timing data to anchor the change.
 * Voice settings continue to persist in DataStore; the user-facing controls stay
 * live for the default AndroidTtsEngine.
 */
internal class PocketTtsEngine(
    private val context: Context,
    private val lifecycle: Lifecycle,
    private val client: PocketTtsClient,
    private val tempFileFactory: (String) -> File
) : SpeechEngine, DefaultLifecycleObserver {

    private val _playbackStatus = MutableStateFlow(TtsManager.PlaybackStatus.IDLE)
    override val playbackStatus: StateFlow<TtsManager.PlaybackStatus> = _playbackStatus.asStateFlow()

    private val _activeRange = MutableStateFlow<TtsManager.ActiveTextRange?>(null)
    override val activeRange: StateFlow<TtsManager.ActiveTextRange?> = _activeRange.asStateFlow()

    private val mediaPlayer: MediaPlayer = MediaPlayer().apply {
        setOnCompletionListener {
            _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
            _activeRange.value = null
        }
        setOnErrorListener { _, _, _ ->
            _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
            _activeRange.value = null
            true
        }
    }

    private var currentText: String = ""

    init {
        lifecycle.addObserver(this)
    }

    override fun speak(text: String) {
        if (text.isBlank()) return
        currentText = text
        _activeRange.value = null
        _playbackStatus.value = TtsManager.PlaybackStatus.PLAYING

        lifecycle.coroutineScope.launch {
            try {
                val wavFile = client.synthesizeToFile(text, tempFileFactory)
                // setDataSource(String) is API 1+ and handles WAV out of the box.
                // reset() before setDataSource lets us re-use the same MediaPlayer
                // instance for sequential speak() calls.
                mediaPlayer.reset()
                mediaPlayer.setDataSource(wavFile.absolutePath)
                // prepare() is synchronous and acceptable here: the synthesized
                // WAV is short (a sentence of speech). Switch to prepareAsync()
                // if the buffer fill becomes noticeable.
                mediaPlayer.prepare()
                mediaPlayer.start()
            } catch (e: Exception) {
                _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                _activeRange.value = null
            }
        }
    }

    override fun pause() {
        if (mediaPlayer.isPlaying) {
            mediaPlayer.pause()
        }
        _playbackStatus.value = TtsManager.PlaybackStatus.PAUSED
        _activeRange.value = null
    }

    override fun stop() {
        try {
            if (mediaPlayer.isPlaying) {
                mediaPlayer.stop()
            }
        } catch (_: IllegalStateException) {
            // stop() throws if the player is in an invalid state (e.g. before
            // prepare() succeeds). Swallow — we're tearing down anyway.
        }
        mediaPlayer.reset()
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
    }

    override fun resetForNewText(text: String) {
        currentText = text
        try {
            if (mediaPlayer.isPlaying) {
                mediaPlayer.stop()
            }
        } catch (_: IllegalStateException) {
            // Same as stop() above — reset() also requires a valid state.
        }
        mediaPlayer.reset()
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
    }

    override fun updateSpeechRate(rate: Float) {
        // No-op for v1. See class kdoc. PocketTtsClient will pick up the rate
        // the next time speak() re-sends the text.
    }

    override fun updatePitch(pitch: Float) {
        // No-op for v1. See class kdoc. Pocket TTS does its own pitch work
        // server-side via the chosen voice.
    }

    override fun onDestroy(owner: LifecycleOwner) {
        try {
            mediaPlayer.release()
        } catch (_: Exception) {
            // release() is documented to be safe to call repeatedly. Defensive
            // catch keeps a release-time crash from masking the real reason
            // the lifecycle is being torn down.
        }
    }
}
