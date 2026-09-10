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

    suspend fun saveTextScale(textScale: Float) {
        preferences.saveTextScale(textScale)
    }

    suspend fun saveTtsEngine(engine: String) {
        preferences.saveTtsEngine(engine)
    }

    suspend fun savePocketTtsBaseUrl(url: String) {
        preferences.savePocketTtsBaseUrl(url)
    }

    suspend fun savePocketTtsVoice(voice: String) {
        preferences.savePocketTtsVoice(voice)
    }
}
