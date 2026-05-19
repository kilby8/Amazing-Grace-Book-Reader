package com.amazinggrace.bookreader.tts

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class PlaybackSessionStateTest {

    @Test
    fun prepareSpeakRequest_resumesFromSavedOffsetAfterPause() {
        val state = PlaybackSessionState()

        val initial = state.prepareSpeakRequest("Amazing Grace")
        assertThat(initial).isNotNull()
        assertThat(initial?.textToSpeak).isEqualTo("Amazing Grace")
        assertThat(initial?.baseOffset).isEqualTo(0)

        state.onRangeStart(start = 0, end = 7)
        state.onPause()

        val resumed = state.prepareSpeakRequest("Amazing Grace")
        assertThat(resumed).isNotNull()
        assertThat(resumed?.textToSpeak).isEqualTo("Grace")
        assertThat(resumed?.baseOffset).isEqualTo(7)
    }

    @Test
    fun stop_clearsResumeOffset() {
        val state = PlaybackSessionState()

        state.prepareSpeakRequest("Hello world")
        state.onRangeStart(start = 0, end = 5)
        state.onPause()
        state.onStop()

        val replay = state.prepareSpeakRequest("Hello world")
        assertThat(replay).isNotNull()
        assertThat(replay?.textToSpeak).isEqualTo("Hello world")
        assertThat(replay?.baseOffset).isEqualTo(0)
    }

    @Test
    fun resetForNewText_startsFromBeginningOfNewText() {
        val state = PlaybackSessionState()

        state.prepareSpeakRequest("Old text")
        state.onRangeStart(start = 0, end = 3)
        state.onPause()

        state.resetForNewText("New passage")
        val request = state.prepareSpeakRequest("New passage")

        assertThat(request).isNotNull()
        assertThat(request?.textToSpeak).isEqualTo("New passage")
        assertThat(request?.baseOffset).isEqualTo(0)
    }
}
