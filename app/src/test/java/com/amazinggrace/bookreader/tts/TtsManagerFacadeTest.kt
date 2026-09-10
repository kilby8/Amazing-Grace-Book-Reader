package com.amazinggrace.bookreader.tts

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import com.google.common.truth.Truth.assertThat
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Verifies the two pieces of the facade contract from DESIGN.md §2.1:
 *   1. setEngine() replaces the active engine.
 *   2. speak() delegates to the currently-active engine.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class TtsManagerFacadeTest {

    private class FakeLifecycleOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
    }

    private class RecordingEngine : SpeechEngine {
        var lastSpokenText: String? = null
        var pauseCount: Int = 0
        var stopCount: Int = 0
        var resetCalls: Int = 0
        var rateUpdate: Float? = null
        var pitchUpdate: Float? = null
        private val status = kotlinx.coroutines.flow.MutableStateFlow(TtsManager.PlaybackStatus.IDLE)
        private val range = kotlinx.coroutines.flow.MutableStateFlow<TtsManager.ActiveTextRange?>(null)
        override val playbackStatus = status
        override val activeRange = range
        override fun speak(text: String) { lastSpokenText = text }
        override fun pause() { pauseCount++ }
        override fun stop() { stopCount++ }
        override fun resetForNewText(text: String) { resetCalls++ }
        override fun updateSpeechRate(rate: Float) { rateUpdate = rate }
        override fun updatePitch(pitch: Float) { pitchUpdate = pitch }
    }

    @Test
    fun setEngine_swapsActiveEngine() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val ttsManager = TtsManager(context, FakeLifecycleOwner().lifecycle)
        val original = ttsManager.engine
        val fake = RecordingEngine()

        ttsManager.setEngine(fake)

        assertThat(ttsManager.engine).isSameInstanceAs(fake)
        assertThat(ttsManager.engine).isNotSameInstanceAs(original)
    }

    @Test
    fun setEngine_stopsPreviousEngineBeforeSwapping() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val ttsManager = TtsManager(context, FakeLifecycleOwner().lifecycle)
        val previous = RecordingEngine()
        ttsManager.setEngine(previous)
        previous.stopCount = 0

        ttsManager.setEngine(RecordingEngine())

        // The previous engine should have been stopped exactly once during the swap.
        assertThat(previous.stopCount).isEqualTo(1)
    }

    @Test
    fun speak_delegatesToCurrentEngine() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val ttsManager = TtsManager(context, FakeLifecycleOwner().lifecycle)
        val fake = RecordingEngine()
        ttsManager.setEngine(fake)

        ttsManager.speak("Amazing grace")

        assertThat(fake.lastSpokenText).isEqualTo("Amazing grace")
    }
}
