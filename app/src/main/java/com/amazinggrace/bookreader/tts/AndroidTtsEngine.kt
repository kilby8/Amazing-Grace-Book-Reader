package com.amazinggrace.bookreader.tts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale

/**
 * Wraps the platform android.speech.tts.TextToSpeech. This is the original TtsManager body,
 * extracted verbatim into a [SpeechEngine] implementation. Highlight ranges are real
 * (UtteranceProgressListener.onRangeStart) — the pocket-tts engine does not provide these.
 */
internal class AndroidTtsEngine(
    context: Context,
    private val lifecycle: Lifecycle
) : SpeechEngine, TextToSpeech.OnInitListener, DefaultLifecycleObserver {

    private val playbackSessionState = PlaybackSessionState()
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                if (playbackSessionState.currentText().isNotBlank() && !playbackSessionState.isPaused()) {
                    resumeAfterAudioFocusGain = true
                    pauseForAudioFocus()
                }
            }

            AudioManager.AUDIOFOCUS_GAIN -> {
                if (resumeAfterAudioFocusGain && playbackSessionState.isPaused()) {
                    resumeAfterAudioFocusGain = false
                    speak(playbackSessionState.currentText())
                }
            }
        }
    }
    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val audioFocusRequest: AudioFocusRequest? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(audioAttributes)
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener(audioFocusChangeListener)
            .build()
    } else {
        null
    }
    private var textToSpeech: TextToSpeech? = TextToSpeech(context.applicationContext, this)
    private var isReady = false
    private var speechRate: Float = 1.0f
    private var pitch: Float = 1.0f
    private var hasAudioFocus = false
    private var resumeAfterAudioFocusGain = false
    private val _activeRange = MutableStateFlow<TtsManager.ActiveTextRange?>(null)
    override val activeRange: StateFlow<TtsManager.ActiveTextRange?> = _activeRange.asStateFlow()
    private val _playbackStatus = MutableStateFlow(TtsManager.PlaybackStatus.IDLE)
    override val playbackStatus: StateFlow<TtsManager.PlaybackStatus> = _playbackStatus.asStateFlow()

    init {
        lifecycle.addObserver(this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val result = textToSpeech?.setLanguage(Locale.getDefault())
            isReady = result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED
            if (isReady) {
                textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        _playbackStatus.value = TtsManager.PlaybackStatus.PLAYING
                        _activeRange.value = null
                    }

                    override fun onDone(utteranceId: String?) {
                        if (utteranceId == UTTERANCE_ID) {
                            playbackSessionState.onUtteranceDone()
                            _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                        }
                        _activeRange.value = null
                    }

                    override fun onError(utteranceId: String?) {
                        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
                        _activeRange.value = null
                    }

                    override fun onRangeStart(
                        utteranceId: String?,
                        start: Int,
                        end: Int,
                        frame: Int
                    ) {
                        if (utteranceId == UTTERANCE_ID) {
                            val range = playbackSessionState.onRangeStart(start, end)
                            _activeRange.value = TtsManager.ActiveTextRange(range.start, range.endExclusive)
                        }
                    }
                })
                applyVoiceSettings()
            }
        }
    }

    override fun speak(text: String) {
        val speakRequest = playbackSessionState.prepareSpeakRequest(text) ?: return

        if (!isReady) return
        if (!requestAudioFocus()) return
        _activeRange.value = null

        textToSpeech?.speak(
            speakRequest.textToSpeak,
            TextToSpeech.QUEUE_FLUSH,
            null,
            UTTERANCE_ID
        )
    }

    override fun pause() {
        if (!isReady) return

        resumeAfterAudioFocusGain = false
        playbackSessionState.onPause()
        _playbackStatus.value = TtsManager.PlaybackStatus.PAUSED
        _activeRange.value = null
        textToSpeech?.stop()
        abandonAudioFocus()
    }

    override fun stop() {
        resumeAfterAudioFocusGain = false
        playbackSessionState.onStop()
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
        textToSpeech?.stop()
        abandonAudioFocus()
    }

    override fun resetForNewText(newText: String) {
        resumeAfterAudioFocusGain = false
        playbackSessionState.resetForNewText(newText)
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
        textToSpeech?.stop()
        abandonAudioFocus()
    }

    override fun updateSpeechRate(newRate: Float) {
        speechRate = newRate.coerceIn(0.5f, 2.0f)
        applyVoiceSettings()
    }

    override fun updatePitch(newPitch: Float) {
        pitch = newPitch.coerceIn(0.5f, 2.0f)
        applyVoiceSettings()
    }

    private fun applyVoiceSettings() {
        if (!isReady) return
        textToSpeech?.setSpeechRate(speechRate)
        textToSpeech?.setPitch(pitch)
    }

    fun isPaused(): Boolean = playbackSessionState.isPaused()

    private fun pauseForAudioFocus() {
        playbackSessionState.onPause()
        _playbackStatus.value = TtsManager.PlaybackStatus.PAUSED
        _activeRange.value = null
        textToSpeech?.stop()
        abandonAudioFocus()
    }

    private fun requestAudioFocus(): Boolean {
        if (hasAudioFocus) return true

        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.requestAudioFocus(audioFocusRequest ?: return false)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
        }

        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        return hasAudioFocus
    }

    private fun abandonAudioFocus() {
        if (!hasAudioFocus) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusChangeListener)
        }

        hasAudioFocus = false
    }

    override fun onDestroy(owner: LifecycleOwner) {
        super.onDestroy(owner)
        _playbackStatus.value = TtsManager.PlaybackStatus.STOPPED
        _activeRange.value = null
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        isReady = false
        resumeAfterAudioFocusGain = false
        abandonAudioFocus()
    }

    private companion object {
        const val UTTERANCE_ID = "amazing_grace_reader_utterance"
    }
}
