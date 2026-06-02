#!/usr/bin/env bash
# Deep Desk — Tauri build script
# Usage: bash build.sh [macos|macos-x64|windows|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-macos}"

# ── Step 0: Generate platform config ──────────────────────────────────
gen_macos_config() {
  local arch="$1" bun_src="$2"
  cat > "$SCRIPT_DIR/src-tauri/tauri.macos.conf.json" << JSONEOF
{
  "bundle": {
    "resources": {
      "../server/": "server/",
      "../web/dist/": "server/web/dist/",
      "../package.json": "package.json",
      "../bun.lock": "bun.lock",
      "../node_modules/ws/": "node_modules/ws/",
      "../node_modules/strip-ansi/": "node_modules/strip-ansi/",
      "${bun_src}": "${bun_src}"
    }
  }
}
JSONEOF
  echo "  Config: macOS $arch"
}

# ── Step 1: Ensure bun binary is in place ────────────────────────────
ensure_bun() {
  local dir="$1"
  mkdir -p "$SCRIPT_DIR/src-tauri/$dir"
  if [ ! -x "$SCRIPT_DIR/src-tauri/$dir/bun" ] && [ ! -x "$SCRIPT_DIR/src-tauri/$dir/bun.exe" ]; then
    echo "[1/4] Downloading bun binary..."
    local url=""
    case "$dir" in
      binaries/bun-darwin-aarch64) url="https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip" ;;
      binaries/bun-darwin-x64)    url="https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip" ;;
      binaries/bun-windows-x64)   url="https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip" ;;
    esac
    if [ -n "$url" ]; then
      curl -fsSL "$url" -o /tmp/bun-dl.zip 2>/dev/null || {
        # Fallback: copy from local installation
        echo "  Download failed, copying local bun..."
        local local_bun="${HOME}/.bun/bin/bun"
        [ -x "$local_bun" ] || local_bun="$(command -v bun 2>/dev/null || echo '')"
        if [ -n "$local_bun" ] && [ -x "$local_bun" ]; then
          cp "$local_bun" "$SCRIPT_DIR/src-tauri/$dir/bun"
          chmod +x "$SCRIPT_DIR/src-tauri/$dir/bun"
          echo "  ✓ copied local bun"
          return
        fi
        echo "  Error: cannot get bun binary"
        return 1
      }
      unzip -o /tmp/bun-dl.zip -d "$SCRIPT_DIR/src-tauri/$dir/" 2>/dev/null
      chmod +x "$SCRIPT_DIR/src-tauri/$dir/bun"* 2>/dev/null || true
      echo "  ✓ downloaded"
    else
      # Local dev: copy installed bun
      local local_bun="${HOME}/.bun/bin/bun"
      [ -x "$local_bun" ] || local_bun="$(command -v bun 2>/dev/null || echo '')"
      if [ -n "$local_bun" ] && [ -x "$local_bun" ]; then
        cp "$local_bun" "$SCRIPT_DIR/src-tauri/$dir/bun"
        chmod +x "$SCRIPT_DIR/src-tauri/$dir/bun"
        echo "  ✓ copied local bun"
      fi
    fi
  fi
}

# ── Step 2: Build frontend ──────────────────────────────────────────
echo "[2/4] Building frontend..."
cd "$SCRIPT_DIR/web" && bun run build && cd "$SCRIPT_DIR"
echo "  ✓ web/dist ready"

# ── Step 3: Build Tauri ─────────────────────────────────────────────
echo "[3/4] Building Tauri..."

cd "$SCRIPT_DIR/src-tauri"

