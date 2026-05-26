#!/usr/bin/env bash
# Deep Desk — Release script
#
# Build & upload:
#   bash release.sh patch     # 1.0.1 → 1.0.2, upload versioned files
#   bash release.sh minor     # 1.0.1 → 1.1.0
#   bash release.sh           # rebuild current version (no bump)
#
# Promote to stable:
#   bash release.sh --promote # mark current version as latest (user-facing)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDN_BASE="oss://ccb-store/deepdesk"
VERSION_FILE="$SCRIPT_DIR/VERSION"
STABLE_FILE="$SCRIPT_DIR/STABLE_VERSION"

# ── Promote mode ───────────────────────────────────────────────────────────

if [ "${1:-}" = "--promote" ]; then
  CURRENT=$(cat "$VERSION_FILE")
  echo "$CURRENT" > "$STABLE_FILE"

  # Find the Tauri-built DMG
  DMG_DIR="$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
  DMG=$(ls "$DMG_DIR"/Deep\ Desk_*.dmg 2>/dev/null | head -1 || echo "")
  if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
    echo "Error: DMG not found in $DMG_DIR. Build first: bash build.sh"
    exit 1
  fi
  # Copy to project root with expected name
  cp "$DMG" "$SCRIPT_DIR/Deep-Desk-${CURRENT}.dmg"
  DMG="$SCRIPT_DIR/Deep-Desk-${CURRENT}.dmg"
  echo "  DMG: $DMG ($(du -sh "$DMG" | cut -f1))"

  # Windows: skip for now (Tauri MSI requires cross-compilation)
  echo "Windows build skipped (Tauri MSI requires Windows host)"
  ZIP=""

  echo "Promoting v$CURRENT to stable..."

  ossutil cp "$DMG" "$CDN_BASE/Deep-Desk-latest.dmg" -f | tail -1
  if [ -n "$ZIP" ] && [ -f "$ZIP" ]; then
    ossutil cp "$ZIP" "$CDN_BASE/Deep-Desk-setup.zip" -f | tail -1
  else
    echo "  (Windows package not available — skipping)"
  fi

  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║  v$CURRENT is now STABLE             ║"
  echo "║  Users can download at shieldyh.com  ║"
  echo "╚══════════════════════════════════════╝"

  # Update version manifest for auto-update
  echo "{\"version\":\"$CURRENT\",\"macUrl\":\"https://ccb-store.oss-cn-hangzhou.aliyuncs.com/deepdesk/Deep-Desk-latest.dmg\",\"winUrl\":\"\"}" > "$SCRIPT_DIR/version.json"
  ossutil cp "$SCRIPT_DIR/version.json" "$CDN_BASE/version.json" -f | tail -1
  echo "  ✓ version.json updated"
  exit 0
fi

# ── Version bump ──────────────────────────────────────────────────────────

CURRENT=$(cat "$VERSION_FILE")
STABLE=$(cat "$STABLE_FILE" 2>/dev/null || echo "none")
BUMP="${1:-none}"

if [ "$BUMP" != "none" ]; then
  IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
  case "$BUMP" in
    major) MAJ=$((MAJ+1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN+1)); PAT=0 ;;
    patch) PAT=$((PAT+1)) ;;
    *) echo "Usage: bash release.sh [patch|minor|major|--promote]"; exit 1 ;;
  esac
  NEW="$MAJ.$MIN.$PAT"
  echo "$NEW" > "$VERSION_FILE"
  echo "Version: $CURRENT → $NEW (stable: $STABLE)"
else
  NEW="$CURRENT"
  echo "Version: $NEW (no bump, stable: $STABLE)"
fi

echo ""

# ── Step 1: Build macOS DMG ──────────────────────────────────────────────

echo "[1/3] Building macOS DMG (Tauri)..."
bash "$SCRIPT_DIR/build.sh" macos
DMG_DIR="$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
DMG=$(ls "$DMG_DIR"/Deep\ Desk_*.dmg 2>/dev/null | head -1 || echo "")
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "  Error: DMG not found in $DMG_DIR"
  exit 1
fi
# Copy to project root for release workflow compatibility
cp "$DMG" "$SCRIPT_DIR/Deep-Desk-${NEW}.dmg"
DMG="$SCRIPT_DIR/Deep-Desk-${NEW}.dmg"
echo "  ✓ DMG: $DMG ($(du -sh "$DMG" | cut -f1))"

# ── Step 2: Build Windows zip ────────────────────────────────────────────

echo "[2/3] Building Windows package..."
WIN_DIR="/tmp/deepdesk-release/DeepDesk"
rm -rf "/tmp/deepdesk-release"
mkdir -p "$WIN_DIR/server/src" "$WIN_DIR/web/dist" "$WIN_DIR/node_modules"
cp "$SCRIPT_DIR/server/src/"*.ts "$WIN_DIR/server/src/"
cp -r "$SCRIPT_DIR/web/dist/"* "$WIN_DIR/web/dist/"
cp "$SCRIPT_DIR/package.json" "$WIN_DIR/"
# Windows launcher removed (now uses Tauri MSI installer)
cp -r "$SCRIPT_DIR/node_modules/ws" "$WIN_DIR/node_modules/"
cp -r "$SCRIPT_DIR/node_modules/strip-ansi" "$WIN_DIR/node_modules/"

ZIP="/tmp/Deep-Desk-setup-${NEW}.zip"
cd "/tmp/deepdesk-release" && zip -rq "$ZIP" DeepDesk
echo "  ✓ Windows: $ZIP ($(du -sh "$ZIP" | cut -f1))"

# ── Step 3: Upload versioned files (NOT latest) ──────────────────────────

echo "[3/3] Uploading versioned files..."
ossutil cp "$DMG" "$CDN_BASE/Deep-Desk-${NEW}.dmg" | tail -1
ossutil cp "$ZIP" "$CDN_BASE/Deep-Desk-setup-${NEW}.zip" | tail -1
# Update version manifest for auto-update
echo "{\"version\":\"$NEW\",\"macUrl\":\"https://ccb-store.oss-cn-hangzhou.aliyuncs.com/deepdesk/Deep-Desk-latest.dmg\",\"winUrl\":\"https://ccb-store.oss-cn-hangzhou.aliyuncs.com/deepdesk/Deep-Desk-setup.zip\"}" > "$SCRIPT_DIR/version.json"
ossutil cp "$SCRIPT_DIR/version.json" "$CDN_BASE/version.json" -f | tail -1
echo "  ✓ Uploaded (versioned only — NOT promoted to latest)"

# ── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Build v$NEW complete                 ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Versioned files (internal):"
echo "    $CDN_BASE/Deep-Desk-${NEW}.dmg"
echo "    $CDN_BASE/Deep-Desk-setup-${NEW}.zip"
echo ""
echo "  Current stable (user-facing): $STABLE"
echo ""
if [ "$NEW" != "$STABLE" ]; then
  echo "  ⚠️  NOT yet promoted. Test first, then:"
  echo "     bash release.sh --promote"
else
  echo "  ✅ This is the current stable version"
fi
echo ""
echo "  After promoting:"
echo "    1. Update CHANGELOG.md"
echo "    2. git add -A && git commit -m 'release: v$NEW'"
echo "    3. git tag v$NEW"
