# The app hosts a WebView but exposes no @JavascriptInterface bridge in Phase 1
# (the wake bridge lands in Phase 2, and its methods will need keep rules then).
# Nothing here is reached by reflection or from JS today, so the defaults from
# proguard-android-optimize.txt are enough. This file is the place those keep
# rules go when the bridge exists.
