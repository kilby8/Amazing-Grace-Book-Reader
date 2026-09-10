package com.amazinggrace.bookreader.tts

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.StateFlow

/**
 * Thin facade over a [SpeechEngine]. v1 ships two engines:
 * - [AndroidTtsEngine] (default — wraps android.speech.tts.TextToSpeech)
 * - [PocketTtsEngine] (HTTP + ExoPlayer, opt-in via [setEngine])
 *
 * Existing callers (ReaderPlaybackService, ReaderPlaybackController) keep talking to the
 * public surface — speak / pause / stop / resetForNewText / updateSpeechRate / updatePitch /
 * isPaused / activeRange / playbackStatus — and the facade routes each call to the current
 * engine. [setEngine] stops the current engine first.
 */
class TtsManager(
    context: Context,
    private val lifecycle: Lifecycle
) : DefaultLifecycleObserver {

    data class ActiveTextRange(val start: Int, val endExclusive: Int)

    enum class PlaybackStatus {
        IDLE,
        PLAYING,
        PAUSED,
        STOPPED
    }

    internal var engine: SpeechEngine = AndroidTtsEngine(context, lifecycle)
        private set

    val activeRange: StateFlow<ActiveTextRange?>
        get() = engine.activeRange

    val playbackStatus: StateFlow<PlaybackStatus>
        get() = engine.playbackStatus

    /**
     * Replace the active engine. The current engine is stopped first; any subsequent
     * speak/pause/stop/etc. call goes to [newEngine].
     */
    fun setEngine(newEngine: SpeechEngine) {
        engine.stop()
        engine = newEngine
    }

    fun speak(text: String) {
        engine.speak(text)
    }

    fun pause() {
        engine.pause()
    }

    fun stop() {
        engine.stop()
    }

    fun resetForNewText(text: String) {
        engine.resetForNewText(text)
    }

    fun updateSpeechRate(rate: Float) {
        engine.updateSpeechRate(rate)
    }

    fun updatePitch(pitch: Float) {
        engine.updatePitch(pitch)
    }

    fun isPaused(): Boolean {
        // The AndroidTtsEngine tracks paused state via PlaybackSessionState. PocketTts
        // doesn't carry that distinction. For backwards-compatibility we read the engine's
        // PlaybackStatus.PAUSED as the source of truth.
        return engine.playbackStatus.value == PlaybackStatus.PAUSED
    }

    /**
     * Forwarded to the lifecycle observer on the engine. The service calls this explicitly
     * in onDestroy; we keep it on the facade to preserve the existing call shape.
     */
    override fun onDestroy(owner: LifecycleOwner) {
        super.onDestroy(owner)
        engine.stop()
    }
}
