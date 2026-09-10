package com.amazinggrace.bookreader.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "reader_preferences")

data class ReaderPreferencesSnapshot(
    val lastParsedText: String,
    val speechRate: Float,
    val pitch: Float,
    val textScale: Float,
    val ttsEngine: String,
    val pocketTtsBaseUrl: String,
    val pocketTtsVoice: String
)

class ReaderPreferences(private val context: Context) {

    suspend fun loadSnapshot(): ReaderPreferencesSnapshot {
        return context.dataStore.data
            .map { prefs ->
                ReaderPreferencesSnapshot(
                    lastParsedText = prefs[LAST_PARSED_TEXT] ?: "",
                    speechRate = (prefs[SPEECH_RATE] ?: 1.0f).coerceIn(0.5f, 2.0f),
                    pitch = (prefs[PITCH] ?: 1.0f).coerceIn(0.5f, 2.0f),
                    textScale = (prefs[TEXT_SCALE] ?: 1.0f).coerceIn(0.85f, 1.4f),
                    ttsEngine = prefs[TTS_ENGINE] ?: DEFAULT_TTS_ENGINE,
                    pocketTtsBaseUrl = prefs[POCKET_TTS_BASE_URL] ?: DEFAULT_POCKET_TTS_BASE_URL,
                    pocketTtsVoice = prefs[POCKET_TTS_VOICE] ?: DEFAULT_POCKET_TTS_VOICE
                )
            }
            .first()
    }

    suspend fun saveLastParsedText(text: String) {
        context.dataStore.edit { prefs ->
            prefs[LAST_PARSED_TEXT] = text
        }
    }

    suspend fun saveVoiceSettings(speechRate: Float, pitch: Float) {
        context.dataStore.edit { prefs ->
            prefs[SPEECH_RATE] = speechRate.coerceIn(0.5f, 2.0f)
            prefs[PITCH] = pitch.coerceIn(0.5f, 2.0f)
        }
    }

    suspend fun saveTextScale(textScale: Float) {
        context.dataStore.edit { prefs ->
            prefs[TEXT_SCALE] = textScale.coerceIn(0.85f, 1.4f)
        }
    }

    suspend fun saveTtsEngine(engine: String) {
        val clamped = if (engine == POCKET_TTS) POCKET_TTS else ANDROID_TTS
        context.dataStore.edit { prefs ->
            prefs[TTS_ENGINE] = clamped
        }
    }

    suspend fun savePocketTtsBaseUrl(url: String) {
        val trimmed = url.trim()
        require(trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            "Pocket TTS URL must start with http:// or https://"
        }
        context.dataStore.edit { prefs ->
            prefs[POCKET_TTS_BASE_URL] = trimmed
        }
    }

    suspend fun savePocketTtsVoice(voice: String) {
        val trimmed = voice.trim()
        require(trimmed.isNotEmpty()) { "Pocket TTS voice cannot be empty" }
        context.dataStore.edit { prefs ->
            prefs[POCKET_TTS_VOICE] = trimmed
        }
    }

    private companion object {
        const val ANDROID_TTS = "android"
        const val POCKET_TTS = "pocket_tts"

        const val DEFAULT_TTS_ENGINE = ANDROID_TTS
        const val DEFAULT_POCKET_TTS_BASE_URL = "http://10.0.2.2:8765"
        const val DEFAULT_POCKET_TTS_VOICE = "eve"

        val LAST_PARSED_TEXT: Preferences.Key<String> = stringPreferencesKey("last_parsed_text")
        val SPEECH_RATE: Preferences.Key<Float> = floatPreferencesKey("speech_rate")
        val PITCH: Preferences.Key<Float> = floatPreferencesKey("pitch")
        val TEXT_SCALE: Preferences.Key<Float> = floatPreferencesKey("text_scale")
        val TTS_ENGINE: Preferences.Key<String> = stringPreferencesKey("tts_engine")
        val POCKET_TTS_BASE_URL: Preferences.Key<String> = stringPreferencesKey("pocket_tts_base_url")
        val POCKET_TTS_VOICE: Preferences.Key<String> = stringPreferencesKey("pocket_tts_voice")
    }
}
