package com.amazinggrace.bookreader.tts

class PlaybackSessionState {

    data class SpeakRequest(
        val textToSpeak: String,
        val baseOffset: Int
    )

    data class ActiveTextRange(
        val start: Int,
        val endExclusive: Int
    )

    private var sourceText: String = ""
    private var paused: Boolean = false
    private var resumeOffset: Int = 0
    private var utteranceBaseOffset: Int = 0

    fun prepareSpeakRequest(text: String): SpeakRequest? {
        if (text.isBlank()) return null

        if (text != sourceText) {
            sourceText = text
            resumeOffset = 0
            paused = false
        }

        val startOffset = if (paused) {
            resumeOffset.coerceIn(0, sourceText.length)
        } else {
            0
        }

        val remainingText = sourceText.substring(startOffset).trimStart()
        return if (remainingText.isBlank()) {
            resumeOffset = 0
            utteranceBaseOffset = 0
            paused = false
            SpeakRequest(textToSpeak = sourceText, baseOffset = 0)
        } else {
            utteranceBaseOffset = startOffset
            paused = false
            SpeakRequest(textToSpeak = remainingText, baseOffset = startOffset)
        }
    }

    fun onRangeStart(start: Int, end: Int): ActiveTextRange {
        val absoluteStart = (utteranceBaseOffset + start).coerceAtMost(sourceText.length)
        val absoluteEnd = (utteranceBaseOffset + end).coerceAtMost(sourceText.length)
        resumeOffset = absoluteEnd
        return ActiveTextRange(start = absoluteStart, endExclusive = absoluteEnd)
    }

    fun onPause() {
        paused = true
    }

    fun onStop() {
        paused = false
        resumeOffset = 0
        utteranceBaseOffset = 0
    }

    fun onUtteranceDone() {
        if (!paused) {
            resumeOffset = 0
        }
    }

    fun resetForNewText(newText: String) {
        sourceText = newText
        resumeOffset = 0
        utteranceBaseOffset = 0
        paused = false
    }

    fun isPaused(): Boolean = paused

    fun currentText(): String = sourceText
}
