import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

/*
 * The version, and the signing key, both come from outside the file.
 *
 * The monorepo tags one commit and the RFC's rule is that the app, server and
 * image cannot disagree — so the released APK carries the *release* version, not
 * a number hand-maintained here that would drift. `release.yml` passes it in
 * (`-PmwVersionName=0.22.0 -PmwVersionCode=22`); a plain local build falls back
 * to a dev version so `assembleDebug` needs no properties.
 */
val mwVersionName = (project.findProperty("mwVersionName") as String?)?.takeIf { it.isNotBlank() } ?: "0.1.0"
val mwVersionCode = (project.findProperty("mwVersionCode") as String?)?.toIntOrNull() ?: 1

/*
 * Signing material never lives in the repo (rule six). It arrives one of two
 * ways: a `keystore.properties` beside this project (gitignored, for a local
 * signed build) or environment variables (the release workflow, from repo
 * secrets). When neither is present — an ordinary `assembleRelease` on a
 * contributor's machine or in plain CI — the release build is simply left
 * unsigned rather than failing, so the build is never gated on a secret nobody
 * has.
 */
val keystoreProps = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signingValue(propertyKey: String, envKey: String): String? =
    (keystoreProps.getProperty(propertyKey) ?: System.getenv(envKey))?.takeIf { it.isNotBlank() }
val releaseStoreFile = signingValue("storeFile", "MW_KEYSTORE_FILE")

android {
    namespace = "systems.ambienthome.maverickwall"
    compileSdk = 34

    defaultConfig {
        applicationId = "systems.ambienthome.maverickwall"
        // minSdk 24 (Android 7.0): old wall tablets and cheap TV boxes are the
        // target, and a WebView kiosk needs nothing newer.
        minSdk = 24
        targetSdk = 34
        versionCode = mwVersionCode
        versionName = mwVersionName
    }

    signingConfigs {
        create("release") {
            // Populated only when the material is actually present; otherwise
            // this config stays empty and is not attached to the build type
            // below, so an unsigned release APK still builds.
            if (releaseStoreFile != null) {
                storeFile = file(releaseStoreFile)
                storePassword = signingValue("storePassword", "MW_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "MW_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "MW_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Signed only when a key was supplied; null leaves the APK unsigned
            // (a contributor build, or CI with no secrets) rather than failing.
            signingConfig = if (releaseStoreFile != null) signingConfigs.getByName("release") else null
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
    // The push socket client (Phase 2). Also carries the cert pinner and the
    // TLS plumbing trust-on-pairing needs — one dependency, not a stack.
    implementation(libs.okhttp)
    // The pairing QR encoder (Phase 3). Offline, drawn on the TV for a phone to
    // scan; no camera/scanner half of ZXing, just the encoder.
    implementation(libs.zxing.core)

    // Compose, for the setup and status chrome only.
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
}
