# Deep Desk Tauri 迁移设计

**日期**: 2026-05-26
**状态**: 已确认

## 目标

将 Deep Desk 从 Swift macOS menu bar app + Bun server + Preact web frontend 架构迁移为 Tauri 桌面客户端，实现跨平台（macOS + Windows）。

## 架构概览

```
┌──────────────────────────────────────────────┐
│                  Tauri App                    │
│                                              │
│  ┌────────────────────┐  ┌────────────────┐  │
│  │   Rust Backend      │  │   Webview      │  │
│  │                    │  │                │  │
│  │  • spawn bun run   │  │  Preact SPA    │  │
│  │    server/server.ts│──│  localhost:3456 │  │
│  │  • health check    │  │  (HTTP + WS)   │  │
│  │  • window mgmt     │  │                │  │
│  │  • env/config load │  │                │  │
│  │  • serve static    │  │                │  │
│  │    fallback        │  │                │  │
│  └────────────────────┘  └────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         Bun Server (child process)      │  │
│  │  • HTTP API: /api/health, /api/convs   │  │
│  │  • WebSocket: chat + agent mode        │  │
│  │  • CCB: spawns claude-code-best         │  │
│  │  • Vision: Qwen VL API                  │  │
│  │  port 3456                              │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## Rust 后端职责

### 1. Bun 二进制管理
- macOS: `bundle.resources/binaries/bun-darwin-aarch64/bun` (arm64) 或 `bun-darwin-x64/bun`
- Windows: `bundle.resources/binaries/bun-windows-x64/bun.exe`
- 通过 `cfg!(target_os)` 条件编译选择路径

### 2. 服务器生命周期
- 启动: spawn bun → 轮询 `GET /api/health` (间隔 500ms, 最多等 10s) → 加载 webview
- 失败: webview 加载内联 HTML 错误页面
- 关闭: SIGTERM → wait 3s → SIGKILL

### 3. 生产 vs 开发模式
- **生产** (tauri build): 前端从 `web/dist/` 加载，但 API 请求由 Bun server on :3456 处理。webview 直接访问 `http://localhost:3456`
- **开发** (tauri dev): Vite 在 :1420 提供 HMR，API 代理到 :3456

### 4. 配置加载
- Rust 端读取 `~/.deepdesk.env` 和项目 `.env`
- 合并后设置到 Bun 子进程的环境变量中

### 5. 静态兜底
- Bun server 起不来时，Tauri 直接 serve 内联 HTML 错误页

## 前端改动

### store.ts — WebSocket URL
```diff
- const protocol = location.protocol === "https:" ? "wss:" : "ws:";
- const ws = new WebSocket(`${protocol}//${location.hostname}:${port}`);
+ const ws = new WebSocket(`ws://localhost:${port}`);
```

### vite.config.ts — Tauri dev 适配
```diff
server: {
+ port: 1420,
+ strictPort: true,
  proxy: {
    "/ws": { target: "ws://localhost:3456", ws: true },
+   "/api": { target: "http://localhost:3456" },
  },
},
```

### index.html — CSP
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; connect-src 'self' http://localhost:3456 ws://localhost:3456; style-src 'self' 'unsafe-inline';">
```

## 打包设计

### 产出
| 平台 | 格式 | 命令 |
|------|------|------|
| macOS | `.dmg` | `tauri build` |
| Windows | `.msi` | `tauri build` |

### Bun 二进制下载
构建脚本在 `tauri build` 前从 GitHub Releases 下载对应平台的 bun binary 到 `src-tauri/binaries/`。

### tauri.conf.json 关键配置
- `bundle.resources`: 包含 `binaries/*`、`server/`、`node_modules/{ws,strip-ansi}/`
- `bundle.targets`: `["dmg", "msi"]`
- `app.security.csp`: 允许 `http://localhost:3456` 和 `ws://localhost:3456`

### 包体积估算
| 组件 | 大小 |
|------|------|
| Bun binary | ~50MB |
| server + node_modules | ~2MB |
| web/dist | ~50KB |
| Tauri 壳 | ~5MB |
| **合计** | **~60MB** |

## 文件变更清单

### 新增
- `src-tauri/` — Rust 后端 + Tauri 配置 (Cargo.toml, tauri.conf.json, src/main.rs, build.rs)
- `src-tauri/binaries/` — 嵌入的 bun 二进制 (.gitignored, 构建时下载)
- `src-tauri/icons/` — 应用图标

### 保留不变
- `server/src/server.ts`
- `server/src/ccb.ts`
- `web/` 全部源码 (小幅修改)
- `package.json` + `bun.lock`
- `release.sh` (小幅适配 Tauri 输出路径)
- `version.json`, `CHANGELOG.md`

### 删除
- `App/` 整个目录 (Swift 源码, Info.plist, icons)
- `build-dmg.sh`
- `start.bat`, `start.ps1`, `start-silent.vbs`, `start.sh`
- `install-service.sh`, `com.deepdesk.server.plist`
