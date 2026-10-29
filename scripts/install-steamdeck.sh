#!/usr/bin/env bash
# STR Companion installer for the Steam Deck (and other Linux PCs).
#   curl -fsSL https://github.com/clawdroppin/str-companion/releases/latest/download/install-steamdeck.sh | bash
# Downloads the latest release, checks its SHA-256, installs to ~/Applications/STR-Companion, adds a
# menu entry and a desktop shortcut, and starts the app. Run it again to update.
# Uninstall: bash install-steamdeck.sh --uninstall
set -euo pipefail

REPO="clawdroppin/str-companion"
BASE="https://github.com/$REPO/releases/latest/download"
PKG="STR-Companion-SteamDeck.tar.gz"
DEST="$HOME/Applications/STR-Companion"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP_FILE="$APPS/str-companion.desktop"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing STR Companion (your game, saves and backups are not touched)…"
  rm -rf "$DEST"
  rm -f "$DESKTOP_FILE" "$HOME/Desktop/str-companion.desktop" "$ICONS/str-companion.png"
  say "Done."
  exit 0
fi

for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing '$tool' — please install it." >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading STR Companion…"
curl -fL --progress-bar "$BASE/$PKG" -o "$tmp/$PKG"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt"

say "Checking the download…"
expected="$(grep " $PKG\$" "$tmp/SHA256SUMS.txt" | cut -d' ' -f1 || true)"
[ -n "$expected" ] || { echo "No checksum for $PKG in the release." >&2; exit 1; }
actual="$(sha256sum "$tmp/$PKG" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || { echo "Checksum mismatch — the download is broken. Nothing was installed." >&2; exit 1; }

say "Installing to $DEST…"
mkdir -p "$DEST" "$APPS" "$ICONS"
tar -xzf "$tmp/$PKG" -C "$tmp"
# Replace only the program files; anything else in the folder stays.
install -m 755 "$tmp/STR-Companion/STR-Companion.AppImage" "$DEST/STR-Companion.AppImage"
install -m 644 "$tmp/STR-Companion/README.txt" "$DEST/README.txt"
install -m 644 "$tmp/STR-Companion/str-companion.png" "$ICONS/str-companion.png"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=STR Companion
Comment=Skyrim Together Reborn co-op companion
Exec="$DEST/STR-Companion.AppImage" %U
Icon=str-companion
Terminal=false
Categories=Game;Utility;
EOF
chmod 644 "$DESKTOP_FILE"
if [ -d "$HOME/Desktop" ]; then
  cp "$DESKTOP_FILE" "$HOME/Desktop/str-companion.desktop"
  chmod 755 "$HOME/Desktop/str-companion.desktop"
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" >/dev/null 2>&1 || true

say "Installed. Starting STR Companion…"
nohup "$DEST/STR-Companion.AppImage" >/dev/null 2>&1 &
say "Next: open 'Steam & Deck' in the app and press 'Set up Play button' and 'Add to Steam'."
