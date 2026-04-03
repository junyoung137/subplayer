#!/bin/bash
# Run this script to verify your build environment before expo run:android

echo "=== RealtimeSub Build Environment Check ==="

SDK_DIR="$HOME/AppData/Local/Android/Sdk"
NDK_VERSION="27.1.12297006"

# Check SDK
if [ -d "$SDK_DIR" ]; then
  echo "✅ Android SDK found: $SDK_DIR"
else
  echo "❌ Android SDK NOT found at $SDK_DIR"
fi

# Check platform
if [ -d "$SDK_DIR/platforms/android-36" ] || [ -d "$SDK_DIR/platforms/android-36.1" ]; then
  echo "✅ Android Platform 36 found"
else
  echo "❌ Android Platform 36 NOT found — install via SDK Manager"
fi

# Check build-tools
if [ -d "$SDK_DIR/build-tools/36.1.0" ]; then
  echo "✅ Build Tools 36.1.0 found"
else
  echo "❌ Build Tools 36.1.0 NOT found — install via SDK Manager"
fi

# Check NDK (required by whisper.rn)
if [ -d "$SDK_DIR/ndk/$NDK_VERSION" ]; then
  echo "✅ NDK $NDK_VERSION found"
else
  echo "❌ NDK $NDK_VERSION NOT found"
  echo "   → Android Studio > SDK Manager > SDK Tools > NDK (Side by side)"
  echo "   → Check 'Show Package Details', select version $NDK_VERSION"
fi

# Check Java
if command -v java &>/dev/null; then
  echo "✅ Java: $(java -version 2>&1 | head -1)"
else
  echo "❌ Java not found — install JDK 17"
fi

echo ""
echo "=== To build ==="
echo "cd RealtimeSub && npx expo run:android"
