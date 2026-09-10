package com.amazinggrace.bookreader.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Mirrors [ReaderPreferencesTest] but for the new pocket-tts preference keys. Saves a value
 * through one [ReaderPreferences] instance, builds a fresh instance over the same backing
 * file, and verifies the value survives the "restart".
 */
@RunWith(AndroidJUnit4::class)
class PocketTtsPreferenceTest {

    private lateinit var context: android.content.Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        val datastoreFile = File(
            context.filesDir.parentFile,
            "datastore/reader_preferences.preferences_pb"
        )
        if (datastoreFile.exists()) {
            datastoreFile.delete()
        }
    }

    @Test
    fun saveAndLoadPocketTtsBaseUrl_persistsAcrossRestart() = runBlocking {
        val writer = ReaderPreferences(context)
        writer.savePocketTtsBaseUrl("http://192.168.1.42:9000")

        // Simulate an app restart by creating a new ReaderPreferences instance over the
        // same DataStore backing file.
        val reader = ReaderPreferences(context)
        val snapshot = reader.loadSnapshot()

        assertThat(snapshot.pocketTtsBaseUrl).isEqualTo("http://192.168.1.42:9000")
    }

    @Test
    fun defaultsAreAppliedWhenNoValuesPersisted() = runBlocking {
        val reader = ReaderPreferences(context)
        val snapshot = reader.loadSnapshot()

        assertThat(snapshot.ttsEngine).isEqualTo("android")
        assertThat(snapshot.pocketTtsBaseUrl).isEqualTo("http://10.0.2.2:8765")
        assertThat(snapshot.pocketTtsVoice).isEqualTo("eve")
    }

    @Test
    fun savePocketTtsVoice_persistsAcrossRestart() = runBlocking {
        val writer = ReaderPreferences(context)
        writer.savePocketTtsVoice("alba")

        val reader = ReaderPreferences(context)
        val snapshot = reader.loadSnapshot()

        assertThat(snapshot.pocketTtsVoice).isEqualTo("alba")
    }

    @Test
    fun saveTtsEngine_persistsAcrossRestart() = runBlocking {
        val writer = ReaderPreferences(context)
        writer.saveTtsEngine("pocket_tts")

        val reader = ReaderPreferences(context)
        val snapshot = reader.loadSnapshot()

        assertThat(snapshot.ttsEngine).isEqualTo("pocket_tts")
    }
}
