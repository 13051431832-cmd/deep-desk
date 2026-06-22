import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { spawnProcess, spawnSync, type SpawnedProcess, readTextFile } from "./runtime";
import { existsSync, mkdirSync, cpSync, readFileSync } from "fs";

const home = homedir();
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
// Bundled plugins — complete edition ships these in the app bundle
const BUNDLED_PLUGINS = join(MODULE_DIR, "..", "bundled-plugins", "claude-plugins-official");

// Bundled bun binary (falls back to system bun, then bundled node, then system node)
const BUNDLED_BUN = join(MODULE_DIR, "../../binaries",
  process.platform === "win32"
    ? "bun-windows-x64/bun.exe"
    : `bun-darwin-${process.arch === "arm64" ? "aarch64" : "x64"}/bun`);
const BUNDLED_NODE = join(MODULE_DIR, "../../binaries/node-darwin-arm64/node");
const SYSTEM_BUN = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");

// Runtime auto-detection: bundled bun → bundled node → system bun → system node
function detectRuntime(): string {
  if (existsSync(BUNDLED_BUN)) return BUNDLED_BUN;
  if (existsSync(BUNDLED_NODE)) return BUNDLED_NODE;
  if (existsSync(SYSTEM_BUN)) return SYSTEM_BUN;
  // Check PATH for node as last resort
  try {
    const which = spawnSync(process.platform === "win32" ? "where" : "which", ["node"]);
    if (which.exitCode === 0) return "node";
  } catch {}
  return "node"; // Best effort
}
const AVAILABLE_RUNTIME = detectRuntime();
const IS_NODE_RUNTIME = AVAILABLE_RUNTIME === BUNDLED_NODE || AVAILABLE_RUNTIME === "node";

const CCB_SCRIPT = join(home, "node_modules", "claude-code-best", "dist", "cli.js");
const CWD = home;
const LICENSE_FILE = join(home, ".deepdesk", "license.json");
const MCP_CONFIG = join(home, ".claude", "mcp.json");
const IS_MAC = process.platform === "darwin";
const RESOURCE_DIR = process.env.DEEP_DESK_RESOURCES || MODULE_DIR;
const RECEIPT_CACHE = join(home, ".deepdesk", "receipt-cache.json");

// Receipt validation cache (Mac App Store only).
// Populated from disk at module load (sync), refreshed by server.ts via Apple API.
let _receiptPro = false;
let _receiptValidatedAt = 0;

// Restore persistent cache at module load — makes isPro() correct immediately
// on every launch after the first (avoids waiting for async Apple API call).
// Non-consumable IAP is permanent: once purchased, always Pro.
// 30-day revalidation window is generous and handles edge cases like
// receipt corruption or device transfer without penalizing legitimate users.
const RECEIPT_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days

try {
  const raw = readFileSync(RECEIPT_CACHE, "utf-8");
  const cache = JSON.parse(raw);
  if (Date.now() - cache.validatedAt < RECEIPT_MAX_AGE) {
    _receiptPro = cache.pro;
    _receiptValidatedAt = cache.validatedAt;
  }
} catch { /* no cache yet — first launch or Free user */ }

/** Called by server.ts after async App Store receipt validation completes. */
export function setReceiptCache(pro: boolean) {
  _receiptPro = pro;
  _receiptValidatedAt = Date.now();
}

function isPro(): boolean {
  if (IS_MAC) {
    // Mac: validated receipt cache only (no heuristic — avoids false positives).
    if (_receiptValidatedAt > 0 && (Date.now() - _receiptValidatedAt) < RECEIPT_MAX_AGE) {
      return _receiptPro;
    }
    // Cache expired or never populated → not Pro until re-validated.
    return false;
  }
  // Windows / Linux: license key redeem.
  try {
    const raw = readFileSync(LICENSE_FILE, "utf-8");
    return !!JSON.parse(raw).pro;
  } catch {
    return false;
  }
}

// Whitelist of env vars to pass to ccb subprocess (avoid leaking all env)
const CCB_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL",
  "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "OPENAI_MODEL", "OPENAI_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_OPENAI", "QWEN_API_KEY", "DASHSCOPE_API_KEY",
];

