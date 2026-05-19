package com.amazinggrace.bookreader.data

import com.amazinggrace.bookreader.domain.SessionTextWriter

class ReaderSessionRepository(
    private val preferences: ReaderPreferences
) : SessionTextWriter {
    suspend fun loadSnapshot(): ReaderPreferencesSnapshot = preferences.loadSnapshot()

    override suspend fun saveLastParsedText(text: String) {
        preferences.saveLastParsedText(text)
    }

    suspend fun saveVoiceSettings(speechRate: Float, pitch: Float) {
        preferences.saveVoiceSettings(speechRate, pitch)
    }
}
