#!/bin/bash
# Build Rouleur.app (native macOS WKWebView shell) and a downloadable zip.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$(dirname "$DIR")"          # gpx-cycling-builder/
APP="$DIR/Rouleur.app"

echo "→ Cleaning…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

echo "→ Compiling main.swift…"
swiftc -O -o "$APP/Contents/MacOS/Rouleur" "$DIR/main.swift" -framework Cocoa -framework WebKit

echo "→ Writing Info.plist…"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Rouleur</string>
  <key>CFBundleDisplayName</key><string>Rouleur</string>
  <key>CFBundleIdentifier</key><string>com.rouleur.app</string>
  <key>CFBundleExecutable</key><string>Rouleur</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>Rouleur.icns</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST

echo "→ Adding app icon…"
cp "$DIR/icon_src/Rouleur.icns" "$APP/Contents/Resources/Rouleur.icns"

echo "→ Bundling web app…"
cp "$SRC/index.html" "$SRC/style.css" "$SRC/app.js" "$APP/Contents/Resources/web/"
cp "$DIR/icon_src/icon_1024.png" "$APP/Contents/Resources/web/icon.png"

echo "→ Ad-hoc codesigning…"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (codesign skipped)"

echo "→ Zipping…"
( cd "$DIR" && rm -f Rouleur-mac.zip && zip -r -q Rouleur-mac.zip Rouleur.app )

echo "✓ Built $APP"
echo "✓ Zip   $DIR/Rouleur-mac.zip"