// Windows-essential env vars (needed for bun/node to find system DLLs, temp, etc.)
const WIN_ESSENTIAL_ENV = [
  "SystemRoot", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles",
  "COMPUTERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
];

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const isWin = process.platform === "win32";
  for (const key of CCB_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // Windows: preserve essential system env vars (SystemRoot, TEMP, etc.)
  // Without these, bun/node can't find system DLLs and crashes immediately
  if (isWin) {
    for (const key of WIN_ESSENTIAL_ENV) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
  }
  // Override HOME with sandbox-correct path (homedir() returns container path under App Sandbox)
  env.HOME = home;
  env.TERM = env.TERM || "xterm-256color";
  env.NO_COLOR = "1";
  // Ensure common binary paths are in PATH (fixes node/python not found)
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"].filter(p => existsSync(p));
  const existingPath = env.PATH || process.env.PATH || "";
  if (extraPaths.length > 0) {
    const sep = isWin ? ";" : ":";
    if (existingPath) {
      env.PATH = extraPaths.join(sep) + sep + existingPath;
    } else {
      env.PATH = extraPaths.join(sep);
    }
  }
  env.CLAUDE_CODE_USE_OPENAI = "true";
  env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || "https://api.deepseek.com";
  env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic";
  env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || "deepseek-v4-pro";
  env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL || "deepseek-v4-flash";
  env.OPENAI_MODEL = env.OPENAI_MODEL || "deepseek-v4-pro";
  env.OPENAI_SMALL_FAST_MODEL = env.OPENAI_SMALL_FAST_MODEL || "deepseek-v4-flash";
  // Windows: ensure SHELL + PATH include git bash (bundled or system)
  if (isWin) {
    // Bundled MinGit: check usr/bin/bash.exe, cmd/git.exe
    const bundledGit = join(MODULE_DIR, "../../binaries/git");
    const candidateDirs = [
      join(bundledGit, "usr\\bin"),
      join(bundledGit, "cmd"),
      join(bundledGit, "bin"),
      "C:\\Program Files\\Git\\bin",
      "C:\\Program Files\\Git\\usr\\bin",
      "C:\\Program Files (x86)\\Git\\bin",
    ];
    for (const dir of candidateDirs) {
      if (!existsSync(dir)) continue;
      // Look for bash.exe or git.exe in this dir
      const hasBash = existsSync(dir + "\\bash.exe");
      const hasGit = existsSync(dir + "\\git.exe");
      if (!hasBash && !hasGit) continue;
      if (!env.SHELL && hasBash) env.SHELL = dir + "\\bash.exe";
      // Collect all relevant subdirs of this git installation
      const root = dir.replace(/\\usr\\bin$|\\bin$|\\cmd$/, "");
      const parts: string[] = [];
      for (const sub of ["usr\\bin", "cmd", "bin", "mingw64\\bin", "mingw32\\bin"]) {
        if (existsSync(root + "\\" + sub)) parts.push(root + "\\" + sub);
      }
      if (parts.length === 0) parts.push(dir);
      env.PATH = parts.join(";") + ";" + (env.PATH || process.env.PATH || "");
      break;
    }
  }
  return env;
}

// ── Startup diagnostics ──────────────────────────────────────────────────

function diagnose(): string[] {
  const lines: string[] = [];
  const isWin = process.platform === "win32";

  // 1. Runtime binary
  const runtimeLabel = IS_NODE_RUNTIME ? "Node.js" : "Bun";
  const isBareCommand = AVAILABLE_RUNTIME === "node" || AVAILABLE_RUNTIME === "bun";
  lines.push(`Runtime (${runtimeLabel}): ${AVAILABLE_RUNTIME}`);
  if (isBareCommand) {
    lines.push(`  ✅ 存在于 PATH 中（非完整路径）`);
  } else if (!existsSync(AVAILABLE_RUNTIME)) {
    lines.push(`  ❌ NOT FOUND — process cannot start`);
    if (isWin) {
      const bundled = join(MODULE_DIR, "../../binaries", "bun-windows-x64", "bun.exe");
      const system = join(home, ".bun", "bin", "bun.exe");
      lines.push(`  打包路径: ${bundled} (${existsSync(bundled) ? "存在" : "不存在"})`);
      lines.push(`  系统路径: ${system} (${existsSync(system) ? "存在" : "不存在"})`);
    }
  } else {
    lines.push(`  ✅ 存在`);
  }

  // 2. CCB script
  lines.push(`CCB 脚本: ${CCB_SCRIPT}`);
  if (!existsSync(CCB_SCRIPT)) {
    lines.push(`  ❌ NOT FOUND — 将尝试自动安装`);
  } else {
    lines.push(`  ✅ 存在`);
  }

  // 3. Bash (Windows)
  if (isWin) {
    const bash = findBash();
    lines.push(`Bash: ${bash}`);
    if (bash === "bash") {
      lines.push(`  ⚠️ 未找到 bash.exe，将使用字面量 "bash"（可能在 PATH 中找不到）`);
    } else if (existsSync(bash)) {
      lines.push(`  ✅ 存在`);
    } else {
      lines.push(`  ❌ 路径指向的文件不存在`);
    }
  }

  // 4. Node modules
  const nodeModules = join(home, "node_modules");
  lines.push(`node_modules: ${nodeModules}`);
  if (!existsSync(nodeModules)) {
    lines.push(`  ⚠️ 目录不存在，将在安装时创建`);
  } else {
    lines.push(`  ✅ 存在`);
  }

  // 5. Git (Windows)
  if (isWin) {
    const gitDirs = [
      join(MODULE_DIR, "../../binaries/git"),
      "C:\\Program Files\\Git",
      "C:\\Program Files (x86)\\Git",
    ];
    const found = gitDirs.filter(d => existsSync(d));
    lines.push(`Git 目录: ${found.length > 0 ? found.join(", ") : "未找到任何 Git 安装"}`);
  }

  // 6. PATH
  const env = buildEnv();
  lines.push(`PATH 条目数: ${(env.PATH || "").split(isWin ? ";" : ":").length}`);
  lines.push(`SHELL: ${env.SHELL || "(未设置)"}`);

  return lines;
}

