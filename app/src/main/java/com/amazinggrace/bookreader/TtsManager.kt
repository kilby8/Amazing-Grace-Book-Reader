package com.amazinggrace.bookreader

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

class TtsManager(context: Context) : TextToSpeech.OnInitListener {
    private companion object {
        const val UTTERANCE_ID = "book-reader-utterance"
    }

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
            textToSpeech?.setOnUtteranceProgressListener(
                object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit

                    override fun onDone(utteranceId: String?) {
                        playbackState = PlaybackState.STOPPED
                    }

                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        playbackState = PlaybackState.STOPPED
                    }
                }
            )
            isReady = true
        }
    }

    fun speak(text: String) {
        if (!isReady || text.isBlank()) return
        currentText = text
        textToSpeech?.speak(text, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID)
        playbackState = PlaybackState.PLAYING
    }

    fun pause() {
        if (playbackState == PlaybackState.PLAYING) {
            // TextToSpeech has no native pause API; stop() is used and resume() restarts full playback.
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
        isReady = false
        currentText = ""
        playbackState = PlaybackState.STOPPED
    }
}
