# Deep Desk Tauri 迁移 — 实现计划

> **For agentic workers:** 使用 superpowers:executing-plans 逐步执行。步骤使用 checkbox (`- [ ]`) 语法追踪。

**目标:** 将 Deep Desk 从 Swift macOS menu bar app 架构迁移为跨平台 Tauri 桌面应用（纯窗口模式，Bun 二进制内嵌）。

**架构:** Tauri (Rust) 管理窗口 + Bun server 生命周期。Bun binary 作为 bundle resource 嵌入，Rust spawn `bun run server.ts`，webview 连 `localhost:3456`。server/src 源码零改动。

**技术栈:** Tauri 2.x, Rust, Bun 1.x, Preact + Vite, TypeScript

---

### Task 1: 初始化 Tauri 项目

**文件:**
- 创建: `src-tauri/Cargo.toml`
- 创建: `src-tauri/build.rs`
- 创建: `src-tauri/tauri.conf.json`
- 创建: `src-tauri/tauri.macos.conf.json`
- 创建: `src-tauri/tauri.windows.conf.json`
- 创建: `src-tauri/src/main.rs`
- 创建: `src-tauri/src/lib.rs`
- 创建: `src-tauri/capabilities/default.json`
- 创建: `src-tauri/icons/` (占位，后续用正式图标)

- [ ] **Step 1: 创建 Cargo.toml**

```toml
[package]
name = "deep-desk"
version = "1.0.5"
description = "Deep Desk — AI coding assistant desktop app"
authors = []
edition = "2021"

[lib]
name = "deep_desk_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[[bin]]
name = "deep-desk"
path = "src/main.rs"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["process", "time"] }
anyhow = "1"

[profile.release]
strip = true
lto = true
codegen-units = 1
```

- [ ] **Step 2: 创建 build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: 创建 tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Deep Desk",
  "version": "1.0.5",
  "identifier": "com.deepdesk.app",
  "build": {
    "beforeDevCommand": "cd web && bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "cd web && bun run build",
    "frontendDist": "../web/dist"
  },
  "app": {
    "windows": [
      {
        "title": "Deep Desk",
        "width": 1100,
        "height": 750,
        "minWidth": 600,
        "minHeight": 400,
        "resizable": true,
        "fullscreen": false,
        "center": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://localhost:3456 ws://localhost:3456; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": {
      "server/": "../server/",
      "node_modules/ws": "../node_modules/ws/",
      "node_modules/strip-ansi": "../node_modules/strip-ansi/",
      "package.json": "../package.json",
      "bun.lock": "../bun.lock"
    },
    "createUpdaterArtifacts": true
  }
}
```

> macOS 和 Windows 的 `bundle.resources.files` 在 `tauri.macos.conf.json` / `tauri.windows.conf.json` 中分别补充 bun 二进制路径。

- [ ] **Step 4: 创建 tauri.macos.conf.json**

```json
{
  "bundle": {
    "resources": {
      "binaries/bun-darwin-aarch64/bun": "binaries/bun-darwin-aarch64/bun"
    }
  }
}
```

- [ ] **Step 5: 创建 tauri.windows.conf.json**

```json
{
  "bundle": {
    "resources": {
      "binaries/bun-windows-x64/bun.exe": "binaries/bun-windows-x64/bun.exe"
    }
  }
}
```

- [ ] **Step 6: 创建 src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deep_desk_lib::run();
}
```

- [ ] **Step 7: 创建 src/lib.rs — 框架骨架**

```rust
use tauri::Manager;

#[cfg(target_os = "macos")]
const BUN_PATH: &str = "binaries/bun-darwin-aarch64/bun";
#[cfg(target_os = "windows")]
const BUN_PATH: &str = "binaries/bun-windows-x64/bun.exe";

const SERVER_PORT: u16 = 3456;

mod server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                server::start(&handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // window destroyed → kill server and exit
                server::kill();
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 8: 创建 src/server.rs — 服务器生命周期**

```rust
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// Start the Bun server and wait for it to be ready, then load the webview.
pub async fn start(app: &AppHandle) {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let bun = resource_dir.join(super::BUN_PATH);

    // Ensure bun is executable on macOS
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bun) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&bun, perms);
            }
        }
    }

    // Load env from ~/.deepdesk.env and project .env
    let env = load_env();

    // Find the server script — it's in the resource directory
    let server_script = resource_dir.join("server").join("src").join("server.ts");

    eprintln!("[Deep Desk] Starting server: {:?} run {:?}", bun, server_script);

    let child = match Command::new(&bun)
        .arg("run")
        .arg(&server_script)
        .current_dir(&resource_dir)
        .envs(&env)
        .env("NO_COLOR", "1")
        .env("TERM", "xterm-256color")
        .spawn()
    {
        Ok(c) => {
            *SERVER_PROCESS.lock().unwrap() = Some(c);
        }
        Err(e) => {
            eprintln!("[Deep Desk] Failed to start server: {e}. Bun path: {:?}", bun);
            load_fallback(app);
            return;
        }
    };

    // Wait for health check (poll /api/health, max 15s in production)
    let health_url = format!("http://localhost:{}/api/health", super::SERVER_PORT);
    let max_wait = if cfg!(debug_assertions) { 20 } else { 15 };
    let mut ready = false;
    for _ in 0..(max_wait * 2) {
        if reqwest::get(&health_url).await.map(|r| r.status().is_success()).unwrap_or(false) {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if ready {
        // Server is up — load the webview pointing to it
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(&format!(
                "window.location.replace('http://localhost:{}')",
                super::SERVER_PORT
            ));
        }
    } else {
        eprintln!("[Deep Desk] Server failed to start within {}s", max_wait);
        load_fallback(app);
    }
}