function findBash(): string {
  if (process.platform !== "win32") return "bash";
  const bundledGit = join(MODULE_DIR, "../../binaries/git");
  const candidateDirs = [
    join(bundledGit, "usr\\bin"),
    join(bundledGit, "cmd"),
    join(bundledGit, "bin"),
    "C:\\Program Files\\Git\\bin",
    "C:\\Program Files\\Git\\usr\\bin",
    "C:\\Program Files (x86)\\Git\\bin",
  ];
  for (const dir of candidateDirs) {
    const bashExe = dir + "\\bash.exe";
    if (existsSync(bashExe)) return bashExe;
  }
  return "bash";
}

const CONVERSATIONS_DIR = join(home, ".deepdesk", "conversations");

// ── Conversation summarization ─────────────────────────────────────────
// Reads the conversation file and calls DeepSeek to produce a structured
// summary suitable for injecting into a fresh CCB session.

interface ConvMessage {
  role: string;
  content: string;
  thinkingContent?: string;
}

export async function summarizeConversation(convId: string): Promise<string | null> {
  const convPath = join(CONVERSATIONS_DIR, `${convId}.json`);
  let messages: ConvMessage[] = [];
  try {
    const raw = await readTextFile(convPath);
    const data = JSON.parse(raw);
    messages = data.messages || [];
  } catch {
    return null; // No saved conversation yet
  }

  // Take the last 40 user+assistant messages for summarization
  const relevant = messages
    .filter((m: ConvMessage) => m.role === "user" || m.role === "assistant")
    .slice(-40);

  // Fewer than 4 messages — include full text directly, no summarization needed
  if (relevant.length < 4) {
    return relevant
      .map((m: ConvMessage) => {
        const prefix = m.role === "user" ? "用户" : "AI";
        return `${prefix}: ${m.content || ""}`;
      })
      .join("\n\n");
  }

  const transcript = relevant
    .map((m: ConvMessage) => {
      const prefix = m.role === "user" ? "用户" : "AI";
      const text = m.content?.slice(0, 800) || "";
      const thinking = m.thinkingContent
        ? ` [思考过程: ${m.thinkingContent.slice(0, 200)}]`
        : "";
      return `${prefix}: ${text}${thinking}`;
    })
    .join("\n\n");

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
  if (!apiKey) return null;

  const prompt = `你是一个对话摘要助手。请将以下对话压缩成一份简洁的摘要（中文），保留：
1. 用户的核心需求和目标
2. 已完成的关键工作（文件改动、修复的 bug、实现的功能）
3. 当前进行中的任务和下一步计划
4. 重要的决策和技术约定

摘要控制在 500 字以内。只输出摘要，不要添加额外说明。

对话记录：
${transcript}`;

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export type TextCallback = (text: string, isPartial: boolean) => void;
export type PermissionCallback = (id: string, tool: string, message: string) => void;
export type ToolCallback = (tool: string, id: string, status: "start" | "running" | "done", detail?: string) => void;
export type ThinkingCallback = (text: string) => void;
export type DoneCallback = (fullText: string) => void;
export type ErrorCallback = (error: string) => void;

export interface CCBSession {
  sendMessage(text: string): void;
  sendPermission(approved: boolean, answer?: Record<string, string>): void;
  kill(): void;
  onText: TextCallback;
  onPermission: PermissionCallback | null;
  onTool: ToolCallback | null;
  onThinking: ThinkingCallback | null;
  onDone: DoneCallback;
  onError: ErrorCallback;
  pendingPermission: string | null;
  pendingQuestions: any[] | null;
}

// ── Shared NDJSON stream parser ────────────────────────────────────────

interface ParseCallbacks {
  onToolStart?(name: string, id: string): void;
  onToolRunning?(name: string, id: string, detail: string): void;
  onToolDone?(name: string, id: string, detail: string): void;
  onThinking?(text: string): void;
  onText?(text: string, isPartial: boolean): void;
  onDone?(fullText: string): void;
  onAskUserQuestion?(toolId: string, questions: any[]): void;
}

function parseChunk(
  chunk: string, buffer: { val: string },
  fullText: { val: string }, hasStreamed: { val: boolean },
  activeToolId: { val: string }, activeToolName: { val: string },
  toolInputBuf: { val: string },
  cbs: ParseCallbacks,
  askUserQTriggered?: { val: boolean },
) {
  buffer.val += chunk;
  const lines = buffer.val.split("\n");
  buffer.val = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const inner = event.event || event;
      const etype = inner.type || event.type || "";
      const subtype = inner.subtype || event.subtype || "";
      if (subtype === "hook_started" || subtype === "hook_response" ||
          subtype === "init" || etype === "stream_start" || etype === "stream_end") continue;

      if (etype === "content_block_start") {
        const cb = inner.content_block || event.content_block || {};
        // If the previous block was an AskUserQuestion tool_use, its input is now complete
        if (activeToolName.val === "AskUserQuestion" && activeToolId.val && !(askUserQTriggered?.val)) {
          try {
            const parsed = JSON.parse(toolInputBuf.val);
            if (parsed.questions?.length > 0) {
              if (askUserQTriggered) askUserQTriggered.val = true;
              cbs.onAskUserQuestion?.(activeToolId.val, parsed.questions);
            }
          } catch {}
        }
        if (cb.type === "tool_use" && cb.name) {
          activeToolId.val = cb.id || ""; activeToolName.val = cb.name; toolInputBuf.val = "";
          if (askUserQTriggered) askUserQTriggered.val = false;
          cbs.onToolStart?.(cb.name, cb.id);
        }
        continue;
      }
      if (etype === "content_block_delta") {
        const d = inner.delta || event.delta;
        if (d?.type === "input_json_delta" && d.partial_json) {
          toolInputBuf.val += d.partial_json;
          if (activeToolName.val) {
            try { const p = JSON.parse(toolInputBuf.val); const detail = p.command || p.query || p.file_path || p.pattern || ""; if (detail && typeof detail === "string") cbs.onToolRunning?.(activeToolName.val, activeToolId.val, detail); } catch {}
          }
          continue;
        }
      }
      if (etype === "user") {
        const msg = inner.message || event.message || {}; let hasToolResults = false;
        for (const block of (msg.content || [])) {
          if (block?.type === "tool_result") {
            hasToolResults = true;
            const resultText = (typeof block.content === "string" ? block.content : "").slice(0, 100);
            cbs.onToolDone?.(activeToolName.val, activeToolId.val, block.is_error ? "Failed" : resultText || "Done");
          }
        }
        if (hasToolResults) { activeToolId.val = ""; activeToolName.val = ""; continue; }
        continue;
      }

      let delta = "";
      if (etype === "content_block_delta") {
        const d = inner.delta || event.delta;
        if (d?.type === "thinking_delta" && d.thinking) { cbs.onThinking?.(d.thinking); continue; }
        if (d?.type === "text_delta") { delta = d.text || ""; } else if (typeof d?.text === "string") { delta = d.text; }
        if (delta) hasStreamed.val = true;
      }
      if ((etype === "assistant" || etype === "message") && !hasStreamed.val) {
        const content = (inner.message || event.message || {}).content || inner.content || event.content;
        if (Array.isArray(content)) { for (const block of content) { if (block?.type === "text" && block.text) delta = block.text; } }
        else if (typeof content === "string") delta = content;
      }
      if (etype === "system" && !subtype.startsWith("hook_") && subtype !== "init") {
        const sysMsg = inner.message || inner.output || "";
        if (typeof sysMsg === "string" && sysMsg.length > 2) delta = sysMsg; else continue;
      }
      if (etype === "result") {
        if (inner.is_error || inner.subtype === "error_during_execution") fullText.val += "\n" + ((inner.errors || []).join("\n"));
        if (!hasStreamed.val) { const r = inner.result || inner.subtype || ""; if (typeof r === "string") fullText.val += r; }
        if (fullText.val) { cbs.onDone?.(fullText.val); fullText.val = ""; hasStreamed.val = false; }
        continue;
      }
      if (delta) { fullText.val += delta; cbs.onText?.(delta, true); }
    } catch {
      const cleaned = trimmed.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
      if (cleaned) { fullText.val += cleaned + "\n"; cbs.onText?.(cleaned, true); }
    }
  }
  // Fallback: if AskUserQuestion was the last block and stream paused (no next block),
  // trigger the callback here so the frontend can show the question before CCB blocks on stdin
  if (activeToolName.val === "AskUserQuestion" && activeToolId.val && !(askUserQTriggered?.val)) {
    try {
      const parsed = JSON.parse(toolInputBuf.val);
      if (parsed.questions?.length > 0) {
        if (askUserQTriggered) askUserQTriggered.val = true;
        cbs.onAskUserQuestion?.(activeToolId.val, parsed.questions);
      }
    } catch {}
  }
}

