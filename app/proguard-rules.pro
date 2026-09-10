# ProGuard / R8 rules for the release build.
#
# Strategy: start minimal and only add explicit keep rules if R8 strips
# something that breaks at runtime. Modern AARs (Compose, Room, DataStore,
# ML Kit, OkHttp, Material Icons) ship their own consumer rules in the
# META-INF/proguard/ directory of the AAR, so R8 picks them up
# automatically. The rules below are only for the entry points and Kotlin
# metadata our own code relies on.

# --- Android entry points --------------------------------------------------
# These are referenced by AndroidManifest.xml. R8 will figure out the rest of
# the call graph, but the manifest entries themselves are strings, so the
# classes that satisfy them need to survive shrinking.
-keep public class com.amazinggrace.bookreader.MainActivity
-keep public class * extends android.app.Application
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.content.ContentProvider

# FileProvider is a class-name reference from AndroidManifest.xml (the
# androidx.core.content.FileProvider authority entry). It is already kept by
# the androidx.core consumer rules, but the explicit keep documents intent.
-keep class androidx.core.content.FileProvider { *; }

# --- TTS engine interface ---------------------------------------------------
# SpeechEngine is referenced via interface dispatch in TtsManager. The
# concrete implementations (AndroidTtsEngine, PocketTtsEngine) are stored as
# SpeechEngine references. Keep the interface so both implementations stay
# wired up — R8 would otherwise drop the interface methods if it thought
# nothing called them, and dynamic dispatch would NoSuchMethodError.
-keep public interface com.amazinggrace.bookreader.tts.SpeechEngine { *; }

# --- Kotlin metadata -------------------------------------------------------
# Compose + the rest of the Kotlin stack use reflection against generated
# @Metadata annotations. Stripping them tends to break things in subtle ways
# (especially kotlinx-coroutines). Keep the attributes and annotations so
# Kotlin reflection continues to work after minification.
-keepattributes RuntimeVisibleAnnotations
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes EnclosingMethod
-keepattributes InnerClasses

# --- Crash diagnostics -----------------------------------------------------
# Preserve source file + line numbers in stack traces so a release crash is
# still readable. The default proguard-android-optimize.txt already enables
# these, but the rules here are explicit and survive config drift.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
