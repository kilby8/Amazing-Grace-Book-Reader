plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}

android {
    namespace = "com.amazinggrace.bookreader"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.amazinggrace.bookreader"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            // R8 minify+shrink the release build. The classpath (Compose + ML
            // Kit + Room + DataStore + OkHttp + the rest) is too large for d8's
            // 2g fork to merge unminified, so the debug APK OOMs in
            // mergeExtDexDebug on memory-constrained dev machines. R8 strips
            // ~70% of unused classes/resources before dexing, so the release
            // APK fits. The previous media3-exoplayer deps were the second-
            // largest contributor; they have been replaced with the platform
            // android.media.MediaPlayer (no extra AAR).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    // NOTE: AGP's d8 worker uses a forked JVM with a 2g heap. Compose +
    // material-icons-extended already push the merged dex close to that
    // limit. dexOptions.javaMaxHeapSize is honored by the legacy dx tool
    // only, not d8. assembleDebug OOMs in the d8 fork on memory-constrained
    // dev machines; ./gradlew test is unaffected. The release build escapes
    // the ceiling by running R8 first, which trims the classpath before d8
    // sees it.

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.media:media:1.7.0")

    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // Icons vendored as vector drawables in res/drawable/ to keep the
    // dexed classpath small enough for d8 on Windows hosts.
    // See res/drawable/ic_content_copy.xml, ic_share.xml, ic_picture_as_pdf.xml.

    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // PDF text extraction is done via the platform's android.graphics.pdf.PdfRenderer
    // (API 21+, available since this app's minSdk = 24) plus the existing
    // OcrManager (ML Kit text recognition). The previous pdfbox-android AAR
    // contributed ~6 MB / 1000+ classes that pushed the d8 merge step over
    // its 2 GB worker heap; dropping it restores the assembleDebug path on
    // memory-constrained dev machines. See PdfTextExtractor.

    // HTTP client (pocket-tts)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    // Audio playback for pocket-tts is done with the platform android.media.MediaPlayer
    // (API 1+). The previous androidx.media3:media3-exoplayer + media3-common deps
    // added ~12 MB of AAR / 1000+ classes that pushed d8's 2 GB worker fork over its
    // heap limit during assembleDebug. MediaPlayer is built into the platform so it
    // adds no extra classes to the dexed classpath.
    // The compose-bom 2024.09.00 pulls in material-icons-extended which already
    // stress-tests D8; the dropped media3 deps were the second-largest contributor.
    // Icons remain vendored as vector drawables in res/drawable/ to keep the dexed
    // footprint lean (see ic_content_copy.xml, ic_share.xml, ic_picture_as_pdf.xml).

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.truth:truth:1.4.4")
    testImplementation("org.robolectric:robolectric:4.13")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.room:room-testing:2.6.1")
    androidTestImplementation("com.google.truth:truth:1.4.4")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
