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
    val textScale: Float
)

class ReaderPreferences(private val context: Context) {

    suspend fun loadSnapshot(): ReaderPreferencesSnapshot {
        return context.dataStore.data
            .map { prefs ->
                ReaderPreferencesSnapshot(
                    lastParsedText = prefs[LAST_PARSED_TEXT] ?: "",
                    speechRate = (prefs[SPEECH_RATE] ?: 1.0f).coerceIn(0.5f, 2.0f),
                    pitch = (prefs[PITCH] ?: 1.0f).coerceIn(0.5f, 2.0f),
                    textScale = (prefs[TEXT_SCALE] ?: 1.0f).coerceIn(0.85f, 1.4f)
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

    private companion object {
        val LAST_PARSED_TEXT: Preferences.Key<String> = stringPreferencesKey("last_parsed_text")
        val SPEECH_RATE: Preferences.Key<Float> = floatPreferencesKey("speech_rate")
        val PITCH: Preferences.Key<Float> = floatPreferencesKey("pitch")
        val TEXT_SCALE: Preferences.Key<Float> = floatPreferencesKey("text_scale")
    }
}
