package com.amazinggrace.bookreader.domain

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast

class ReaderTextActions(
    private val context: Context
) {
    fun copyToClipboard(text: String) {
        if (text.isBlank()) return

        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Parsed Book Text", text))
        Toast.makeText(context, "Text copied to clipboard", Toast.LENGTH_SHORT).show()
    }

    fun shareText(text: String) {
        if (text.isBlank()) return

        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            putExtra(Intent.EXTRA_SUBJECT, "Amazing Grace Book Reader Text")
        }

        runCatching {
            context.startActivity(Intent.createChooser(sendIntent, "Share extracted text"))
        }.onFailure {
            if (it is ActivityNotFoundException) {
                Toast.makeText(context, "No app available to share text", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
