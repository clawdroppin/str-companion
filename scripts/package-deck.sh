#!/usr/bin/env bash
# Builds dist/STR-Companion-SteamDeck.tar.gz from the AppImage electron-builder made.
# The tarball keeps the executable bit, which a plain browser download of an AppImage loses.
set -euo pipefail
cd "$(dirname "$0")/.."
appimage="$(ls dist/STR-Companion-*-linux-x86_64.AppImage | head -1)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/STR-Companion"
install -m 755 "$appimage" "$stage/STR-Companion/STR-Companion.AppImage"
install -m 644 build/icon.png "$stage/STR-Companion/str-companion.png"
cat > "$stage/STR-Companion/README.txt" <<'EOF'
STR Companion for Steam Deck
============================

Easiest: in Desktop Mode, open Konsole and run
  curl -fsSL https://github.com/clawdroppin/str-companion/releases/latest/download/install-steamdeck.sh | bash

By hand:
1. Switch to Desktop Mode (Steam button > Power > Switch to Desktop).
2. Extract this archive anywhere (right-click > Extract > Extract archive here).
3. Double-click "STR-Companion.AppImage". If nothing happens: right-click it >
   Properties > Permissions > tick "Is executable".
4. In the app, open "Steam & Deck": press "Set up Play button" and "Add to Steam".
5. Return to Gaming Mode and press Play on Skyrim Special Edition to start co-op.
EOF
tar --owner=1000 --group=1000 -czf dist/STR-Companion-SteamDeck.tar.gz -C "$stage" STR-Companion
ls -la dist/STR-Companion-SteamDeck.tar.gz