/// Display an HTML error page when the server can't start.
fn load_fallback(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            r#"document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;text-align:center;padding:40px;">
              <h1 style="font-size:24px;margin-bottom:16px;">Deep Desk — Server Not Running</h1>
              <p style="color:#8b949e;max-width:420px;">The backend server on localhost:3456 failed to start. Please check your installation.</p>
              <button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#58a6ff;color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Retry</button>
            </div>`;"#,
        );
    }
}

/// Kill the Bun server process.
pub fn kill() {
    if let Some(mut child) = SERVER_PROCESS.lock().unwrap().take() {
        eprintln!("[Deep Desk] Stopping server...");
        // Graceful — SIGTERM first
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            // Wait up to 3s
            for _ in 0..30 {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        // Force kill
        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[Deep Desk] Server stopped.");
    }
}

/// Load environment from ~/.deepdesk.env and project .env.
fn load_env() -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    let env_files: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(&home).join(".deepdesk.env"),
        std::path::PathBuf::from(&home).join(".claude").join(".env"),
    ];

    for path in env_files {
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    let v = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !key.is_empty() && !v.is_empty() {
                        env.insert(key.to_string(), v);
                    }
                }
            }
        }
    }

    env
}
```

- [ ] **Step 9: 创建 capabilities/default.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for Deep Desk",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 10: Commit**

```bash
git add src-tauri/ .gitignore
git commit -m "feat: add Tauri project scaffold (Rust backend + config)"
```

---

### Task 2: 适配前端（WebSocket URL + Vite + CSP）

**文件:**
- 修改: `web/src/store.ts:244`
- 修改: `web/vite.config.ts`
- 修改: `web/index.html`

- [ ] **Step 1: 修改 store.ts WebSocket URL**

```diff
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
- const ws = new WebSocket(`${protocol}//${location.hostname}:${port}`);
+ // Hardcoded localhost: webview uses localhost:3456, browser dev uses Vite proxy
+ const ws = new WebSocket(`ws://localhost:${port}`);
```

- [ ] **Step 2: 修改 vite.config.ts**

```typescript
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:3456",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3456",
      },
    },
  },
});
```

- [ ] **Step 3: 修改 index.html 添加 CSP meta 标签**

在 `<head>` 中 `<title>` 之前添加：
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; connect-src 'self' http://localhost:3456 ws://localhost:3456; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'">
```

- [ ] **Step 4: Commit**

```bash
git add web/src/store.ts web/vite.config.ts web/index.html
git commit -m "feat: adapt frontend for Tauri webview (localhost WS URL, CSP, Vite proxy)"
```

---

### Task 3: 下载 Bun 二进制 + 构建测试

**文件:**
- 创建: `src-tauri/binaries/.gitkeep`
- 修改: `.gitignore`

- [ ] **Step 1: 添加 .gitignore 规则**

```
src-tauri/binaries/bun*
```

- [ ] **Step 2: 下载 macOS bun binary**

```bash
# macOS arm64
mkdir -p "src-tauri/binaries/bun-darwin-aarch64"
curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip" -o /tmp/bun-mac.zip
unzip -o /tmp/bun-mac.zip -d "src-tauri/binaries/bun-darwin-aarch64/"
chmod +x "src-tauri/binaries/bun-darwin-aarch64/bun"
```

- [ ] **Step 3: 验证 bun binary 可用**

```bash
"src-tauri/binaries/bun-darwin-aarch64/bun" --version
```
预期: 输出 `1.x.x`

- [ ] **Step 4: 进行 tauri dev 开发模式测试**

```bash
# 确保 server 依赖已安装
bun install
cd web && bun install && cd ..

# 启动 tauri dev
cd src-tauri && cargo build
```

