package com.amazinggrace.bookreader

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

class TtsManager(context: Context) : TextToSpeech.OnInitListener {

    enum class PlaybackState {
        IDLE,
        PLAYING,
        PAUSED,
        STOPPED
    }

    private var textToSpeech: TextToSpeech? = TextToSpeech(context, this)
    private var isReady = false
    private var currentText: String = ""

    var playbackState: PlaybackState = PlaybackState.IDLE
        private set

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            textToSpeech?.language = Locale.getDefault()
            isReady = true
        }
    }

    fun speak(text: String) {
        if (!isReady || text.isBlank()) return
        currentText = text
        textToSpeech?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "book-reader-utterance")
        playbackState = PlaybackState.PLAYING
    }

    fun pause() {
        if (playbackState == PlaybackState.PLAYING) {
            textToSpeech?.stop()
            playbackState = PlaybackState.PAUSED
        }
    }

    fun resume() {
        if (playbackState == PlaybackState.PAUSED && currentText.isNotBlank()) {
            speak(currentText)
        }
    }

    fun stop() {
        textToSpeech?.stop()
        playbackState = PlaybackState.STOPPED
    }

    fun shutdown() {
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        playbackState = PlaybackState.STOPPED
    }
}
