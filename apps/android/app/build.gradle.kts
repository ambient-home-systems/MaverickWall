plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "systems.ambienthome.maverickwall"
    compileSdk = 34

    defaultConfig {
        applicationId = "systems.ambienthome.maverickwall"
        // minSdk 24 (Android 7.0): old wall tablets and cheap TV boxes are the
        // target, and a WebView kiosk needs nothing newer.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // Shrinking is safe here — the app is a thin shell with no
            // reflection-heavy libraries — and keeps the sideloaded APK small.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        // BuildConfig is used for nothing yet; off keeps the build lean.
        buildConfig = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.webkit)
    // The health probe's backoff loop uses delay/withContext directly, so the
    // dependency is declared rather than leaned on transitively.
    implementation(libs.kotlinx.coroutines.android)

    // Compose, for the setup and status chrome only.
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
}
