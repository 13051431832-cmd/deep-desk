import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync } from "fs";

const home = homedir();
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));

// Bundled bun binary (falls back to system bun)
const BUNDLED_BUN = join(MODULE_DIR, "../../binaries",
  process.platform === "win32" ? "bun-windows-x64/bun.exe" : "bun-darwin-aarch64/bun");
const SYSTEM_BUN = join(home, ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const BUN_BIN = existsSync(BUNDLED_BUN) ? BUNDLED_BUN : SYSTEM_BUN;

const CCB_SCRIPT = join(home, "node_modules", "claude-code-best", "dist", "cli.js");
const CWD = home;
const MCP_CONFIG = join(home, ".claude", "mcp.json");

// Whitelist of env vars to pass to ccb subprocess (avoid leaking all env)
const CCB_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL",
  "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_OPENAI", "QWEN_API_KEY", "DASHSCOPE_API_KEY",
];

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const isWin = process.platform === "win32";
  for (const key of CCB_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.TERM = env.TERM || "xterm-256color";
  env.NO_COLOR = "1";
  env.CLAUDE_CODE_USE_OPENAI = "true";
  env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || "https://api.deepseek.com";
  env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic";
  env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || "deepseek-v4-pro";
  env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL || "deepseek-v4-flash";
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

// ── Types ─────────────────────────────────────────────────────────────

export type TextCallback = (text: string, isPartial: boolean) => void;
export type PermissionCallback = (id: string, tool: string, message: string) => void;
export type ToolCallback = (tool: string, id: string, status: "start" | "running" | "done", detail?: string) => void;
export type ThinkingCallback = (text: string) => void;
export type DoneCallback = (fullText: string) => void;
export type ErrorCallback = (error: string) => void;

export interface CCBSession {
  sendMessage(text: string): void;
  sendPermission(approved: boolean): void;
  kill(): void;
  onText: TextCallback;
  onPermission: PermissionCallback | null;
  onTool: ToolCallback | null;
  onThinking: ThinkingCallback | null;
  onDone: DoneCallback;
  onError: ErrorCallback;
  pendingPermission: string | null;
}

// ── Shared NDJSON stream parser ────────────────────────────────────────

interface ParseCallbacks {
  onToolStart?(name: string, id: string): void;
  onToolRunning?(name: string, id: string, detail: string): void;
  onToolDone?(name: string, id: string, detail: string): void;
  onThinking?(text: string): void;
  onText?(text: string, isPartial: boolean): void;
  onDone?(fullText: string): void;
}

function parseChunk(
  chunk: string, buffer: { val: string },
  fullText: { val: string }, hasStreamed: { val: boolean },
  activeToolId: { val: string }, activeToolName: { val: string },
  toolInputBuf: { val: string },
  cbs: ParseCallbacks,
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
        if (cb.type === "tool_use" && cb.name) {
          activeToolId.val = cb.id || ""; activeToolName.val = cb.name; toolInputBuf.val = "";
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
}

// ── Session spawner ───────────────────────────────────────────────────

export function spawnSession(callbacks: {
  onText: TextCallback;
  onPermission?: PermissionCallback;
  onTool?: ToolCallback;
  onThinking?: ThinkingCallback;
  onDone: DoneCallback;
  onError: ErrorCallback;
}, options?: { bypassPermissions?: boolean; planMode?: boolean }): CCBSession {
  const env = buildEnv();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Mutable references — swapped on restart
  let proc: Subprocess<"pipe", "pipe", "pipe">;
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

  function flushQueue() {
    while (messageQueue.length > 0 && proc && !proc.killed && procReady) {
      const msg = messageQueue.shift()!;
      try { proc.stdin.write(encoder.encode(msg)); proc.stdin.flush(); }
      catch { messageQueue.unshift(msg); break; }
    }
  }

  // ── Session object ──────────────────────────────────────────────────
  const session: CCBSession = {
    pendingPermission: null,
    onText: callbacks.onText,
    onPermission: callbacks.onPermission || null,
    onTool: callbacks.onTool || null,
    onThinking: callbacks.onThinking || null,
    onDone: callbacks.onDone,
    onError: callbacks.onError,

    sendMessage(text: string) {
      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";
      fullText = "";
      hasStreamedContent = false;
      pendingPermissionId = null;
      if (proc && !proc.killed && procReady) {
        try { proc.stdin.write(encoder.encode(msg)); proc.stdin.flush(); }
        catch { messageQueue.push(msg); }
      } else {
        messageQueue.push(msg);
        callbacks.onText("", true); // trigger "thinking" state in frontend
        // Auto-restart if process died (e.g. after Stop)
        if (!proc || proc.killed) startProc();
      }
    },

    sendPermission(approved: boolean) {
      const decision = JSON.stringify({
        type: "permission",
        id: pendingPermissionId,
        decision: approved ? "approve" : "deny",
      }) + "\n";
      pendingPermissionId = null;
      fullText = "";
      hasStreamedContent = false;
      if (proc && !proc.killed && procReady) {
        try { proc.stdin.write(encoder.encode(decision)); proc.stdin.flush(); }
        catch { messageQueue.push(decision); }
      }
    },

    kill() {
      if (!proc) return;
      procReady = false;
      try { process.kill(-proc.pid, "SIGTERM"); } catch {}
      try { proc.kill("SIGTERM"); } catch {}
    },
  };

  // ── Start ccb process + wire up readers ──────────────────────────────

  // Auto-install claude-code-best if not present
  function ensureCCB(): boolean {
    if (existsSync(CCB_SCRIPT)) return true;
    callbacks.onError("Installing AI engine (one-time setup, ~30s)...");
    try {
      // Install locally in home dir so CCB_SCRIPT path resolves
      mkdirSync(home, { recursive: true });
      const result = Bun.spawnSync([BUN_BIN, "install", "claude-code-best"], {
        cwd: home, env: process.env as Record<string, string>,
        stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode === 0 && existsSync(CCB_SCRIPT)) {
        callbacks.onError("Engine installed. Starting...");
        return true;
      }
      const stderr = new TextDecoder().decode(result.stderr).slice(0, 200);
      callbacks.onError(`Engine install failed (exit ${result.exitCode}): ${stderr}`);
    } catch (e: any) {
      callbacks.onError(`Engine install error: ${e.message}`);
    }
    return false;
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
      proc = Bun.spawn([BUN_BIN, CCB_SCRIPT, ...args], {
        cwd: CWD, env,
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
      }) as Subprocess<"pipe", "pipe", "pipe">;
    } catch (err: any) {
      if (restartCount < MAX_RESTARTS) {
        restartCount++;
        callbacks.onError(`Failed to start (${restartCount}/${MAX_RESTARTS}). Retrying...`);
        setTimeout(() => startProc(), 2000);
      } else {
        callbacks.onError("Cannot start AI engine. Check that bun and ccb are installed.");
      }
      return;
    }

    procReady = true;
    flushQueue();

    const bufRef = { val: "" };
    const ftRef = { val: "" };
    const hsRef = { val: false };
    const atiRef = { val: "" };
    const atnRef = { val: "" };
    const tibRef = { val: "" };

    const parseCbs: ParseCallbacks = {
      onToolStart: (name, id) => { if (callbacks.onTool) callbacks.onTool(name, id, "start"); },
      onToolRunning: (name, id, detail) => { if (callbacks.onTool) callbacks.onTool(name, id, "running", detail); },
      onToolDone: (name, id, detail) => { if (callbacks.onTool) callbacks.onTool(name, id, "done", detail); },
      onThinking: (text) => { if (callbacks.onThinking) callbacks.onThinking(text); },
      onText: (text, isPartial) => { if (isPartial && text) callbacks.onText(text, true); },
      onDone: (fullText) => { callbacks.onDone(fullText); },
    };

    async function readLoop() {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parseChunk(decoder.decode(value, { stream: true }), bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs);
        }
        if (bufRef.val.trim()) parseChunk("\n", bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs);
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
        if (!readDone) { try { process.kill(-proc.pid, "SIGKILL"); } catch {} try { proc.kill("SIGKILL"); } catch {} await readPromise.catch(() => {}); }
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

    const proc = Bun.spawn([BUN_BIN, CCB_SCRIPT, ...args], {
      cwd: CWD, env,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    }) as Subprocess<"pipe", "pipe", "pipe">;
    proc.stdin.end();

    const bufRef = { val: "" };
    const ftRef = { val: "" };
    const hsRef = { val: false };
    const atiRef = { val: "" };
    const atnRef = { val: "" };
    const tibRef = { val: "" };
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
          parseChunk(decoder.decode(value, { stream: true }), bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs);
        }
        if (bufRef.val.trim()) parseChunk("\n", bufRef, ftRef, hsRef, atiRef, atnRef, tibRef, parseCbs);
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
