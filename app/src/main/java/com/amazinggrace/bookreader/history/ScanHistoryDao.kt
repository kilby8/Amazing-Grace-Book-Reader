package com.amazinggrace.bookreader.history

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface ScanHistoryDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entity: ScanHistoryEntity)

    @Query("DELETE FROM scan_history WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query(
        "DELETE FROM scan_history " +
            "WHERE id NOT IN (" +
            "SELECT id FROM scan_history ORDER BY createdAtEpochMillis DESC LIMIT :maxRows" +
            ")"
    )
    suspend fun trimToLatest(maxRows: Int)

    @Query("SELECT * FROM scan_history ORDER BY createdAtEpochMillis DESC")
    fun observeRecentScans(): Flow<List<ScanHistoryEntity>>
}