// ── Session spawner ───────────────────────────────────────────────────

export function spawnSession(callbacks: {
  onText: TextCallback;
  onPermission?: PermissionCallback;
  onTool?: ToolCallback;
  onThinking?: ThinkingCallback;
  onDone: DoneCallback;
  onError: ErrorCallback;
  onStatus?: (message: string) => void;
  onContextStatus?: (status: "summarizing" | "restarting" | "done") => void;
}, options?: {
  bypassPermissions?: boolean;
  planMode?: boolean;
  convId?: string;
  initialContext?: string;
}): CCBSession {
  const env = buildEnv();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const convId = options?.convId || "";

  // Mutable references — swapped on restart
  let proc: SpawnedProcess;
  let fullText = "";
  let buffer = "";
  let hasStreamedContent = false;
  let pendingPermissionId: string | null = null;
  let activeToolId: string | null = null;
  let activeToolName = "";
  let toolInputBuf = "";
  let restartCount = 0;
  const MAX_RESTARTS = 3;
  let procReady = false;
  const messageQueue: string[] = [];
  let userMessageCount = 0;
  const CONTEXT_THRESHOLD = 15; // Trigger summarization after ~15 user messages
  let summarizationInProgress = false;
  let initialContext = options?.initialContext || "";

  function flushQueue() {
    while (messageQueue.length > 0 && proc && !proc.killed && procReady) {
      const msg = messageQueue.shift()!;
      try { proc.stdinWrite(encoder.encode(msg)); proc.stdinFlush(); }
      catch { messageQueue.unshift(msg); break; }
    }
  }

  // ── Session object ──────────────────────────────────────────────────
  const session: CCBSession = {
    pendingPermission: null,
    pendingQuestions: null,
    onText: callbacks.onText,
    onPermission: callbacks.onPermission || null,
    onTool: callbacks.onTool || null,
    onThinking: callbacks.onThinking || null,
    onDone: callbacks.onDone,
    onError: callbacks.onError,

    sendMessage(text: string) {
      // Inject initial context summary on first message
      let messageText = text;
      if (initialContext && userMessageCount === 0) {
        messageText = `[此前对话摘要 - 请基于此摘要继续工作]\n${initialContext}\n\n---\n以下是用户的新消息:\n${text}`;
        initialContext = ""; // Only inject once
      }

      userMessageCount++;
      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: messageText }] },
      }) + "\n";
      fullText = "";
      hasStreamedContent = false;
      pendingPermissionId = null;
      if (proc && !proc.killed && procReady) {
        try { proc.stdinWrite(encoder.encode(msg)); proc.stdinFlush(); }
        catch { messageQueue.push(msg); }
      } else {
        messageQueue.push(msg);
        callbacks.onText("", true); // trigger "thinking" state in frontend
        // Auto-restart if process died (e.g. after Stop)
        if (!proc || proc.killed) startProc();
      }

      // ── Context threshold check ──────────────────────────────
      if (convId && userMessageCount >= CONTEXT_THRESHOLD && !summarizationInProgress) {
        doSummarizeAndRestart();
      }
    },

    sendPermission(approved: boolean, answer?: Record<string, string>) {
      // If answer data is provided, this is an AskUserQuestion response.
      // Write a tool_result user message to CCB stdin instead of a permission decision.
      if (answer && pendingPermissionId) {
        const answersStr = JSON.stringify(answer);
        const toolResult = JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: pendingPermissionId,
              content: answersStr,
            }],
          },
        }) + "\n";
        pendingPermissionId = null;
        fullText = "";
        hasStreamedContent = false;
        session.pendingQuestions = null;
        if (proc && !proc.killed && procReady) {
          try { proc.stdinWrite(encoder.encode(toolResult)); proc.stdinFlush(); }
          catch { messageQueue.push(toolResult); }
        } else {
          // Process not ready — queue and flush when it comes back
          messageQueue.push(toolResult);
        }
        return;
      }
      const decision = JSON.stringify({
        type: "permission",
        id: pendingPermissionId,
        decision: approved ? "approve" : "deny",
      }) + "\n";
      pendingPermissionId = null;
      fullText = "";
      hasStreamedContent = false;
      session.pendingQuestions = null;
      if (proc && !proc.killed && procReady) {
        try { proc.stdinWrite(encoder.encode(decision)); proc.stdinFlush(); }
        catch { messageQueue.push(decision); }
      } else {
        // Process not ready — queue and flush when it comes back
        messageQueue.push(decision);
      }
    },

    kill() {
      if (!proc) return;
      procReady = false;
      if (process.platform === "win32") {
        try { proc.kill(); } catch {}
      } else {
        try { process.kill(-proc.pid, "SIGTERM"); } catch {}
        try { proc.kill("SIGTERM"); } catch {}
      }
    },
  };

  // ── Context-aware summarization + restart ────────────────────────────

  async function doSummarizeAndRestart() {
    if (summarizationInProgress || !convId) return;
    summarizationInProgress = true;
    callbacks.onContextStatus?.("summarizing");

    const summary = await summarizeConversation(convId);
    if (summary) {
      callbacks.onContextStatus?.("restarting");
      initialContext = summary;
      userMessageCount = 0;
      restartCount = 0;
      restartProc();
    } else {
      // If summarization failed, don't retry for this session
      userMessageCount = 0;
    }
    summarizationInProgress = false;
    callbacks.onContextStatus?.("done");
  }

  function restartProc() {
    procReady = false;
    if (proc) {
      if (process.platform === "win32") {
        try { proc.kill(); } catch {}
      } else {
        try { process.kill(-proc.pid, "SIGTERM"); } catch {}
        try { proc.kill("SIGTERM"); } catch {}
      }
    }
    startProc();
  }

  // ── Start ccb process + wire up readers ──────────────────────────────

  // Auto-install claude-code-best + superpowers if not present
  function ensureCCB(): boolean {
    if (!existsSync(AVAILABLE_RUNTIME)) {
      const diag = diagnose();
      const runtimeName = IS_NODE_RUNTIME ? "Node.js" : "Bun";
      const installUrl = IS_NODE_RUNTIME ? "https://nodejs.org" : "https://bun.sh";
      callbacks.onError(`❌ ${runtimeName} 未找到: ${AVAILABLE_RUNTIME}\n请确保 Deep Desk 安装完整，或手动安装 ${runtimeName}: ${installUrl}\n\n诊断信息:\n${diag.join("\n")}`);
      return false;
    }
    if (!existsSync(CCB_SCRIPT)) {
      callbacks.onStatus?.("Installing AI engine (one-time setup, ~30s)...");
      try {
        mkdirSync(home, { recursive: true });
        // Use npm when running under Node.js, otherwise use bun install
        const installCmd = IS_NODE_RUNTIME ? "npm" : AVAILABLE_RUNTIME;
        const installArgs = IS_NODE_RUNTIME ? ["install", "claude-code-best"] : ["install", "claude-code-best"];
        const result = spawnSync(installCmd, installArgs, {
          cwd: home, env: { ...process.env, HOME: home } as Record<string, string>,
          stdout: "pipe", stderr: "pipe",
        });
        if (result.exitCode !== 0 || !existsSync(CCB_SCRIPT)) {
          const stderr = new TextDecoder().decode(result.stderr).slice(0, 300);
          const stdout = new TextDecoder().decode(result.stdout).slice(0, 300);
          callbacks.onError(`Engine install failed (exit=${result.exitCode})\nstderr: ${stderr || "(empty)"}\nstdout: ${stdout || "(empty)"}`);
          return false;
        }
        callbacks.onStatus?.("Engine installed. Starting...");
      } catch (e: any) {
        callbacks.onError(`Engine install error: ${e.message}`);
        return false;
      }
    }
    // Install superpowers plugin for skills (Pro feature)
    // Pro users: bundled plugins in app resources, or authorized download
    // Free users: no skills — agent works without them
    const pluginCacheDir = join(home, ".claude", "plugins", "cache", "claude-plugins-official");
    if (!existsSync(pluginCacheDir)) {
      if (!isPro()) {
        // Free edition: no skills. Return normally — agent works fine without.
        return true;
      }
      callbacks.onStatus?.("Installing Pro skills (~200 skills, one-time)...");
      try {
        mkdirSync(join(home, ".claude", "plugins", "cache"), { recursive: true });
        if (existsSync(BUNDLED_PLUGINS)) {
          cpSync(BUNDLED_PLUGINS, pluginCacheDir, { recursive: true });
        } else {
          const clone = spawnSync("git", ["clone", "--depth", "1", "https://github.com/anthropics/claude-plugins-official.git", pluginCacheDir], {
            cwd: home, env: { ...process.env, HOME: home } as Record<string, string>,
            stdout: "pipe", stderr: "pipe",
          });
          if (clone.exitCode !== 0) {
            callbacks.onStatus?.("Skills install skipped (network issue). Agent will work without skills.");
            return true;
          }
        }
        callbacks.onStatus?.("Pro skills ready. Starting agent...");
      } catch { callbacks.onStatus?.("Skills install skipped. Starting agent..."); }
    }
    return true;
  }

  function startProc() {
    if (!ensureCCB()) { callbacks.onError("Cannot start: AI engine not available."); return; }
    const bypass = options?.bypassPermissions !== false; // default true for backward compat
    const plan = options?.planMode || false;
    const args: string[] = [
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--input-format", "stream-json",
    ];
    if (bypass) args.push("--dangerously-skip-permissions");
    const sysPrompts: string[] = ["始终使用用户输入的语言回复。用户用中文则用中文，用户用英文则用英文。"];
    if (plan) sysPrompts.push("Before implementing anything, first create a detailed step-by-step plan. Present the plan to the user and wait for explicit approval before writing any code or executing any tools. Do not skip the planning phase.");
    for (const sp of sysPrompts) args.push("--append-system-prompt", sp);
    if (existsSync(MCP_CONFIG)) args.push("--mcp-config", MCP_CONFIG);

    try {
      proc = spawnProcess(AVAILABLE_RUNTIME, [CCB_SCRIPT, ...args], {
        cwd: CWD, env,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
    } catch (err: any) {
      if (restartCount < MAX_RESTARTS) {
        restartCount++;
        callbacks.onError(`Failed to start (${restartCount}/${MAX_RESTARTS}). Retrying...`);
        setTimeout(() => startProc(), 2000);
      } else {
        const diag = diagnose();
        callbacks.onError(`Cannot start AI engine after ${MAX_RESTARTS} attempts.\nError: ${err.message || err}\n\n诊断信息:\n${diag.join("\n")}`);
      }
      return;
    }

    procReady = true;
    flushQueue();

    // Check for immediate crash (common on Windows: missing DLL, wrong arch)
    proc.exited.then((exitCode) => {
      if (procReady && exitCode !== 0 && restartCount < MAX_RESTARTS) {
        procReady = false;
        restartCount++;
        callbacks.onError(`Process exited immediately (code ${exitCode}). Restarting (${restartCount}/${MAX_RESTARTS})...`);
        startProc();
      }
    });

    const bufRef = { val: "" };
    const ftRef = { val: "" };
    const hsRef = { val: false };
    const atiRef = { val: "" };
    const atnRef = { val: "" };
    const tibRef = { val: "" };
    const auqRef = { val: false }; // AskUserQuestion already triggered for this block

    const parseCbs: ParseCallbacks = {
      onToolStart: (name, id) => { if (callbacks.onTool) callbacks.onTool(name, id, "start"); },
      onToolRunning: (name, id, detail) => { if (callbacks.onTool) callbacks.onTool(name, id, "running", detail); },
      onToolDone: (name, id, detail) => { if (callbacks.onTool) callbacks.onTool(name, id, "done", detail); },
      onThinking: (text) => { if (callbacks.onThinking) callbacks.onThinking(text); },
      onText: (text, isPartial) => { if (isPartial && text) callbacks.onText(text, true); },
      onDone: (fullText) => { callbacks.onDone(fullText); },
      onAskUserQuestion: (toolId, questions) => {
        pendingPermissionId = toolId;
        session.pendingPermission = toolId;
        session.pendingQuestions = questions;
        if (bypass) {
          // Auto-answer with empty values so the model can continue
          const autoAnswer: Record<string, string> = {};
          for (const q of questions) {
            autoAnswer[q.question] = "";
          }
          const answersStr = JSON.stringify(autoAnswer);
          const toolResult = JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: toolId,
                content: answersStr,
              }],
            },
          }) + "\n";
          pendingPermissionId = null;
          session.pendingQuestions = null;
          if (proc && !proc.killed && procReady) {
            try { proc.stdinWrite(encoder.encode(toolResult)); proc.stdinFlush(); }
            catch { messageQueue.push(toolResult); }
          }
          return;
        }
        if (callbacks.onPermission) {
          const firstQ = questions[0];
          const summary = questions.length === 1
            ? firstQ.question
            : `${firstQ.question} (+${questions.length - 1} more)`;
          callbacks.onPermission(toolId, "AskUserQuestion", summary);
        }
      },
    };

    async function readLoop() {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parseChunk(decoder.decode(value, { stream: true }), bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs, auqRef);
        }
        if (bufRef.val.trim()) parseChunk("\n", bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs, auqRef);
      } catch {}
    }

    (async () => {
      // Wait for stdout to close OR process to exit (whichever first).
      // If process exits but stdout keeps streaming, use a 60s safety timeout.
      let readDone = false;
      const readPromise = readLoop().then(() => { readDone = true; });
      const exitPromise = proc.exited.then(() => true);
      await Promise.race([readPromise, exitPromise]);
      if (!readDone) {
        // Process exited but stdout didn't close — give it 30s to drain
        const timeoutPromise = new Promise<void>(r => setTimeout(r, 30000));
        await Promise.race([readPromise, timeoutPromise]);
        if (!readDone) {
          if (process.platform === "win32") {
            try { proc.kill(); } catch {}
          } else {
            try { process.kill(-proc.pid, "SIGKILL"); } catch {}
            try { proc.kill("SIGKILL"); } catch {}
          }
          await readPromise.catch(() => {});
        }
      }
      // Collect stderr
      let stderrText = "";
      try { const sr = proc.stderr.getReader(); while (true) { const { done, value } = await sr.read(); if (done) break; stderrText += decoder.decode(value, { stream: true }); } } catch {}
      const cleanText = ftRef.val.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").trim();
      if (cleanText) {
        restartCount = 0; // Reset on success
        callbacks.onDone(cleanText);
      } else if (restartCount < MAX_RESTARTS) {
        restartCount++;
        callbacks.onError(`Session restarted (${restartCount}/${MAX_RESTARTS}). Please resend your message.`);
        startProc();
      } else {
        callbacks.onError(`Session ended after ${MAX_RESTARTS} restarts. Please refresh the page.`);
      }
    })();
  }

  startProc();

  return session;
}

