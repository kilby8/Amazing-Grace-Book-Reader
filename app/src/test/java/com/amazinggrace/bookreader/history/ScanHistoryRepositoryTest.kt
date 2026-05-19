package com.amazinggrace.bookreader.history

import com.amazinggrace.bookreader.ui.HistoryUiItem
import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Test

class ScanHistoryRepositoryTest {

    @Test
    fun observeHistory_mapsDaoRowsToUiItems() = runBlocking {
        val dao = FakeScanHistoryDao()
        dao.rows.value = listOf(
            ScanHistoryEntity(
                id = 1,
                createdAtEpochMillis = 10,
                textSnippet = "Snippet",
                fullText = "Full"
            )
        )
        val repository = ScanHistoryRepository(dao)

        val result = repository.observeHistory().first()

        assertThat(result).hasSize(1)
        assertThat(result.first().id).isEqualTo(1)
        assertThat(result.first().textSnippet).isEqualTo("Snippet")
    }

    @Test
    fun saveScan_buildsSnippetAndTrimsHistory() = runBlocking {
        val dao = FakeScanHistoryDao()
        val repository = ScanHistoryRepository(dao, maxRows = 5)

        repository.saveScan("Line 1\nLine 2")

        val inserted = dao.inserted.single()
        assertThat(inserted.textSnippet).isEqualTo("Line 1 Line 2")
        assertThat(inserted.fullText).isEqualTo("Line 1\nLine 2")
        assertThat(dao.trimmedTo).isEqualTo(5)
    }

    @Test
    fun restore_reinsertsOriginalItemAndTrims() = runBlocking {
        val dao = FakeScanHistoryDao()
        val repository = ScanHistoryRepository(dao, maxRows = 3)
        val item = HistoryUiItem(
            id = 42,
            createdAtEpochMillis = 100,
            textSnippet = "Saved",
            fullText = "Saved full text"
        )

        repository.restore(item)

        val inserted = dao.inserted.single()
        assertThat(inserted.id).isEqualTo(42)
        assertThat(inserted.fullText).isEqualTo("Saved full text")
        assertThat(dao.trimmedTo).isEqualTo(3)
    }

    @Test
    fun deleteById_callsDaoDelete() = runBlocking {
        val dao = FakeScanHistoryDao()
        val repository = ScanHistoryRepository(dao)

        repository.deleteById(77)

        assertThat(dao.deletedId).isEqualTo(77)
    }

    private class FakeScanHistoryDao : ScanHistoryDao {
        val rows = MutableStateFlow<List<ScanHistoryEntity>>(emptyList())
        val inserted = mutableListOf<ScanHistoryEntity>()
        var deletedId: Long? = null
        var trimmedTo: Int? = null

        override suspend fun insert(entity: ScanHistoryEntity) {
            inserted += entity
        }

        override suspend fun deleteById(id: Long) {
            deletedId = id
        }

        override suspend fun trimToLatest(maxRows: Int) {
            trimmedTo = maxRows
        }

        override fun observeRecentScans(): Flow<List<ScanHistoryEntity>> = rows
    }
}
