package com.amazinggrace.bookreader.tts

import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.coroutineScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/**
 * SpeechEngine backed by a local pocket-tts server. Synthesizes the text via HTTP, writes
 * the returned WAV to a temp file, then plays it through ExoPlayer.
 *
 * v1 limitation: [activeRange] is always null — the server does not emit per-word timing,
 * so the live-highlight UI is silently disabled in this mode. See DESIGN.md §1.
 */
internal class PocketTtsEngine(
    context: Context,
    private val lifecycle: Lifecycle,
    private val client: PocketTtsClient,
    private val tempFileFactory: (String) -> File
) : SpeechEngine {

    private val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()
    private val _playbackStatus = MutableStateFlow(TtsManager.PlaybackStatus.IDLE)
    override val playbackStatus: StateFlow<TtsManager.PlaybackStatus> = _playbackStatus.asStateFlow()
    private val _activeRange = MutableStateFlow<TtsManager.ActiveTextRange?>(null)
    override val activeRange: StateFlow<TtsManager.ActiveTextRange?> = _activeRange.asStateFlow()

    private var currentText: String = ""
    private var currentTempFile: File? = null
    private var speechRate: Float = 1.0f
    private var pitch: Float = 1.0f

    init {
        exoPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) {
                    _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                    _activeRange.value = null
                }
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                _activeRange.value = null
            }
        })
    }

    override fun speak(text: String) {
        if (text.isBlank()) return
        currentText = text
        _activeRange.value = null
        _playbackStatus.value = TtsManager.PlaybackStatus.PLAYING

        lifecycle.coroutineScope.launch {
            try {
                val wavFile = client.synthesizeToFile(text, tempFileFactory)
                currentTempFile = wavFile
                exoPlayer.stop()
                exoPlayer.clearMediaItems()
                exoPlayer.setMediaItem(MediaItem.fromUri(wavFile.toURI().toString()))
                exoPlayer.prepare()
                exoPlayer.playWhenReady = true
            } catch (e: Exception) {
                _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                _activeRange.value = null
            }
        }
    }

    override fun pause() {
        if (exoPlayer.isPlaying) {
            exoPlayer.pause()
        }
        _playbackStatus.value = TtsManager.PlaybackStatus.PAUSED
    }

    override fun stop() {
        exoPlayer.stop()
        exoPlayer.clearMediaItems()
        currentTempFile?.delete()
        currentTempFile = null
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
    }

    override fun resetForNewText(newText: String) {
        stop()
        currentText = newText
    }

    override fun updateSpeechRate(rate: Float) {
        speechRate = rate.coerceIn(0.5f, 2.0f)
        // ExoPlayer's playback parameters control speed without altering pitch.
        exoPlayer.playbackParameters = exoPlayer.playbackParameters.withSpeed(speechRate)
    }

    override fun updatePitch(pitch: Float) {
        this.pitch = pitch.coerceIn(0.5f, 2.0f)
        // Pocket TTS does the actual voice-pitch adjustment server-side via the chosen voice.
        // We pass the rate to ExoPlayer but leave pitch at 1.0 here.
    }
}
