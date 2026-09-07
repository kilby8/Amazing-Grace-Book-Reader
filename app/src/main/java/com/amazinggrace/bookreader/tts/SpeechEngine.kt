package com.amazinggrace.bookreader.tts

import kotlinx.coroutines.flow.StateFlow

/**
 * Abstraction over the text-to-speech playback layer. Two implementations exist in v1:
 * - [AndroidTtsEngine] (built-in android.speech.tts.TextToSpeech)
 * - [PocketTtsEngine] (HTTP POST to a local pocket-tts server + ExoPlayer playback)
 *
 * The TtsManager facade swaps engines at runtime via [TtsManager.setEngine]. Each engine
 * is responsible for the full lifecycle of one speak() call.
 */
interface SpeechEngine {
    val playbackStatus: StateFlow<TtsManager.PlaybackStatus>
    val activeRange: StateFlow<TtsManager.ActiveTextRange?>

    /** Load and start speaking [text]. Idempotent — restart on the same text starts from the beginning. */
    fun speak(text: String)

    /** Pause at the current position. No-op if not playing. */
    fun pause()

    /** Stop and release audio resources. */
    fun stop()

    /** Reset internal state for a brand-new text. */
    fun resetForNewText(text: String)

    fun updateSpeechRate(rate: Float)
    fun updatePitch(pitch: Float)
}
