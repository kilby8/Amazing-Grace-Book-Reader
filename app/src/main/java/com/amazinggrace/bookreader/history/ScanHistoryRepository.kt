package com.amazinggrace.bookreader.history

import com.amazinggrace.bookreader.domain.HistoryTextWriter
import com.amazinggrace.bookreader.ui.HistoryUiItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class ScanHistoryRepository(
    private val dao: ScanHistoryDao,
    private val maxRows: Int = DEFAULT_MAX_HISTORY_ROWS
) : HistoryTextWriter {

    fun observeHistory(): Flow<List<HistoryUiItem>> {
        return dao.observeRecentScans().map { rows ->
            rows.map { row ->
                HistoryUiItem(
                    id = row.id,
                    createdAtEpochMillis = row.createdAtEpochMillis,
                    textSnippet = row.textSnippet,
                    fullText = row.fullText
                )
            }
        }
    }

    override suspend fun saveScan(fullText: String) {
        val snippet = fullText
            .replace("\n", " ")
            .trim()
            .take(180)
            .ifBlank { "Untitled scan" }

        dao.insert(
            ScanHistoryEntity(
                createdAtEpochMillis = System.currentTimeMillis(),
                textSnippet = snippet,
                fullText = fullText
            )
        )
        dao.trimToLatest(maxRows)
    }

    suspend fun deleteById(id: Long) {
        dao.deleteById(id)
    }

    suspend fun restore(item: HistoryUiItem) {
        dao.insert(
            ScanHistoryEntity(
                id = item.id,
                createdAtEpochMillis = item.createdAtEpochMillis,
                textSnippet = item.textSnippet,
                fullText = item.fullText
            )
        )
        dao.trimToLatest(maxRows)
    }

    companion object {
        const val DEFAULT_MAX_HISTORY_ROWS = 200
    }
}
