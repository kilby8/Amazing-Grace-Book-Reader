package com.amazinggrace.bookreader.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import com.amazinggrace.bookreader.R
import com.amazinggrace.bookreader.MainActivity
import com.amazinggrace.bookreader.domain.PlaybackHighlightRange
import com.amazinggrace.bookreader.domain.ReaderPlaybackStateStore
import com.amazinggrace.bookreader.tts.TtsManager
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class ReaderPlaybackService : Service(), LifecycleOwner {

    private val lifecycleRegistry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle
        get() = lifecycleRegistry

    private lateinit var ttsManager: TtsManager
    private lateinit var notificationManager: NotificationManager
    private var currentText: String = ""
    private var speechRate: Float = 1.0f
    private var pitch: Float = 1.0f
    private var isPlaying: Boolean = false
    private var foregroundStarted: Boolean = false
    private lateinit var mediaSession: MediaSessionCompat

    override fun onCreate() {
        super.onCreate()
        lifecycleRegistry.currentState = Lifecycle.State.CREATED
        notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        createNotificationChannel()
        mediaSession = MediaSessionCompat(this, "ReaderPlaybackSession").apply {
            isActive = true
            setPlaybackState(buildPlaybackState())
            setMetadata(buildMetadata())
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    if (currentText.isBlank()) return
                    isPlaying = true
                    setPlaybackState(buildPlaybackState())
                    startInForeground()
                    ttsManager.speak(currentText)
                    refreshNotification()
                }

                override fun onPause() {
                    ttsManager.pause()
                    isPlaying = false
                    setPlaybackState(buildPlaybackState())
                    refreshNotification()
                }

                override fun onStop() {
                    handleStop()
                }
            })
        }
        ttsManager = TtsManager(applicationContext, lifecycle)
        lifecycleRegistry.currentState = Lifecycle.State.STARTED

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    ttsManager.activeRange.collectLatest { range ->
                        ReaderPlaybackStateStore.updateActiveRange(
                            range?.let { PlaybackHighlightRange(it.start, it.endExclusive) }
                        )
                        refreshNotification()
                    }
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
            MediaButtonReceiver.handleIntent(mediaSession, intent)
            return START_STICKY
        }

        when (intent?.action) {
            ACTION_PREPARE_TEXT -> handlePrepareText(intent)
            ACTION_PLAY -> handlePlay(intent)
            ACTION_PAUSE -> handlePause()
            ACTION_STOP -> handleStop()
            ACTION_UPDATE_SETTINGS -> handleUpdateSettings(intent)
            else -> Unit
        }
        return START_STICKY
    }

    private fun handlePrepareText(intent: Intent) {
        currentText = intent.getStringExtra(EXTRA_TEXT).orEmpty()
        applyVoiceSettings(intent)
        ttsManager.resetForNewText(currentText)
        isPlaying = false
        mediaSession.setPlaybackState(buildPlaybackState())
        mediaSession.setMetadata(buildMetadata())
        refreshNotification()
    }

    private fun handlePlay(intent: Intent) {
        applyVoiceSettings(intent)
        val text = intent.getStringExtra(EXTRA_TEXT)
        if (!text.isNullOrBlank()) {
            currentText = text
            ttsManager.resetForNewText(currentText)
        }

        if (currentText.isBlank()) {
            refreshNotification()
            return
        }

        isPlaying = true
        mediaSession.setPlaybackState(buildPlaybackState())
        mediaSession.setMetadata(buildMetadata())
        startInForeground()
        ttsManager.speak(currentText)
        refreshNotification()
    }

    private fun handlePause() {
        ttsManager.pause()
        isPlaying = false
        mediaSession.setPlaybackState(buildPlaybackState())
        refreshNotification()
    }

    private fun handleStop() {
        ttsManager.stop()
        ReaderPlaybackStateStore.updateActiveRange(null)
        isPlaying = false
        currentText = ""
        mediaSession.setPlaybackState(buildPlaybackState())
        mediaSession.setMetadata(buildMetadata())
        refreshNotification()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        stopSelf()
    }

    private fun handleUpdateSettings(intent: Intent) {
        applyVoiceSettings(intent)
        mediaSession.setMetadata(buildMetadata())
        refreshNotification()
    }

    private fun applyVoiceSettings(intent: Intent) {
        if (intent.hasExtra(EXTRA_SPEECH_RATE)) {
            speechRate = intent.getFloatExtra(EXTRA_SPEECH_RATE, speechRate)
        }
        if (intent.hasExtra(EXTRA_PITCH)) {
            pitch = intent.getFloatExtra(EXTRA_PITCH, pitch)
        }
        ttsManager.updateSpeechRate(speechRate)
        ttsManager.updatePitch(pitch)
    }

    private fun startInForeground() {
        val notification = buildNotification()
        if (!foregroundStarted) {
            startForeground(NOTIFICATION_ID, notification)
            foregroundStarted = true
        } else {
            notificationManager.notify(NOTIFICATION_ID, notification)
        }
    }

    private fun refreshNotification() {
        val notification = buildNotification()
        if (foregroundStarted) {
            notificationManager.notify(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val contentText = when {
            currentText.isBlank() -> "Ready to read"
            isPlaying -> "Reading in background"
            else -> "Paused"
        }

        val playIntent = serviceIntent(ACTION_PLAY)
        val pauseIntent = serviceIntent(ACTION_PAUSE)
        val stopIntent = serviceIntent(ACTION_STOP)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Amazing Grace Book Reader")
            .setContentText(contentText)
            .setSubText(currentText.preview())
            .setOnlyAlertOnce(true)
            .setOngoing(isPlaying)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    10,
                    Intent(this, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    },
                    pendingIntentFlags()
                )
            )

        if (isPlaying) {
            builder.addAction(
                android.R.drawable.ic_media_pause,
                "Pause",
                PendingIntent.getService(
                    this,
                    1,
                    pauseIntent,
                    pendingIntentFlags()
                )
            )
        } else {
            builder.addAction(
                android.R.drawable.ic_media_play,
                "Play",
                PendingIntent.getService(
                    this,
                    0,
                    playIntent,
                    pendingIntentFlags()
                )
            )
        }

        builder.addAction(
            android.R.drawable.ic_menu_close_clear_cancel,
            "Stop",
            PendingIntent.getService(
                this,
                2,
                stopIntent,
                pendingIntentFlags()
            )
        )

        builder.setStyle(
            MediaStyle()
                .setMediaSession(mediaSession.sessionToken)
                .setShowActionsInCompactView(0, 1)
        )

        return builder.build()
    }

    private fun buildPlaybackState(): PlaybackStateCompat {
        val actions = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_STOP or
            PlaybackStateCompat.ACTION_PLAY_PAUSE

        val state = if (isPlaying) {
            PlaybackStateCompat.STATE_PLAYING
        } else {
            PlaybackStateCompat.STATE_PAUSED
        }

        return PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
            .build()
    }

    private fun buildMetadata(): MediaMetadataCompat {
        val durationHint = (currentText.length * 65L)
        return MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, "Amazing Grace Reader")
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "Text to Speech")
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, currentText.preview())
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationHint)
            .build()
    }

    private fun serviceIntent(action: String): Intent {
        return Intent(this, ReaderPlaybackService::class.java).apply {
            this.action = action
            if (action == ACTION_PLAY || action == ACTION_PREPARE_TEXT || action == ACTION_UPDATE_SETTINGS) {
                putExtra(EXTRA_TEXT, currentText)
                putExtra(EXTRA_SPEECH_RATE, speechRate)
                putExtra(EXTRA_PITCH, pitch)
            }
        }
    }

    private fun pendingIntentFlags(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Reader Playback",
            NotificationManager.IMPORTANCE_LOW
        )
        notificationManager.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        ttsManager.stop()
        ttsManager.onDestroy(this)
        mediaSession.isActive = false
        mediaSession.release()
        ReaderPlaybackStateStore.updateActiveRange(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "reader_playback"
        const val NOTIFICATION_ID = 1001

        const val ACTION_PREPARE_TEXT = "com.amazinggrace.bookreader.action.PREPARE_TEXT"
        const val ACTION_PLAY = "com.amazinggrace.bookreader.action.PLAY"
        const val ACTION_PAUSE = "com.amazinggrace.bookreader.action.PAUSE"
        const val ACTION_STOP = "com.amazinggrace.bookreader.action.STOP"
        const val ACTION_UPDATE_SETTINGS = "com.amazinggrace.bookreader.action.UPDATE_SETTINGS"

        const val EXTRA_TEXT = "extra_text"
        const val EXTRA_SPEECH_RATE = "extra_speech_rate"
        const val EXTRA_PITCH = "extra_pitch"
    }
}

private fun String.preview(maxChars: Int = 90): String {
    if (isBlank()) return ""
    val normalized = replace("\n", " ").trim()
    return if (normalized.length <= maxChars) {
        normalized
    } else {
        normalized.take(maxChars).trimEnd() + "..."
    }
}
