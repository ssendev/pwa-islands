#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Umgebungsvariablen für Android ermitteln
if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Android/Sdk" ]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
fi

if [ -z "${NDK_HOME:-}" ] && [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  LATEST_NDK="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$LATEST_NDK" ]; then
    export NDK_HOME="$LATEST_NDK"
  fi
fi

if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d "/var/lib/flatpak/app/com.google.AndroidStudio/current/active/files/extra/jbr" ]; then
    export JAVA_HOME="/var/lib/flatpak/app/com.google.AndroidStudio/current/active/files/extra/jbr"
  elif [ -d "/opt/android-studio/jbr" ]; then
    export JAVA_HOME="/opt/android-studio/jbr"
  fi
fi

if [ -n "${JAVA_HOME:-}" ] && [[ ":$PATH:" != *":$JAVA_HOME/bin:"* ]]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

ANDROID_DIR="$ROOT_DIR/src-tauri/gen/android"
KEYSTORE_FILE="$ANDROID_DIR/release.keystore"
PROPERTIES_FILE="$ANDROID_DIR/keystore.properties"

# 2. Keystore und keystore.properties bei Bedarf automatisch anlegen
if [ ! -f "$KEYSTORE_FILE" ] || [ ! -f "$PROPERTIES_FILE" ]; then
  echo "==> Erstelle Android Signing-Key (gitignored):"
  mkdir -p "$ANDROID_DIR"

  KEY_PASS="${ANDROID_KEY_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 20)}"
  STORE_PASS="${ANDROID_STORE_PASSWORD:-$KEY_PASS}"
  KEY_ALIAS="${ANDROID_KEY_ALIAS:-pwa-islands}"

  if [ ! -f "$KEYSTORE_FILE" ]; then
    keytool -genkeypair \
      -v \
      -keystore "$KEYSTORE_FILE" \
      -alias "$KEY_ALIAS" \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -storepass "$STORE_PASS" \
      -keypass "$KEY_PASS" \
      -dname "CN=PWA Islands, O=SSEN, C=DE"
    chmod 600 "$KEYSTORE_FILE"
    echo "  Keystore erstellt: $KEYSTORE_FILE"
  fi

  cat > "$PROPERTIES_FILE" <<EOF
storeFile=release.keystore
storePassword=$STORE_PASS
keyAlias=$KEY_ALIAS
keyPassword=$KEY_PASS
EOF
  chmod 600 "$PROPERTIES_FILE"
  echo "  Eigenschaften gespeichert: $PROPERTIES_FILE"
else
  echo "==> Verwende vorhandenen Android Signing-Key: $KEYSTORE_FILE"
fi

# 3. Versionsnummer synchronisieren (und beim Beenden zurücksetzen, falls nicht aus deploy aufgerufen)
if [ -z "${BUILD_TARGETS:-}" ]; then
  cleanup() {
    node "$SCRIPT_DIR/sync-version.mjs" --restore >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
fi

echo "==> Synchronisiere Version in tauri.conf.json:"
node "$SCRIPT_DIR/sync-version.mjs"

# 4. Android APK bauen
echo "==> Baue Android Release APK:"
npm run tauri -- android build --apk --ci

# 5. Signatur der erstellten APK verifizieren
APK_DIR="$ANDROID_DIR/app/build/outputs/apk/universal/release"
SIGNED_APK="$APK_DIR/app-universal-release.apk"

if [ -f "$SIGNED_APK" ]; then
  echo
  echo "==> Signierte APK erfolgreich gebaut:"
  echo "  Datei: $SIGNED_APK"

  # Signaturprüfung mit apksigner falls vorhanden
  APKSIGNER="$(find "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools" -name "apksigner" 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$APKSIGNER" ] && [ -x "$APKSIGNER" ]; then
    echo "==> Verifiziere APK-Signatur mit apksigner:"
    "$APKSIGNER" verify --verbose "$SIGNED_APK"
  fi
else
  echo "Warnung: Signierte APK unter $SIGNED_APK nicht gefunden." >&2
fi
