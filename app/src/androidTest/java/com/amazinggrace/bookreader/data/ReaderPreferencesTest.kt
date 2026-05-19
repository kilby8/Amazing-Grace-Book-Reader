package com.amazinggrace.bookreader.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ReaderPreferencesTest {

    private lateinit var readerPreferences: ReaderPreferences

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val datastoreFile = File(context.filesDir.parentFile, "datastore/reader_preferences.preferences_pb")
        if (datastoreFile.exists()) {
            datastoreFile.delete()
        }
        readerPreferences = ReaderPreferences(context)
    }

    @Test
    fun saveAndLoadSnapshot_persistsValues() = runBlocking {
        readerPreferences.saveLastParsedText("Amazing Grace text")
        readerPreferences.saveVoiceSettings(speechRate = 1.4f, pitch = 0.8f)

        val snapshot = readerPreferences.loadSnapshot()

        assertThat(snapshot.lastParsedText).isEqualTo("Amazing Grace text")
        assertThat(snapshot.speechRate).isEqualTo(1.4f)
        assertThat(snapshot.pitch).isEqualTo(0.8f)
        assertThat(snapshot.textScale).isEqualTo(1.0f)
    }

    @Test
    fun saveVoiceSettings_clampsOutOfRangeValues() = runBlocking {
        readerPreferences.saveVoiceSettings(speechRate = 5.0f, pitch = 0.1f)

        val snapshot = readerPreferences.loadSnapshot()

        assertThat(snapshot.speechRate).isEqualTo(2.0f)
        assertThat(snapshot.pitch).isEqualTo(0.5f)
    }

    @Test
    fun saveTextScale_clampsOutOfRangeValues() = runBlocking {
        readerPreferences.saveTextScale(2.2f)

        val snapshot = readerPreferences.loadSnapshot()

        assertThat(snapshot.textScale).isEqualTo(1.4f)
    }
}
