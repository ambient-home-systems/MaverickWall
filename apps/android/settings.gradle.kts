pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.10.0"
}

dependencyResolutionManagement {
    // FAIL_ON_PROJECT_REPOS: repositories are declared here and nowhere else, so
    // no module can quietly pull from an unexpected source. This is a
    // sideloaded, self-hosted app; the dependency set stays small and audited.
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

// Deliberately standalone: this Gradle build is *not* part of the pnpm
// workspace (see the root pnpm-workspace.yaml exclusion). It lives in the
// monorepo so app, display and server versions tag as one commit and cannot
// disagree — the same "one tag, one image, all three agree" rule CLAUDE.md
// prizes — but it builds with Gradle and the Android toolchain, not pnpm.
rootProject.name = "MaverickWall"
include(":app")
