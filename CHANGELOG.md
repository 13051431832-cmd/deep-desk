# Deep Desk Changelog

## 1.0.2 (2026-05-24)

### Added
- 中文自动回复（`--append-system-prompt` 语言跟随）
- WebSocket 应用层心跳（30s ping/pong）
- Agent Mode 消息队列（proc 未就绪时排队重放）
- Agent 预热倒计时（实时秒数显示）

### Fixed
- ccb 进程退出后 "Session not ready" 错误
- stdin write 到死进程静默失败
- restartCount 不重置导致 3 次后永久不可用
- readLoop 5s 超时误杀 Agent Mode 响应
- Agent Mode 崩溃自动恢复（try/catch + 重试）
- 重复空白 Thinking 气泡

## 1.0.1 (2026-05-24)

### Added
- 新手引导卡片（代码分析/文档/Debug/联网搜索）
- 错误信息小白化（API 错误翻译为中文提示）
- Windows 启动器自动安装 CCB
- DMG 下载按钮 + 三平台分发（macOS DMG / Windows zip / Linux install.sh）
- Agent session 崩溃自动重启（最多 3 次）

### Fixed
- 下载按钮 `onclick="return false"` → 指向真实 DMG
- Send 按钮永久 disabled（Preact signal → useState）
- 用户消息不显示（WebSocket 断开时静默丢弃）
- ccb 崩溃后 thinking 永远闪烁
- 多标签共享同一 session（→ 各自独立新 convId）
- 重连无限循环（→ 5 次后停止）
- 路径遍历漏洞
- 环境变量全量泄漏到 ccb 子进程（→ 白名单过滤）

### Removed
- 4 个未使用的旧 PTY 文件（injector/interpreter/pty/pty-bridge）

## 1.0.0 (2026-05-22)

### Initial release
- Bun WebSocket 服务器 + Preact 前端
- Fast Mode / Agent Mode
- Thinking 实时展开 + 工具折叠
- macOS 菜单栏应用
- shieldyh.com 产品页
