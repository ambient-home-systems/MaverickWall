// Top-level build file. Plugins are declared here without applying them, so the
// versions resolve once from the catalog and each module applies what it needs.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