case "$TARGET" in
  macos)
    ensure_bun "binaries/bun-darwin-aarch64"
    gen_macos_config "aarch64" "binaries/bun-darwin-aarch64/bun"
    # Complete edition: bundle superpowers plugin for offline skills
    PLUGINS_DIR="$SCRIPT_DIR/server/bundled-plugins/claude-plugins-official"
    if [ ! -d "$PLUGINS_DIR" ]; then
      echo "  Cloning skills plugin repo..."
      mkdir -p "$(dirname "$PLUGINS_DIR")"
      git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git "$PLUGINS_DIR" 2>/dev/null || echo "  ⚠️ Failed to clone plugins repo (build will continue without bundled skills)"
    fi
    KEY_PATH="${HOME}/.deepdesk-updater-key"
    if [ -f "$KEY_PATH" ]; then
      export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    fi
    cargo tauri build --target aarch64-apple-darwin 2>&1 | grep -E "(Finished|Error|Bundling|update)" || true
    echo "  ✓ macOS arm64 build complete"
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"*.dmg 2>/dev/null || echo "  (DMG in bundle/dmg/)"
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/"*.tar.gz 2>/dev/null || true
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/"*.sig 2>/dev/null || true
    ;;
  macos-x64)
    ensure_bun "binaries/bun-darwin-x64"
    gen_macos_config "x64" "binaries/bun-darwin-x64/bun"
    # Complete edition: bundle superpowers plugin for offline skills
    PLUGINS_DIR="$SCRIPT_DIR/server/bundled-plugins/claude-plugins-official"
    if [ ! -d "$PLUGINS_DIR" ]; then
      echo "  Cloning skills plugin repo..."
      mkdir -p "$(dirname "$PLUGINS_DIR")"
      git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git "$PLUGINS_DIR" 2>/dev/null || echo "  ⚠️ Failed to clone plugins repo (build will continue without bundled skills)"
    fi
    cargo tauri build --target x86_64-apple-darwin 2>&1 | grep -E "(Finished|Error|Bundling)" || true
    echo "  ✓ macOS x64 build complete"
    ls -lh "$SCRIPT_DIR/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/"*.dmg 2>/dev/null || echo "  (DMG in bundle/dmg/)"
    ;;
  macos-free)
    ensure_bun "binaries/bun-darwin-aarch64"
    gen_macos_config "aarch64" "binaries/bun-darwin-aarch64/bun"
    # Free edition: exclude mcp-defaults.json (downloaded from CDN at runtime)
    MCP_DEFAULTS="$SCRIPT_DIR/server/src/mcp-defaults.json"
    MCP_BAK="$SCRIPT_DIR/server/src/mcp-defaults.json.bak"
    if [ -f "$MCP_DEFAULTS" ]; then
      mv "$MCP_DEFAULTS" "$MCP_BAK"
      trap 'mv "$MCP_BAK" "$MCP_DEFAULTS" 2>/dev/null || true' EXIT
      echo "  Free edition: excluded mcp-defaults.json (will use CDN fallback)"
    fi
    # Free edition: exclude bundled plugins (free edition downloads skills remotely)
    PLUGINS_DIR="$SCRIPT_DIR/server/bundled-plugins"
    if [ -d "$PLUGINS_DIR" ]; then
      rm -rf "$PLUGINS_DIR"
      echo "  Free edition: excluded bundled-plugins (will download on first run)"
    fi
    KEY_PATH="${HOME}/.deepdesk-updater-key"
    if [ -f "$KEY_PATH" ]; then
      export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    fi
    cargo tauri build --target aarch64-apple-darwin 2>&1 | grep -E "(Finished|Error|Bundling|update)" || true
    echo "  ✓ macOS free edition build complete"
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"*.dmg 2>/dev/null || echo "  (DMG in bundle/dmg/)"
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/"*.tar.gz 2>/dev/null || true
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/"*.sig 2>/dev/null || true
    ;;
  windows)
    echo "  Windows build requires cross-compilation or Windows host."
    echo "  Use GitHub Actions: push a v* tag to trigger CI build."
    ;;
  all)
    ensure_bun "binaries/bun-darwin-aarch64"
    gen_macos_config "aarch64" "binaries/bun-darwin-aarch64/bun"
    cargo tauri build --target aarch64-apple-darwin 2>&1 | grep -E "(Finished|Error|Bundling)" || true
    echo "  ✓ macOS arm64"
    ls -lh "$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"*.dmg 2>/dev/null || true
    echo "  macOS x64 + Windows: use GitHub Actions CI"
    ;;
esac

echo "[4/4] Done!"
echo ""
echo "Output:"
ls -lh "$SCRIPT_DIR/src-tauri/target/"*/release/bundle/dmg/*.dmg 2>/dev/null || true
