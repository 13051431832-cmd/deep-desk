# Deep Desk Build & Distribution

## Build Targets

```bash
bash build.sh macos          # macOS arm64 DMG (bun runtime, direct distribution)
bash build.sh macos-x64      # macOS x64 DMG
bash build.sh macos-free     # macOS arm64 DMG, free edition (no bundled plugins)
bash build.sh macos-appstore # macOS arm64 .pkg for App Store submission (Node.js runtime)
bash build.sh all            # macOS arm64 DMG (summary)
```

## App Store Build (`macos-appstore`)

### 与普通构建的关键区别

| | DMG 构建 (macos) | App Store 构建 (macos-appstore) |
|---|---|---|
| Runtime | bun | Node.js |
| 原因 | bun 链接 libicucore（Apple 私有 API） | Node.js 无私有 API 依赖，App Store 合规 |
| Server | TypeScript 运行时编译 | 预编译为 JavaScript（`bun build`） |
| 签名证书 | Developer ID Application | Apple Distribution + 3rd Party Mac Developer Installer |
| 权限文件 | `entitlements.plist` | `entitlements.appstore.plist` |
| 产物 | `.dmg` + `.app.tar.gz`(updater) | `.pkg` |
| 子二进制签名 | ad-hoc / Developer ID | 独立 sandbox-only（无 application-identifier） |

### 常见错误

#### 1. Validation failed (409) — App sandbox not enabled

**错误信息**：
```
Validation failed (409)
App sandbox not enabled. The following executables must include the 
"com.apple.security.app-sandbox" entitlement:
com.deepdesk.app.pkg/Payload/Deep Desk.app/Contents/Resources/binaries/bun-darwin-aarch64/bun
```

**根因**：用 `bash build.sh macos`（DMG 构建）的产物提交到 App Store。DMG 构建包含 bun 二进制，bun 链接了 libicucore（Apple 私有 API），且未签署 sandbox entitlement。

**解决方案**：使用 `bash build.sh macos-appstore` 构建。该目标自动：
1. 用 Node.js 替换 bun
2. 预编译 TypeScript → JavaScript
3. 使用 `entitlements.appstore.plist` 签署所有二进制文件
4. 生成合规的 `.pkg`

#### 2. Private API 拒绝（libicucore）

bun 运行时链接 `/usr/lib/libicucore.dylib`，这是 Apple 未公开的库。App Store 扫描会拒绝任何链接私有 API 的二进制文件。Node.js 不受此影响。

#### 3. 签名注意事项

App Store 构建的签名分两步：
1. **子二进制（node）**：只签 `app-sandbox` + `unsigned-executable-memory` + `disable-library-validation`，不包含 `application-identifier`
2. **主二进制 + .app**：合并 provisioning profile 的 entitlements（含 `application-identifier`）+ 自定义 entitlements

不能对 .app 使用 `--deep` 签名，否则会重新签署 node 并带上 `application-identifier`，触发 Apple 错误 90885。

### 必需环境变量

| 变量 | 用途 |
|------|------|
| `APPLE_SIGNING_IDENTITY` | 签名证书名称（自动检测） |
| `APPLE_INSTALLER_IDENTITY` | .pkg 签名证书（自动检测） |
| `APP_STORE_PROFILE_PATH` | Provisioning profile 路径 |
| `APP_STORE_SHARED_SECRET` | IAP 收据验证（可选） |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID（验证用） |
| `APPLE_API_ISSUER` | App Store Connect API Issuer（验证用） |
