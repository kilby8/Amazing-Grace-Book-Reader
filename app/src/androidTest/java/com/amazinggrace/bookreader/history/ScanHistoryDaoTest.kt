package com.amazinggrace.bookreader.history

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScanHistoryDaoTest {

    private lateinit var database: ReaderDatabase
    private lateinit var dao: ScanHistoryDao

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            ReaderDatabase::class.java
        ).allowMainThreadQueries().build()
        dao = database.scanHistoryDao()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun observeRecentScans_returnsNewestFirst() = runBlocking {
        dao.insert(
            ScanHistoryEntity(
                createdAtEpochMillis = 1,
                textSnippet = "Older",
                fullText = "Older Text"
            )
        )
        dao.insert(
            ScanHistoryEntity(
                createdAtEpochMillis = 2,
                textSnippet = "Newer",
                fullText = "Newer Text"
            )
        )

        val rows = dao.observeRecentScans().first()

        assertThat(rows).hasSize(2)
        assertThat(rows[0].createdAtEpochMillis).isEqualTo(2)
        assertThat(rows[1].createdAtEpochMillis).isEqualTo(1)
    }

    @Test
    fun trimToLatest_keepsConfiguredCount() = runBlocking {
        dao.insert(ScanHistoryEntity(createdAtEpochMillis = 10, textSnippet = "1", fullText = "1"))
        dao.insert(ScanHistoryEntity(createdAtEpochMillis = 20, textSnippet = "2", fullText = "2"))
        dao.insert(ScanHistoryEntity(createdAtEpochMillis = 30, textSnippet = "3", fullText = "3"))

        dao.trimToLatest(maxRows = 2)

        val rows = dao.observeRecentScans().first()
        assertThat(rows).hasSize(2)
        assertThat(rows.map { it.createdAtEpochMillis }).containsExactly(30L, 20L)
    }

    @Test
    fun deleteById_removesRequestedRow() = runBlocking {
        dao.insert(ScanHistoryEntity(createdAtEpochMillis = 100, textSnippet = "A", fullText = "A"))
        dao.insert(ScanHistoryEntity(createdAtEpochMillis = 200, textSnippet = "B", fullText = "B"))

        val firstRow = dao.observeRecentScans().first().first()
        dao.deleteById(firstRow.id)

        val rows = dao.observeRecentScans().first()
        assertThat(rows).hasSize(1)
        assertThat(rows.first().id).isNotEqualTo(firstRow.id)
    }
}