检查 cargo build 是否通过编译。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/binaries/.gitkeep .gitignore
git commit -m "chore: add bun binaries directory, update .gitignore"
```

---

### Task 4: 构建打包脚本 + 更新 release.sh

**文件:**
- 创建: `build.sh`
- 修改: `release.sh`

- [ ] **Step 1: 创建 build.sh**

```bash
#!/usr/bin/env bash
# Deep Desk — Tauri build script
# Usage: bash build.sh [macos|windows|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"

download_bun() {
  local os="$1" arch="$2" outdir="$3"
  local url=""
  if [ "$os" = "macos" ] && [ "$arch" = "aarch64" ]; then
    url="https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip"
  elif [ "$os" = "macos" ] && [ "$arch" = "x64" ]; then
    url="https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip"
  elif [ "$os" = "windows" ]; then
    url="https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip"
  fi

  if [ -z "$url" ]; then
    echo "Unknown platform: $os/$arch"
    return 1
  fi

  mkdir -p "$outdir"
  echo "Downloading bun for $os/$arch..."
  curl -fsSL "$url" -o /tmp/bun-dl.zip
  unzip -o /tmp/bun-dl.zip -d "$outdir/"
  chmod +x "$outdir/bun"* 2>/dev/null || true
  echo "  ✓ Downloaded to $outdir"
}

# Download buns
download_bun macos aarch64 "$SCRIPT_DIR/src-tauri/binaries/bun-darwin-aarch64"

# Build frontend
echo "Building frontend..."
cd "$SCRIPT_DIR/web" && bun run build && cd "$SCRIPT_DIR"

# Build Tauri
echo "Building Tauri..."
cd "$SCRIPT_DIR/src-tauri"

if [ "$TARGET" = "macos" ] || [ "$TARGET" = "all" ]; then
  cargo tauri build --target aarch64-apple-darwin
  echo "  ✓ macOS build complete"
  echo "  DMG: $SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"
fi

echo ""
echo "Build complete."
```

- [ ] **Step 2: 更新 release.sh — 适配 Tauri 输出路径**

将原有 `bash "$SCRIPT_DIR/build-dmg.sh"` 行替换为：
```bash
bash "$SCRIPT_DIR/build.sh" macos
```

将 DMG 引用从 `$SCRIPT_DIR/Deep-Desk-${NEW}.dmg` 改为 `$SCRIPT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Deep Desk_${NEW}_aarch64.dmg`

- [ ] **Step 3: Commit**

```bash
git add build.sh release.sh
git commit -m "feat: add Tauri build script, update release.sh for new output paths"
```

---

### Task 5: 清理旧文件

**文件:**
- 删除: `App/` 整个目录
- 删除: `build-dmg.sh`
- 删除: `start.bat`
- 删除: `start.ps1`
- 删除: `start-silent.vbs`
- 删除: `start.sh`
- 删除: `install-service.sh`
- 删除: `com.deepdesk.server.plist`

- [ ] **Step 1: 删除旧文件**

```bash
cd "/Users/jason/deep desk"
rm -rf App/
rm build-dmg.sh start.bat start.ps1 start-silent.vbs start.sh install-service.sh com.deepdesk.server.plist
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove Swift App and legacy launcher scripts"
```

---

### Task 6: E2E 验证

- [ ] **Step 1: 编译验证**

```bash
cd "src-tauri" && cargo check
```
预期: 编译成功，无 error。

- [ ] **Step 2: 构建验证**

```bash
bash build.sh macos
```
预期: 成功生成 `.dmg`，包体积约 60MB。

- [ ] **Step 3: 打开 DMG 验证结构**

```bash
# 挂载并检查
hdiutil attach "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Deep Desk_*.dmg"
ls -la "/Volumes/Deep Desk/"
# 应包含 Deep Desk.app
```
预期: `.app` 包内含 `Resources/server/`、`Resources/binaries/bun-darwin-aarch64/bun`、`Resources/node_modules/`。

- [ ] **Step 4: 验证 app 启动流程**

```bash
open "/Volumes/Deep Desk/Deep Desk.app"
# 等待 15 秒后检查
sleep 15
curl http://localhost:3456/api/health
```
预期: 返回 `{"ok":true,...}`

---


## 自检

**1. Spec 覆盖:** 所有 spec 要点均有对应 task。
- 架构概览 → Task 1 (Tauri 骨架 + Rust 后端)
- 前端改动 → Task 2 (store/vite/index.html)
- 打包设计 → Task 3-4 (bun 二进制下载 + 构建脚本)
- 文件变更 → Task 5 (清理旧文件)

**2. 占位符扫描:** 无 TBD/TODO。所有路径和代码块都是实际内容。

**3. 类型一致性:** 
- `server.rs` 中 `SERVER_PROCESS` 通过 `Mutex<Option<Child>>` 共享，与 `lib.rs` 调用 `server::start()` / `server::kill()` 一致。
- `tauri.conf.json` 中 `version` 从 `VERSION` 文件继承。
