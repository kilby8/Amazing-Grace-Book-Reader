package com.amazinggrace.bookreader.domain

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.amazinggrace.bookreader.service.ReaderPlaybackService

class ReaderPlaybackController(
    private val context: Context
) {
    fun prepareText(text: String) {
        sendCommand(
            Intent(context, ReaderPlaybackService::class.java).apply {
                action = ReaderPlaybackService.ACTION_PREPARE_TEXT
                putExtra(ReaderPlaybackService.EXTRA_TEXT, text)
            },
            startForeground = false
        )
    }

    fun play(text: String, speechRate: Float, pitch: Float) {
        sendCommand(
            Intent(context, ReaderPlaybackService::class.java).apply {
                action = ReaderPlaybackService.ACTION_PLAY
                putExtra(ReaderPlaybackService.EXTRA_TEXT, text)
                putExtra(ReaderPlaybackService.EXTRA_SPEECH_RATE, speechRate)
                putExtra(ReaderPlaybackService.EXTRA_PITCH, pitch)
            },
            startForeground = true
        )
    }

    fun pause() {
        sendCommand(
            Intent(context, ReaderPlaybackService::class.java).apply {
                action = ReaderPlaybackService.ACTION_PAUSE
            },
            startForeground = false
        )
    }

    fun stop() {
        sendCommand(
            Intent(context, ReaderPlaybackService::class.java).apply {
                action = ReaderPlaybackService.ACTION_STOP
            },
            startForeground = false
        )
    }

    fun updateVoiceSettings(speechRate: Float, pitch: Float) {
        sendCommand(
            Intent(context, ReaderPlaybackService::class.java).apply {
                action = ReaderPlaybackService.ACTION_UPDATE_SETTINGS
                putExtra(ReaderPlaybackService.EXTRA_SPEECH_RATE, speechRate)
                putExtra(ReaderPlaybackService.EXTRA_PITCH, pitch)
            },
            startForeground = false
        )
    }

    private fun sendCommand(intent: Intent, startForeground: Boolean) {
        if (startForeground) {
            ContextCompat.startForegroundService(context, intent)
        } else {
            context.startService(intent)
        }
    }
}
