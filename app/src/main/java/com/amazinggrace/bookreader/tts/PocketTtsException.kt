package com.amazinggrace.bookreader.tts

/**
 * Raised by [PocketTtsClient] when the pocket-tts endpoint returns a non-2xx response
 * or an empty body. Network/IO failures bubble up as [java.io.IOException] instead.
 */
class PocketTtsException(message: String) : RuntimeException(message)