// ── Legacy one-shot API (kept for backward compat) ────────────────────

export interface CCBResult {
  text: string;
  needsPermission: boolean;
  permissionMessage: string;
}

export type StreamCallback = (text: string, isPartial: boolean) => void;

export function runCCBStream(
  message: string,
  clientId: string,
  onStream: StreamCallback,
  onTool?: ToolCallback,
  onThinking?: ThinkingCallback,
  options?: { bypassPermissions?: boolean; planMode?: boolean },
): Promise<CCBResult> {
  return new Promise((resolve, reject) => {
    const env = buildEnv();
    const bypass = options?.bypassPermissions !== false;
    const plan = options?.planMode || false;
    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (bypass) args.push("--dangerously-skip-permissions");
    args.push("--append-system-prompt", "始终使用用户输入的语言回复。用户用中文则用中文，用户用英文则用英文。");
    if (plan) args.push("--append-system-prompt", "Before implementing anything, first create a detailed step-by-step plan. Present the plan to the user and wait for explicit approval before writing any code or executing any tools. Do not skip the planning phase.");
    args.push(message);
    if (existsSync(MCP_CONFIG)) args.push("--mcp-config", MCP_CONFIG);

    const proc = spawnProcess(AVAILABLE_RUNTIME, [CCB_SCRIPT, ...args], {
      cwd: CWD, env,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdinEnd();

    const bufRef = { val: "" };
    const ftRef = { val: "" };
    const hsRef = { val: false };
    const atiRef = { val: "" };
    const atnRef = { val: "" };
    const tibRef = { val: "" };
    const auqRef2 = { val: false };
    const decoder = new TextDecoder();

    const parseCbs: ParseCallbacks = {
      onToolStart: (name, id) => { if (onTool) onTool(name, id, "start"); },
      onToolRunning: (name, id, detail) => { if (onTool) onTool(name, id, "running", detail); },
      onToolDone: (name, id, detail) => { if (onTool) onTool(name, id, "done", detail); },
      onThinking: (text) => { if (onThinking) onThinking(text); },
      onText: (text, isPartial) => { if (isPartial && text) onStream(text, true); },
    };

    const reader = proc.stdout.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parseChunk(decoder.decode(value, { stream: true }), bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs, auqRef2);
        }
        if (bufRef.val.trim()) parseChunk("\n", bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs, auqRef2);
      } catch {}
      await proc.exited;
      let stderrText = "";
      try {
        const stderrReader = proc.stderr.getReader();
        while (true) { const { done, value } = await stderrReader.read(); if (done) break; stderrText += decoder.decode(value, { stream: true }); }
      } catch {}
      const cleanText = ftRef.val.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
      onStream("", false);
      if (!cleanText && stderrText.trim()) {
        reject(new Error(stderrText.trim().slice(0, 200)));
        return;
      }
      const needsPermission = /permission needed|do you want to proceed|approve/i.test(cleanText);
      resolve({ text: cleanText, needsPermission, permissionMessage: cleanText });
    })().catch(reject);
  });
}

export async function runCCB(message: string, clientId: string): Promise<CCBResult> {
  const chunks: string[] = [];
  return runCCBStream(message, clientId, (t, p) => { if (p && t) chunks.push(t); });
}
