import { signal } from "@preact/signals";

export type Lang = "zh" | "en";

const STORAGE_KEY = "deepdesk-lang";

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {}
  return "zh";
}

export const lang = signal<Lang>(detectLang());

export function setLang(l: Lang) {
  lang.value = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch {}
}

export function toggleLang() {
  setLang(lang.value === "zh" ? "en" : "zh");
}

// ── Translation map ──────────────────────────────────────────────────

const translations: Record<string, Record<Lang, string>> = {
  // App
  "app.title":             { zh: "Deep Desk", en: "Deep Desk" },
  "app.subtitle":          { zh: "AI 编程助手，用自然语言完成任务", en: "AI coding assistant — accomplish tasks in natural language" },

  // Tabs
  "tab.newChat":           { zh: "新对话", en: "New Chat" },
  "tab.placeholder":       { zh: "项目名称...", en: "Project name..." },
  "tab.untitled":          { zh: "未命名", en: "Untitled" },

  // Status
  "status.ready":          { zh: "就绪", en: "Ready" },
  "status.connecting":     { zh: "连接中...", en: "Connecting..." },
  "status.thinking":       { zh: "思考中...", en: "Thinking..." },
  "status.streaming":      { zh: "回复中...", en: "Streaming..." },
  "status.reconnecting":   { zh: "重连中...", en: "Reconnecting..." },
  "status.connectionLost": { zh: "连接断开 — 刷新重试", en: "Connection lost — refresh to retry" },
  "status.restored":       { zh: "已恢复", en: "Restored" },
  "status.permissionReq":  { zh: "需要授权", en: "Permission required" },

  // Agent
  "agent.off":             { zh: "关闭", en: "OFF" },
  "agent.on":              { zh: "开启", en: "ON" },
  "agent.warming":         { zh: "预热中 (~25s)...", en: "Warming up (~25s)..." },
  "agent.warmingShort":    { zh: "预热中...", en: "Warming..." },
  "agent.toolsHint":       { zh: "工具、技能、MCP", en: "Tools, Skills, MCP" },
  "agent.readyHint":       { zh: "就绪 — 点击开始", en: "Ready — Start to begin" },
  "agent.starting":        { zh: "⟳ 启动中...", en: "⟳ Starting..." },
  "agent.stop":            { zh: "停止 Agent", en: "Stop Agent" },
  "agent.start":           { zh: "启动 Agent", en: "Start Agent" },
  "agent.enabled":         { zh: "**Agent 模式已开启。** Plan、Agents、Skills 可用。首次预热约 25s。", en: "**Agent Mode enabled.** Plan, Agents, Skills available. First warmup ~25s." },
  "agent.disabled":        { zh: "**Agent 模式已关闭。** 已回到快速模式。", en: "**Agent Mode disabled.** Back to Fast Mode." },

  // Plan
  "plan.label":            { zh: "计划", en: "Plan" },
  "plan.on":               { zh: "**计划模式已开启** — AI 会先制定计划，等你批准后再执行。", en: "**Plan Mode ON** — AI will create a plan and wait for your approval before implementing." },
  "plan.off":              { zh: "**计划模式已关闭** — AI 将直接执行。", en: "**Plan Mode OFF** — AI will implement directly." },

  // Bypass
  "bypass.label":          { zh: "跳过", en: "Bypass" },
  "bypass.on":             { zh: "**权限跳过已开启** — 工具权限自动批准。会话重启中...", en: "**Bypass ON** — Tool permissions auto-approved. Session restarting..." },
  "bypass.off":            { zh: "**权限跳过已关闭** — 每次使用工具都需要你批准。", en: "**Bypass OFF** — You'll be asked to approve each tool use." },

  // Input
  "input.placeholderFast": { zh: "输入内容，或 /new /clear /rename — 拖拽文件...", en: "Type, or /new /clear /rename — drag & drop files..." },
  "input.placeholderAgent":{ zh: "Agent 模式 — /new /clear /rename — 拖拽文件、粘贴图片...", en: "Agent mode — /new /clear /rename — drag files, paste images..." },
  "input.placeholderAttach":{ zh: "输入消息或直接发送附件...", en: "Add a message or send with attachments..." },
  "input.send":            { zh: "发送", en: "Send" },
  "input.stop":            { zh: "停止", en: "Stop" },

  // Attachment
  "attach.upload":         { zh: "上传文件（或拖拽）", en: "Upload files (or drag & drop)" },
  "attach.analyzing":      { zh: "⟳ 分析中...", en: "⟳ Analyzing..." },
  "attach.reading":        { zh: "⟳ 读取中...", en: "⟳ Reading..." },
  "attach.ready":          { zh: "✓ 就绪", en: "✓ Ready" },
  "attach.error":          { zh: "错误", en: "Error" },

  // Permission
  "perm.title":            { zh: "需要授权", en: "Permission Required" },
  "perm.approve":          { zh: "✓ 批准", en: "✓ Approve" },
  "perm.deny":             { zh: "✗ 拒绝", en: "✗ Deny" },

  // Commands
  "cmd.agentUsage":        { zh: "**/agent** — 用法：\n- `/agent on` — 开启 Agent 模式\n- `/agent off` — 关闭 Agent 模式", en: "**/agent** — Usage:\n- `/agent on` — Enable Agent Mode\n- `/agent off` — Disable Agent Mode" },
  "cmd.status.title":      { zh: "**系统状态**", en: "**System Status**" },
  "cmd.status.unavail":    { zh: "状态不可用。", en: "Status unavailable." },
  "cmd.help":              { zh: [
    "**命令**", "", "`/new` — 新建对话", "`/clear` — 清空当前对话",
    "`/rename <名称>` — 重命名标签", "`/agent on|off` — 开关 Agent 模式",
    "`/status` — 系统健康检查", "`/help` — 显示此帮助", "",
    "**模式按钮**（输入框下方）", "🤖 Agent — 工具、技能、MCP",
    "📋 Plan — 先计划，批准后执行", "⚡ Bypass — 自动批准工具权限", "",
    "**提示**", "- 粘贴或拖入图片进行分析",
    "- 点击 🤔 Thinking 查看推理过程", "- 双击标签重命名",
    "- 关闭标签页自动保存",
  ].join("\n"), en: [
    "**Commands**", "", "`/new` — New conversation", "`/clear` — Clear current chat",
    "`/rename <name>` — Rename tab", "`/agent on|off` — Toggle Agent Mode",
    "`/status` — System health check", "`/help` — Show this help", "",
    "**Mode Buttons** (below input)", "🤖 Agent — Tools, Skills, MCP",
    "📋 Plan — Plan first, implement after approval", "⚡ Bypass — Auto-approve tool permissions", "",
    "**Tips**", "- Paste or drop images for analysis",
    "- Click 🤔 Thinking to see reasoning", "- Double-click tab to rename",
    "- Tabs auto-save on close",
  ].join("\n") },

  // Messages
  "msg.you":               { zh: "你", en: "You" },
  "msg.claude":            { zh: "Claude", en: "Claude" },
  "msg.thinking":          { zh: "思考中...", en: "Thinking..." },
  "msg.thinkingToggle":    { zh: "🤔 思考过程", en: "🤔 Thinking" },
  "msg.interrupted":       { zh: "[已中断]", en: "[Interrupted]" },
  "msg.sessionStopped":    { zh: "[会话已停止]", en: "[Session stopped]" },

  // Tools
  "tool.completed":        { zh: "已完成", en: "completed" },
  "tool.running":          { zh: "执行中...", en: "running..." },
  "tool.completedCount":   { zh: "✓ {n} 个工具已完成", en: "✓ {n} tool(s) completed" },

  // Errors
  "error.timeout":         { zh: "连接超时，请稍后重试。如果持续出现，请检查网络。", en: "Connection timeout. Please try again later. Check your network if this persists." },
  "error.apiKey":          { zh: "API Key 无效，请在设置中更新。", en: "Invalid API Key. Please update in settings." },
  "error.rateLimit":       { zh: "请求太频繁，请稍等片刻再试。", en: "Too many requests. Please wait a moment." },
  "error.network":         { zh: "无法连接到 AI 服务，请检查网络连接。", en: "Cannot connect to AI service. Check your network." },
  "error.sessionEnded":    { zh: "AI 会话已断开。请刷新页面重新连接。", en: "AI session ended. Please refresh the page to reconnect." },

  // Onboarding cards
  "onboard.analyzeTitle":  { zh: "代码分析", en: "Code Analysis" },
  "onboard.analyzeDesc":   { zh: "帮我分析当前项目结构", en: "Analyze my project structure" },
  "onboard.docTitle":      { zh: "文档写作", en: "Documentation" },
  "onboard.docDesc":       { zh: "帮我写周报、总结本周工作", en: "Write a weekly report" },
  "onboard.debugTitle":    { zh: "Debug 排错", en: "Debugging" },
  "onboard.debugDesc":     { zh: "这段代码有什么问题？如何优化？", en: "What's wrong with this code? How to optimize?" },
  "onboard.searchTitle":   { zh: "联网搜索", en: "Web Search" },
  "onboard.searchDesc":    { zh: "帮我查最新技术资讯", en: "Search latest tech news" },

  // Misc
  "misc.emptyHint":        { zh: "点击上方卡片快速开始，或在输入框输入你的问题", en: "Click a card above to start, or type your question below" },
  "misc.emptyChat":        { zh: "Deep Desk", en: "Deep Desk" },
  "misc.emptyDesc":        { zh: "deepseek驱动的ClaudeY助手", en: "ClaudeY assistant powered by DeepSeek" },
  "misc.upgrade":          { zh: "升级到 Pro", en: "Upgrade to Pro" },
  "misc.update":           { zh: "更新 v{version}", en: "Update v{version}" },
  "misc.reconnecting":     { zh: "⟳ 重连中...", en: "⟳ Reconnecting..." },

  // Language switcher
  "lang.switch":           { zh: "EN", en: "中文" },

  // Settings
  "settings.desc":          { zh: "设置 API Key 后无需在终端配置环境变量。", en: "Set API keys without terminal config." },
  "settings.tabLicense":    { zh: "📜 许可证", en: "📜 License" },

  // License
  "license.placeholder":    { zh: "输入许可证密钥...", en: "Enter license key..." },
  "license.activate":       { zh: "激活 Pro", en: "Activate Pro" },
  "license.activating":     { zh: "激活中...", en: "Activating..." },
  "license.activated":      { zh: "✓ 已激活 Pro", en: "✓ Pro Activated" },
  "license.alreadyPro":     { zh: "✓ 已经是 Pro 版本", en: "✓ Already Pro" },
  "license.error":          { zh: "激活失败", en: "Activation failed" },
  "license.proBadge":       { zh: "Pro 版：MCP x8 + Skills x200+", en: "Pro: MCP x8 + Skills x200+" },
};

// ── Public API ───────────────────────────────────────────────────────

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = translations[key];
  let text = entry?.[lang.value] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
