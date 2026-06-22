import { runCCBStream, spawnSession, setReceiptCache } from "./ccb";
import type { CCBSession } from "./ccb";
import { existsSync, mkdirSync, statSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, normalize } from "path";
import { IS_BUN, readTextFile, writeFileData, fileExists, deleteFileData, readFileBytes, fileSizeSync, globSync, createFileResponse, moduleDir, serve, spawnProcess, readStreamToText, type ServeWebSocket } from "./runtime";

const PORT = parseInt(process.env.PORT || "3456");

const MODULE_DIR = moduleDir(import.meta);
const DEV_STATIC = join(MODULE_DIR, "../../web/dist");
const INSTALLED_STATIC = join(MODULE_DIR, "../web/dist");
const STATIC_DIR = existsSync(DEV_STATIC) ? DEV_STATIC : INSTALLED_STATIC;
const MCP_CONFIG_LOCAL = join(homedir(), ".claude", "mcp.json");
const WEB_SRC = join(MODULE_DIR, "../../web/src");
const WEB_INDEX = join(MODULE_DIR, "../../web/index.html");
const VISION_UPLOAD_DIR = join(homedir(), ".deepdesk", "uploads");
const CONVERSATIONS_DIR = join(homedir(), ".deepdesk", "conversations");
const VERSION_FILE = join(MODULE_DIR, "../../VERSION");
const UPDATE_CHECK_URL = "https://ccb-store.oss-cn-hangzhou.aliyuncs.com/deepdesk/version.json";
let CURRENT_VERSION = "0.0.0";
try { CURRENT_VERSION = (await readTextFile(VERSION_FILE)).trim(); } catch { /* use default */ }
mkdirSync(VISION_UPLOAD_DIR, { recursive: true });
mkdirSync(CONVERSATIONS_DIR, { recursive: true });
const DEEPDESK_ENV = join(homedir(), ".deepdesk.env");
const LICENSE_FILE = join(homedir(), ".deepdesk", "license.json");
const SKILLS_DIR = join(homedir(), ".claude", "skills");
const TOKEN_SERVER = "http://120.55.46.20:8080";
const MCP_DEFAULTS = join(MODULE_DIR, "mcp-defaults.json");
const MCP_DEFAULTS_REMOTE = "https://ccb-store.oss-cn-hangzhou.aliyuncs.com/deepdesk/mcp-defaults.json";
const IS_MAC = process.platform === "darwin";
const RESOURCE_DIR = process.env.DEEP_DESK_RESOURCES || MODULE_DIR;
const RECEIPT_CACHE = join(homedir(), ".deepdesk", "receipt-cache.json");

// ── App Store Receipt Validation (Mac only) ────────────────────────────
// Called at startup. Validates the MAS receipt against Apple's servers
// to determine if the user purchased the Pro In-App Purchase.
// Result is cached to disk (24h TTL) and pushed to ccb's isPro().
async function validateAppStoreReceipt() {
  if (!IS_MAC) return;
  try {
    const receiptPath = join(RESOURCE_DIR, "..", "_MASReceipt", "receipt");
    const receiptData = await readFileBytes(receiptPath);
    const receiptB64 = Buffer.from(receiptData).toString("base64");
    const sharedSecret = process.env.DEEP_DESK_APP_STORE_SHARED_SECRET || "";

    // Try production first; Apple returns 21007 for sandbox receipts
    for (const url of ["https://buy.itunes.apple.com/verifyReceipt", "https://sandbox.itunes.apple.com/verifyReceipt"]) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "receipt-data": receiptB64,
            password: sharedSecret,
            "exclude-old-transactions": true,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json() as any;
        if (data.status === 21007) continue; // sandbox receipt → try sandbox URL

        const inApp: any[] = data?.receipt?.in_app || [];
        // Match IAP product ID configured in App Store Connect (currently "001")
        const pro = inApp.some((iap: any) =>
          (iap.product_id || "") === "001"
        );

        // Update in-memory cache (ccb.ts reads this synchronously)
        setReceiptCache(pro);

        // Persist to disk for next launch
        mkdirSync(join(homedir(), ".deepdesk"), { recursive: true });
        await writeFileData(RECEIPT_CACHE, JSON.stringify({ pro, validatedAt: Date.now() }));
        return;
      } catch (e: any) {
        console.error(`[receipt] Apple verifyReceipt failed for ${url}: ${e?.message || e}`);
      }
    }
    console.error("[receipt] All receipt validation URLs exhausted — user remains Free");
  } catch (e: any) {
    // No receipt file (dev build), or read error, or unexpected failure.
    console.error(`[receipt] Receipt validation error: ${e?.message || e}`);
    // Leave cache unset → isPro() returns false.
  }
}

// Load persisted API keys from ~/.deepdesk.env on startup.
// The POST /api/settings handler writes keys here, but they must be loaded
// into process.env on startup so that CCB processes spawned before the user
// re-enters settings still pick up previously saved keys.
try {
  const envContent = await readTextFile(DEEPDESK_ENV);
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* file doesn't exist yet */ }

// ── Startup: receipt cache + MCP defaults ─────────────────────────────
// Fire-and-forget so the HTTP server starts immediately (Rust health check
// has a 15s timeout, and Apple API / CDN can be slow on cold networks).
(async () => {
  // 1. Mac: restore receipt cache from disk (makes isPro() correct immediately)
  if (IS_MAC) {
    try {
      const cacheRaw = await readTextFile(RECEIPT_CACHE);
      const cache = JSON.parse(cacheRaw);
      if (Date.now() - cache.validatedAt < 24 * 3600 * 1000) {
        setReceiptCache(cache.pro);
      }
    } catch { /* no cache yet */ }
    // Trigger background re-validation against Apple (don't await)
    validateAppStoreReceipt();
  }

  // 2. MCP defaults: bundled first, then CDN (Pro users only)
  if (existsSync(MCP_CONFIG_LOCAL)) return;
  try {
    const defaults = await readTextFile(MCP_DEFAULTS);
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
    await writeFileData(MCP_CONFIG_LOCAL, defaults);
    return;
  } catch {
    // Bundled MCP defaults not present (App Store build).
    // Pro gate: Mac checks validated receipt cache, Windows checks license file.
    let pro = false;
    if (IS_MAC) {
      try {
        const cacheRaw = await readTextFile(RECEIPT_CACHE);
        pro = JSON.parse(cacheRaw).pro;
      } catch {}
    } else {
      try {
        const licRaw = await readTextFile(LICENSE_FILE);
        pro = !!JSON.parse(licRaw).pro;
      } catch {}
    }
    if (!pro) return;
    try {
      const resp = await fetch(MCP_DEFAULTS_REMOTE, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const defaults = await resp.text();
        mkdirSync(join(homedir(), ".claude"), { recursive: true });
        await writeFileData(MCP_CONFIG_LOCAL, defaults);
      }
    } catch { /* network unavailable, skip */ }
  }
})();

// ── Session management ────────────────────────────────────────────────
// Sessions live by conversation ID. Multiple browser tabs share one session.
// Events broadcast to all connected WebSockets for the same convId.

interface ConvSession {
  session: CCBSession;
  lastUsed: number;
  sockets: Set<ServeWebSocket>;
  planMode: boolean;
  bypassPermissions: boolean;
}

const convSessions = new Map<string, ConvSession>();
const SESSION_TTL = 10 * 60 * 1000; // 10 min idle → auto-kill

function broadcast(cs: ConvSession, data: string) {
  for (const ws of cs.sockets) {
    try { ws.send(data); } catch {}
  }
}

// Purge dead sockets periodically (but never auto-kill sessions — user controls lifecycle)
setInterval(() => {
  const now = Date.now();
  for (const [convId, cs] of convSessions) {
    for (const ws of cs.sockets) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        cs.sockets.delete(ws);
      }
    }
  }
}, 5 * 60 * 1000);

// ── Vision API ────────────────────────────────────────────────────────

async function callVisionAPI(imageBuffer: Uint8Array, mimeType: string, prompt: string, maxTokens = 1000, model = "qwen3-vl-plus"): Promise<string> {
  const qwenKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  if (!qwenKey) throw new Error("QWEN_API_KEY not configured");
  const b64 = Buffer.from(imageBuffer).toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;
  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: prompt },
      ]}],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    console.error(`[vision] API error (${resp.status}): ${err.slice(0, 200)}`);
    throw new Error(`Vision API error (${resp.status})`);
  }
  const data = await resp.json() as any;
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    console.error("[vision] Unexpected response:", JSON.stringify(data).slice(0, 500));
    throw new Error("No description in Vision API response");
  }
  return content;
}

async function describeImage(imageBuffer: Uint8Array, mimeType: string): Promise<string> {
  return callVisionAPI(imageBuffer, mimeType,
    "请详细描述这张图片中的所有内容，包括文字、布局、颜色、图表数据等所有可见信息。用中文回答。");
}

// ── PDF → Image rendering ─────────────────────────────────────────────

async function renderPdfToImage(pdfPath: string): Promise<{ buffer: Uint8Array; mimeType: string } | null> {
  if (!IS_MAC) return null;
  try {
    const tmpDir = join(tmpdir(), "dd-pdf-" + Date.now().toString(36));
    mkdirSync(tmpDir, { recursive: true });
    const proc = spawnProcess("qlmanage", ["-t", "-s", "1200", "-o", tmpDir, pdfPath]);
    let status: number;
    try {
      status = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 30000)),
      ]);
    } catch {
      proc.kill();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return null;
    }
    if (status !== 0) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return null;
    }
    // qlmanage produces <filename>.pdf.png in the output dir
    // Wait briefly for file write to complete
    await new Promise(r => setTimeout(r, 200));
    const files = globSync("*.pdf.png", { cwd: tmpDir, absolute: true });
    if (files.length === 0) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return null;
    }
    const buf = await readFileBytes(files[0]);
    const outPath = join(VISION_UPLOAD_DIR, `pdf-${Date.now()}.png`);
    await writeFileData(outPath, buf);
    // Cleanup temp dir
    try { for (const f of files) await deleteFileData(f); rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return { buffer: buf, mimeType: "image/png" };
  } catch (e: any) {
    console.error(`[pdf-render] Error rendering ${pdfPath}: ${e?.message || e}`);
    return null;
  }
}

// ── Invoice-specific vision extraction ─────────────────────────────────

const INVOICE_PROMPT = `请识别这张发票/收据的所有关键信息，以严格的JSON格式输出。只输出JSON对象，不要markdown代码块包围，不要任何解释文字。`;

function isInvoiceEmpty(inv: any): boolean {
  if (!inv || inv._error) return true;
  const total = inv["价税合计"] || inv["发票金额"];
  return !total || total === 0 || total === "0" || total === "0.00";
}

// Map qwen-vl-ocr native field names to canonical invoice fields
function normalizeInvoice(raw: any): any {
  if (!raw || raw._error) return raw;
  return {
    发票号码: raw["发票号码"] || "",
    开票日期: raw["开票日期"] || "",
    销售方名称: raw["销售方名称"] || "",
    销售方税号: raw["销售方税号"] || "",
    购买方名称: raw["购买方名称"] || raw["受票方名称"] || "",
    购买方税号: raw["购买方税号"] || raw["受票方税号"] || "",
    服务项目: raw["服务项目"] || (raw["发票详单"]?.map((item: any) => item["货物或应税劳务、服务名称"] || "").join("; ") || ""),
    数量: raw["数量"] || 0,
    不含税金额: Number(raw["不含税金额"]) || 0,
    税额: Number(raw["税额"] || raw["发票税额"]) || 0,
    价税合计: Number(raw["价税合计"] || raw["发票金额"]) || 0,
    税率: raw["税率"] || (raw["发票详单"]?.[0]?.["税率"] || ""),
    备注: raw["备注"] || "",
    _raw: raw,  // preserve full OCR output for reference
  };
}

async function describeInvoice(imageBuffer: Uint8Array, mimeType: string): Promise<any> {
  const MAX_RETRIES = 3;
  let lastResult: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    }
    const text = await callVisionAPI(imageBuffer, mimeType, INVOICE_PROMPT, 1500, "qwen-vl-ocr-latest");
    let json = text.trim();
    if (json.startsWith("```")) {
      json = json.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    try {
      lastResult = normalizeInvoice(JSON.parse(json.trim()));
    } catch {
      console.error("[invoice] Failed to parse JSON from vision response:", json.slice(0, 300));
      lastResult = { _raw: text, _error: "JSON parse failed" };
      continue;
    }
    if (!isInvoiceEmpty(lastResult)) {
      if (attempt > 0) console.log(`[invoice] Succeeded on retry ${attempt}`);
      return lastResult;
    }
  }

  if (!isInvoiceEmpty(lastResult)) {
    console.log(`[invoice] Succeeded on final attempt`);
  }
  return lastResult;
}

// ── Session helpers ───────────────────────────────────────────────────

function createConvSession(convId: string, ws: ServeWebSocket, opts?: { planMode?: boolean; bypassPermissions?: boolean }): ConvSession {
  const cs: ConvSession = {
    session: null as any, lastUsed: Date.now(), sockets: new Set([ws]),
    planMode: opts?.planMode || false,
    bypassPermissions: opts?.bypassPermissions !== false,
  };
  const session = spawnSession({
    onText(text, isPartial) {
      if (isPartial && text) {
        broadcast(cs, JSON.stringify({ type: "text_delta", content: text, status: "streaming" }));
      }
    },
    onPermission(id, tool, message) {
      broadcast(cs, JSON.stringify({
        type: "permission_request", id, tool, message,
        questions: cs.session.pendingQuestions || undefined,
      }));
    },
    onTool(tool, id, status, detail) {
      broadcast(cs, JSON.stringify({ type: "tool_event", tool, id, status, detail }));
    },
    onThinking(text) {
      broadcast(cs, JSON.stringify({ type: "thinking_delta", content: text }));
    },
    onDone(fullText) {
      broadcast(cs, JSON.stringify({ type: "text_delta", content: fullText, status: "done" }));
    },
    onError(error) {
      broadcast(cs, JSON.stringify({ type: "error", message: error }));
    },
    onStatus(message) {
      broadcast(cs, JSON.stringify({ type: "agent_status", status: "warming", note: message }));
    },
    onContextStatus(status) {
      broadcast(cs, JSON.stringify({ type: "context_status", status }));
    },
  }, { bypassPermissions: cs.bypassPermissions, planMode: cs.planMode, convId });
  cs.session = session;
  return cs;
}

// ── Helpers ──────────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const ap = a.split(".").map(Number);
  const bp = b.split(".").map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const diff = (ap[i] || 0) - (bp[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── HTTP server ───────────────────────────────────────────────────────

serve({
  port: PORT,
  async fetch(req, server) {
    if (server.upgrade(req)) return;
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), port: PORT }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/status") {
      // Platform-aware bundled runtime path
      let bundledBun: string;
      if (process.platform === "win32") {
        bundledBun = join(MODULE_DIR, "../../binaries/bun-windows-x64/bun.exe");
      } else if (process.platform === "darwin") {
        bundledBun = join(MODULE_DIR, "../../binaries", `bun-darwin-${process.arch === "arm64" ? "aarch64" : "x64"}/bun`);
      } else {
        bundledBun = join(MODULE_DIR, "../../binaries", `bun-linux-${process.arch === "arm64" ? "aarch64" : "x64"}/bun`);
      }
      const systemBun = process.platform === "win32"
        ? join(homedir(), ".bun", "bin", "bun.exe")
        : join(homedir(), ".bun", "bin", "bun");
      const bunBin = existsSync(bundledBun) ? bundledBun : systemBun;
      // x86 Windows: check for Node.js runtime (Bun has no x86 binary)
      const isX86 = process.platform === "win32" && process.arch === "ia32";
      const nodeBin = isX86 ? join(MODULE_DIR, "../../binaries/node-win-x86/node.exe") : "";
      const hasRuntime = isX86 ? existsSync(nodeBin) : existsSync(bunBin);
      const ccbScript = join(homedir(), "node_modules", "claude-code-best", "dist", "cli.js");
      const hasKey = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY);
      return new Response(JSON.stringify({
        platform: process.platform, arch: process.arch,
        bun: existsSync(bunBin), node: isX86 ? existsSync(nodeBin) : false,
        ccb: existsSync(ccbScript),
        mcpConfig: existsSync(MCP_CONFIG_LOCAL),
        claudeMd: existsSync(join(homedir(), "CLAUDE.md")) || existsSync(join(homedir(), ".claude", "CLAUDE.md")),
        apiKey: hasKey, vision: !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY),
        ready: hasRuntime && existsSync(ccbScript) && hasKey,
        version: CURRENT_VERSION, sessions: convSessions.size,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // ── Diagnostic endpoint (debug) ───────────────────────────────
    if (url.pathname === "/api/debug") {
      const files: string[] = [];
      try {
        const { readdirSync } = await import("fs");
        const top = readdirSync(STATIC_DIR).slice(0, 20);
        files.push(...top.map((f: string) => `  ${f}`));
      } catch (e: any) { files.push(`(STATIC_DIR not readable: ${e.message})`); }
      // Try to list parent directories to understand what exists
      const serverDir = join(MODULE_DIR, "..");
      const serverFiles: string[] = [];
      try {
        const { readdirSync } = await import("fs");
        serverFiles.push(...readdirSync(serverDir).slice(0, 30));
      } catch (e: any) { serverFiles.push(`(not readable: ${e.message})`); }
      return new Response(JSON.stringify({
        platform: process.platform,
        isBun: IS_BUN,
        importMetaUrl: import.meta.url,
        cwd: process.cwd(),
        moduleDir: MODULE_DIR,
        devStatic: DEV_STATIC,
        installedStatic: INSTALLED_STATIC,
        staticDir: STATIC_DIR,
        staticDirExists: existsSync(STATIC_DIR),
        indexExists: existsSync(join(STATIC_DIR, "index.html")),
        webIndex: WEB_INDEX,
        webIndexExists: existsSync(WEB_INDEX),
        staticFiles: files,
        serverParentDir: serverDir,
        serverParentFiles: serverFiles,
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // ── Update check ───────────────────────────────────────────
    if (url.pathname === "/api/check-update") {
      try {
        const resp = await fetch(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          return new Response(JSON.stringify({
            current: CURRENT_VERSION, latest: null, hasUpdate: false,
            error: `Version info unavailable (${resp.status})`,
          }), { headers: { "Content-Type": "application/json" } });
        }
        const remote = await resp.json() as any;
        const latest = remote.version || "0.0.0";
        const hasUpdate = compareVersions(latest, CURRENT_VERSION) > 0;
        return new Response(JSON.stringify({
          current: CURRENT_VERSION, latest, hasUpdate,
          macUrl: remote.macUrl || "",
          winUrl: remote.winUrl || "",
        }), { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({
          current: CURRENT_VERSION, latest: null, hasUpdate: false,
          error: err.message || "Check failed",
        }), { headers: { "Content-Type": "application/json" } });
      }
    }

    // ── MCP Management API ──────────────────────────────────────────
    if (url.pathname === "/api/mcp") {
      if (req.method === "GET") {
        try {
          const raw = await readTextFile(MCP_CONFIG_LOCAL);
          const config = JSON.parse(raw);
          const servers: Record<string, any> = {};
          for (const [name, s] of Object.entries(config.mcpServers || {})) {
            servers[name] = { enabled: (s as any).enabled !== false, description: (s as any).description || "" };
          }
          return new Response(JSON.stringify({ servers }), { headers: { "Content-Type": "application/json" } });
        } catch { return new Response(JSON.stringify({ servers: {} }), { headers: { "Content-Type": "application/json" } }); }
      }
      if (req.method === "POST") {
        try {
          const body = await req.json() as any;
          const raw = await readTextFile(MCP_CONFIG_LOCAL);
          const config = JSON.parse(raw);
          for (const [name, enabled] of Object.entries(body.toggles || {})) {
            if (config.mcpServers?.[name]) config.mcpServers[name].enabled = enabled;
          }
          await writeFileData(MCP_CONFIG_LOCAL, JSON.stringify(config, null, 2));
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
      }
    }

    // ── Settings API ─────────────────────────────────────────────────
    if (url.pathname === "/api/settings") {
      if (req.method === "GET") {
        const hasDeepSeek = !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
        return new Response(JSON.stringify({
          deepseekKey: hasDeepSeek ? "••••configured" : "",
          qwenKey: (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) ? "••••configured" : "",
        }), { headers: { "Content-Type": "application/json" } });
      }
      if (req.method === "POST") {
        try {
          const body = await req.json() as any;
          let envContent = "";
          try { envContent = await readTextFile(DEEPDESK_ENV); } catch { /* new file */ }
          const lines = envContent.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
          const envMap: Record<string, string> = {};
          for (const line of lines) {
            const eq = line.indexOf("=");
            if (eq > 0) envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          if (body.deepseekKey) { envMap.DEEPSEEK_API_KEY = body.deepseekKey; envMap.OPENAI_API_KEY = body.deepseekKey; }
          if (body.qwenKey) envMap.QWEN_API_KEY = body.qwenKey;
          const newContent = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
          await writeFileData(DEEPDESK_ENV, newContent);
          // Also set in current process so GET reflects immediately
          if (body.deepseekKey) { process.env.DEEPSEEK_API_KEY = body.deepseekKey; process.env.OPENAI_API_KEY = body.deepseekKey; }
          if (body.qwenKey) process.env.QWEN_API_KEY = body.qwenKey;

          // Restart all active CCB sessions so they pick up the new API key.
          // Each tab's CCB subprocess captures env at spawn time; without a restart
          // old tabs keep using the old (missing) key indefinitely.
          for (const [convId, cs] of convSessions) {
            broadcast(cs, JSON.stringify({ type: "agent_status", status: "restarting", note: "API key updated, restarting session..." }));
            cs.session.kill();
            const newSession = spawnSession({
              onText(text, isPartial) {
                if (isPartial && text) broadcast(cs, JSON.stringify({ type: "text_delta", content: text, status: "streaming" }));
              },
              onPermission(id, tool, message) {
                broadcast(cs, JSON.stringify({
                  type: "permission_request", id, tool, message,
                  questions: newSession.pendingQuestions || undefined,
                }));
              },
              onTool(tool, id, status, detail) {
                broadcast(cs, JSON.stringify({ type: "tool_event", tool, id, status, detail }));
              },
              onThinking(text) {
                broadcast(cs, JSON.stringify({ type: "thinking_delta", content: text }));
              },
              onDone(fullText) {
                broadcast(cs, JSON.stringify({ type: "text_delta", content: fullText, status: "done" }));
              },
              onError(error) {
                broadcast(cs, JSON.stringify({ type: "error", message: error }));
              },
              onContextStatus(status) {
                broadcast(cs, JSON.stringify({ type: "context_status", status }));
              },
            }, { bypassPermissions: cs.bypassPermissions, planMode: cs.planMode, convId });
            cs.session = newSession;
            broadcast(cs, JSON.stringify({ type: "agent_status", status: "on", note: "Session restarted with new API key" }));
          }

          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }
    }

    // ── Conversation persistence API ──────────────────────────────────
    if (url.pathname === "/api/conversations" && req.method === "GET") {
      try {
        const files = Array.from(
          globSync("*.json", { cwd: CONVERSATIONS_DIR, absolute: false })
        ).sort();
        const list = [];
        for (const name of files) {
          const id = name.replace(/\.json$/, "");
          try {
            const raw = await readTextFile(join(CONVERSATIONS_DIR, name));
            const data = JSON.parse(raw);
            list.push({
              id,
              title: data.title || "Untitled",
              messageCount: data.messages?.length || 0,
              updatedAt: data.updatedAt || 0,
            });
          } catch { list.push({ id, title: "Untitled", messageCount: 0, updatedAt: 0 }); }
        }
        return new Response(JSON.stringify({ conversations: list }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    const convMatch = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)$/);
    if (convMatch) {
      const convId = convMatch[1];
      const convPath = join(CONVERSATIONS_DIR, `${convId}.json`);

      if (req.method === "GET") {
        try {
          if (!(await fileExists(convPath))) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
          return createFileResponse(convPath);
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      if (req.method === "PUT") {
        try {
          const body = await req.json();
          body.updatedAt = Date.now();
          await writeFileData(convPath, JSON.stringify(body, null, 2));
          return new Response(JSON.stringify({ ok: true, id: convId }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      if (req.method === "DELETE") {
        try {
          await deleteFileData(convPath).catch(() => {});
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
              try {
                const formData = await req.formData();
                const f = formData.get("file") as File | null;
                if (!f) return new Response(JSON.stringify({ error: "No file" }), { status: 400 });
                const ts = Date.now();
                const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                const destPath = join(VISION_UPLOAD_DIR, `${ts}-${safeName}`);
                const buf = new Uint8Array(await f.arrayBuffer());
                await writeFileData(destPath, buf);
                // Try text extraction; binary files → AI uses Read tool with path
                let textPreview = "";
                try {
                  const raw = new TextDecoder("utf-8", { fatal: true }).decode(buf);
                  const printable = raw.replace(/[^\x20-\x7E\x0A\x0D\x09\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, "");
                  if (printable.length > raw.length * 0.7) textPreview = raw.slice(0, 5000);
                } catch { /* binary */ }
                return new Response(JSON.stringify({
                  ok: true, path: destPath, name: f.name, size: f.size, textPreview,
                }), { headers: { "Content-Type": "application/json" } });
              } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
            }

            // ── Tauri drag-drop: read files from paths ─────────────────
            if (url.pathname === "/api/drop" && req.method === "POST") {
              try {
                const body = await req.json() as any;
                const paths: string[] = body.paths || [];
                console.error(`[drop] received ${paths.length} path(s): ${JSON.stringify(paths)}`);
                const results = [];
                const MAX_FILES = 20;
                for (const p of paths.slice(0, MAX_FILES)) {
                  // Skip directories — only process individual files
                  try {
                    const st = statSync(p);
                    if (st.isDirectory()) {
                      console.error(`[drop] skipping directory: ${p}`);
                      continue;
                    }
                  } catch { results.push({ path: p, error: "not found" }); continue; }
                  const name = p.split("/").pop() || p.split("\\").pop() || "file";
                  const size = fileSizeSync(p) || 0;
                  const ext = name.split(".").pop()?.toLowerCase() || "";
                  const isPdf = ext === "pdf";
                  let textPreview = "";
                  let invoiceData: any = null;
                  try {
                    const buf = await readFileBytes(p);
                    const raw = new TextDecoder("utf-8", { fatal: true }).decode(buf);
                    const printable = raw.replace(/[^\x20-\x7E\x0A\x0D\x09\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, "");
                    if (printable.length > raw.length * 0.7) textPreview = raw.slice(0, 5000);
                    else if (isPdf) textPreview = "(PDF — attempting visual recognition...)";
                    else textPreview = "(binary file)";
                  } catch {
                    textPreview = isPdf ? "(PDF — attempting visual recognition...)" : "(binary file)";
                  }
                  // PDF → render to image → Qwen Vision invoice extraction
                  if (isPdf && name.includes("发票")) {
                    try {
                      const rendered = await renderPdfToImage(p);
                      if (rendered) {
                        invoiceData = await describeInvoice(rendered.buffer, rendered.mimeType);
                        textPreview = JSON.stringify(invoiceData, null, 2);
                      }
                    } catch (e: any) {
                      console.error(`[drop] PDF invoice vision failed for ${name}: ${e?.message || e}`);
                    }
                  }
                  results.push({ path: p, name, size, textPreview, invoice: invoiceData });
                }
                if (paths.length > MAX_FILES) {
                  console.error(`[drop] truncated ${paths.length} paths to ${MAX_FILES}`);
                }
                return new Response(JSON.stringify({ ok: true, files: results }), {
                  headers: { "Content-Type": "application/json" },
                });
              } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
            }

            // Serve raw file by absolute path (used by Tauri drop handler for images)
            if (url.pathname === "/api/file" && req.method === "GET") {
              const filePath = url.searchParams.get("path");
              if (!filePath) return new Response("Missing path", { status: 400 });
              if (!(await fileExists(filePath))) return new Response("Not found", { status: 404 });
              return createFileResponse(filePath);
            }

    	    // ── License API ─────────────────────────────────────────────────
	    if (url.pathname === "/api/license/status") {
	      try {
	        const raw = await readTextFile(LICENSE_FILE);
	        const lic = JSON.parse(raw);
	        return new Response(JSON.stringify({ pro: !!lic.pro, package: lic.package || "", activatedAt: lic.activated_at || "" }), {
	          headers: { "Content-Type": "application/json" },
	        });
	      } catch {
	        return new Response(JSON.stringify({ pro: false, package: "", activatedAt: "" }), {
	          headers: { "Content-Type": "application/json" },
	        });
	      }
	    }

	    if (url.pathname === "/api/license/redeem" && req.method === "POST") {
	      try {
	        const body = await req.json() as any;
	        const key = (body.licenseKey || "").trim();
	        const pkg = body.package || "deepdesk-pro";
	        if (!key) return new Response(JSON.stringify({ error: "License key is required" }), { status: 400 });

	        // 1. Validate key against token server
	        const redeemResp = await fetch(`${TOKEN_SERVER}/api/redeem`, {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({ license_key: key, package_name: pkg }),
	          signal: AbortSignal.timeout(15000),
	        });
	        if (!redeemResp.ok) {
	          const errText = await redeemResp.text().catch(() => "Unknown error");
	          return new Response(JSON.stringify({ error: `Invalid license key (${redeemResp.status})` }), { status: 400 });
	        }
	        const redeemData = await redeemResp.json() as any;
	        if (!redeemData.success || !redeemData.download_url) {
	          return new Response(JSON.stringify({ error: redeemData.error || "Key validation failed" }), { status: 400 });
	        }

	        // 2. Download the .tar.gz to a temp file
	        const tmpPath = join(tmpdir(), `deepdesk-skill-${Date.now()}.tar.gz`);
	        const dlResp = await fetch(redeemData.download_url, { signal: AbortSignal.timeout(120000) });
	        if (!dlResp.ok) {
	          return new Response(JSON.stringify({ error: `Download failed (${dlResp.status})` }), { status: 500 });
	        }
	        await writeFileData(tmpPath, dlResp);

	        // 3. Extract to skills dir
	        mkdirSync(SKILLS_DIR, { recursive: true });
	        const proc = spawnProcess("tar", ["xzf", tmpPath, "-C", SKILLS_DIR], {
	          stdout: "pipe", stderr: "pipe",
	        });
	        const [out, err] = await Promise.all([
	          readStreamToText(proc.stdout),
	          readStreamToText(proc.stderr),
	        ]);
	        const exitCode = await proc.exited;
	        // Clean up temp file regardless
	        try { await deleteFileData(tmpPath); } catch {}

	        if (exitCode !== 0) {
	          return new Response(JSON.stringify({ error: `Extract failed: ${err || out}` }), { status: 500 });
	        }

	        // 3.5. Merge MCP config if package includes one
	        const pkgMcpPath = join(SKILLS_DIR, "mcp.json");
	        if (existsSync(pkgMcpPath)) {
	          try {
	            const pkgMcp = JSON.parse(await readTextFile(pkgMcpPath));
	            const pkgServers = pkgMcp.mcpServers || {};
	            if (Object.keys(pkgServers).length > 0) {
	              let existing: any = { mcpServers: {} };
	              try { existing = JSON.parse(await readTextFile(MCP_CONFIG_LOCAL)); } catch {}
	              existing.mcpServers = existing.mcpServers || {};
	              for (const [name, s] of Object.entries(pkgServers)) {
	                if (!existing.mcpServers[name]) {
	                  existing.mcpServers[name] = s;
	                }
	              }
	              await writeFileData(MCP_CONFIG_LOCAL, JSON.stringify(existing, null, 2));
	            }
	            try { await deleteFileData(pkgMcpPath); } catch {}
	          } catch { /* non-critical: MCP merge failure shouldn't block activation */ }
	        }

	        // 4. Persist license state
	        mkdirSync(join(homedir(), ".deepdesk"), { recursive: true });
	        await writeFileData(LICENSE_FILE, JSON.stringify({
	          pro: true,
	          package: redeemData.package_name || pkg,
	          activated_at: new Date().toISOString(),
	        }, null, 2));

	        return new Response(JSON.stringify({ ok: true, package: redeemData.package_name || pkg }), {
	          headers: { "Content-Type": "application/json" },
	        });
	      } catch (err: any) {
	        return new Response(JSON.stringify({ error: err.message || "Activation failed" }), { status: 500 });
	      }
	    }

	    if (url.pathname === "/api/vision" && req.method === "POST") {
      try {
        const contentType = req.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();
          const file = formData.get("image") as File | null;
          if (!file) return new Response(JSON.stringify({ error: "No image" }), { status: 400 });
          const buf = new Uint8Array(await file.arrayBuffer());
          const desc = await describeImage(buf, file.type || "image/png");
          const ts = Date.now();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const descPath = join(VISION_UPLOAD_DIR, `${ts}-${safeName}.txt`);
          await writeFileData(descPath, new TextEncoder().encode(desc));
          return new Response(JSON.stringify({ ok: true, description: desc, filePath: descPath }), { headers: { "Content-Type": "application/json" } });
        }
        const body = await req.json() as any;
        if (body.image) {
          const buf = Buffer.from(body.image, "base64");
          const desc = await describeImage(new Uint8Array(buf), body.mime || "image/png");
          const ts = Date.now();
          const descPath = join(VISION_UPLOAD_DIR, `${ts}-image.txt`);
          await writeFileData(descPath, new TextEncoder().encode(desc));
          return new Response(JSON.stringify({ ok: true, description: desc, filePath: descPath }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "No image data" }), { status: 400 });
      } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    // ── Direct image Q&A (bypasses CCB, QWEN Vision → DeepSeek chat) ─
    if (url.pathname === "/api/chat-with-image" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const imageFile = formData.get("image") as File | null;
        const question = (formData.get("question") as string) || "请描述这张图片";
        if (!imageFile) return new Response(JSON.stringify({ error: "No image" }), { status: 400 });

        const imageBuf = new Uint8Array(await imageFile.arrayBuffer());
        const frontendDesc = (formData.get("description") as string)?.trim();
        const desc = frontendDesc || await describeImage(imageBuf, imageFile.type || "image/png");

        const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
        const baseUrl = process.env.OPENAI_BASE_URL || "https://api.deepseek.com";
        if (!apiKey) return new Response(JSON.stringify({ error: "DeepSeek API key not configured" }), { status: 400 });

        const chatResp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              { role: "system", content: "你是一个图像分析助手。你会收到一张图片的详细文字描述，请基于描述回答用户的问题。用中文回答。" },
              { role: "user", content: `[图片描述]\n${desc}\n\n用户问题：${question}` },
            ],
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (!chatResp.ok) {
          const err = await chatResp.text().catch(() => "");
          return new Response(JSON.stringify({ error: `AI API error (${chatResp.status}): ${err.slice(0, 200)}` }), { status: 500 });
        }

        const chatData = await chatResp.json() as any;
        const reply = chatData?.choices?.[0]?.message?.content || "No response";

        return new Response(JSON.stringify({ ok: true, description: desc, reply }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    // ── Batch invoice processing ─────────────────────────────────────────
    // Accept multiple files (images + PDFs) and return structured invoice data.
    // Optional query param ?format=xlsx returns an Excel file.
    if (url.pathname === "/api/invoice-batch" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const files: File[] = [];
        for (const [_, v] of formData.entries()) {
          if (v instanceof File) files.push(v);
        }
        if (files.length === 0) {
          return new Response(JSON.stringify({ error: "No files provided" }), { status: 400 });
        }

        const results: any[] = [];
        for (const f of files) {
          const buf = new Uint8Array(await f.arrayBuffer());
          const ext = f.name.split(".").pop()?.toLowerCase() || "";
          const isPdf = ext === "pdf";
          let invoice: any = null;
          let error: string | null = null;

          try {
            if (isPdf) {
              // Save temp PDF, render to image, then process
              const pdfPath = join(VISION_UPLOAD_DIR, `batch-${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
              await writeFileData(pdfPath, buf);
              const rendered = await renderPdfToImage(pdfPath);
              if (rendered) {
                invoice = await describeInvoice(rendered.buffer, rendered.mimeType);
              } else {
                error = "Failed to render PDF to image";
              }
              await deleteFileData(pdfPath).catch(() => {});
            } else {
              invoice = await describeInvoice(buf, f.type || "image/png");
            }
          } catch (e: any) {
            error = e?.message || "Unknown error";
          }
          results.push({ filename: f.name, invoice, error: error || undefined });
        }

        // Aggregate summary
        const successCount = results.filter(r => r.invoice && !r.invoice._error).length;
        let totalAmount = 0;
        let totalTax = 0;
        for (const r of results) {
          if (r.invoice && !r.invoice._error) {
            const amount = parseFloat(r.invoice.价税合计);
            const tax = parseFloat(r.invoice.税额);
            if (!isNaN(amount)) totalAmount += amount;
            if (!isNaN(tax)) totalTax += tax;
          }
        }

        const wantXlsx = url.searchParams.get("format") === "xlsx";

        // Generate Excel if requested (simple CSV for now, xlsx generation needs a library)
        if (wantXlsx) {
          // Build a CSV which Excel can open
          let csv = "\uFEFF序号,文件名,发票号码,开票日期,销售方,购买方,服务项目,不含税金额,税额,价税合计,税率,备注,识别状态\n";
          results.forEach((r, i) => {
            const inv = r.invoice && !r.invoice._error ? r.invoice : {};
            const status = r.error ? "失败" : (r.invoice?._error ? "解析异常" : "成功");
            csv += [
              i + 1,
              `"${(r.filename || "").replace(/"/g, '""')}"`,
              `"${(inv.发票号码 || "").replace(/"/g, '""')}"`,
              `"${(inv.开票日期 || "").replace(/"/g, '""')}"`,
              `"${(inv.销售方名称 || "").replace(/"/g, '""')}"`,
              `"${(inv.购买方名称 || "").replace(/"/g, '""')}"`,
              `"${(inv.服务项目 || "").replace(/"/g, '""')}"`,
              inv.不含税金额 || "",
              inv.税额 || "",
              inv.价税合计 || "",
              `"${(inv.税率 || "").replace(/"/g, '""')}"`,
              `"${(inv.备注 || "").replace(/"/g, '""')}"`,
              status,
            ].join(",") + "\n";
          });
          // Add summary row
          csv += `,,,,,,合计,,${results.reduce((s, r) => { const a = parseFloat(r.invoice?.不含税金额); return s + (isNaN(a) ? 0 : a); }, 0).toFixed(2)},${totalTax.toFixed(2)},${totalAmount.toFixed(2)},,,`;

          const csvPath = join(VISION_UPLOAD_DIR, `invoice-batch-${Date.now()}.csv`);
          await writeFileData(csvPath, csv);
          const resp = new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="invoice-batch.csv"`,
            },
          });
          return resp;
        }

        // Default: JSON response
        return new Response(JSON.stringify({
          ok: true,
          total: files.length,
          success: successCount,
          totalAmount: totalAmount.toFixed(2),
          totalTax: totalTax.toFixed(2),
          results,
        }), { headers: { "Content-Type": "application/json" } });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, "");
    for (const dir of [STATIC_DIR, WEB_SRC]) {
      const fullPath = join(dir, safePath);
      if (!fullPath.startsWith(dir)) continue;
      
      if (await fileExists(fullPath)) return createFileResponse(fullPath);
    }
    if (url.pathname === "/") {
      if (await fileExists(WEB_INDEX)) return createFileResponse(WEB_INDEX);
    }
    return new Response("Not found", { status: 404 });
  },

  // ── WebSocket ───────────────────────────────────────────────────────
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "welcome", message: "Ready" }));
      // Heartbeat: send ping every 30s; if no pong within 10s, close
      let pongReceived = true;
      (ws as any).__pingTimer = setInterval(() => {
        if (!pongReceived) { try { ws.close(); } catch {} return; }
        pongReceived = false;
        try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }, 30000);
      (ws as any).__pongReceived = () => { pongReceived = true; };
    },

    async message(ws, data) {
      let msg: any;
      try { msg = JSON.parse(data as string); } catch { return; }

      // ── Pong (heartbeat response) ───────────────────────────────
      if (msg.type === "pong") {
        if ((ws as any).__pongReceived) (ws as any).__pongReceived();
        return;
      }

      // ── Session init (sent on connect, carries convId + agentMode) ─
      if (msg.type === "session_init") {
        const convId = msg.convId;
        (ws as any).__convId = convId;

        if (msg.agentMode) {
          let cs = convSessions.get(convId);
          if (cs) {
            // Add this WebSocket to existing session (multi-tab support)
            cs.sockets.add(ws);
            cs.lastUsed = Date.now();
            ws.send(JSON.stringify({ type: "agent_status", status: "on", note: "Reconnected to existing session" }));
          } else {
            // First time: create session
            ws.send(JSON.stringify({ type: "agent_status", status: "warming" }));
            cs = createConvSession(convId, ws, {
              planMode: msg.planMode || false,
              bypassPermissions: msg.bypassPermissions !== false,
            });
            convSessions.set(convId, cs);
            ws.send(JSON.stringify({ type: "agent_status", status: "on", note: "Agent session ready" }));
          }
        }
        return;
      }

      const convId = (ws as any).__convId || "default";
      const cs = convSessions.get(convId);

      // ── Agent mode toggle ──────────────────────────────────────
      if (msg.type === "agent_mode") {
        if (msg.enabled) {
          if (!cs) {
            ws.send(JSON.stringify({ type: "agent_status", status: "warming" }));
            const newCs = createConvSession(convId, ws, {
              planMode: msg.planMode || false,
              bypassPermissions: msg.bypassPermissions !== false,
            });
            convSessions.set(convId, newCs);
            ws.send(JSON.stringify({ type: "agent_status", status: "on", note: "Agent session ready" }));
          } else {
            cs.sockets.add(ws); cs.lastUsed = Date.now();
            // Update mode settings on existing session
            if (msg.planMode !== undefined) cs.planMode = msg.planMode;
            if (msg.bypassPermissions !== undefined) cs.bypassPermissions = msg.bypassPermissions;
            ws.send(JSON.stringify({ type: "agent_status", status: "on", note: "Reconnected" }));
          }
        } else {
          if (cs) { cs.session.kill(); convSessions.delete(convId); }
          ws.send(JSON.stringify({ type: "agent_status", status: "off" }));
        }
        return;
      }

      // ── User message ───────────────────────────────────────────
      if (msg.type === "user_message") {
        ws.send(JSON.stringify({ type: "text_delta", content: "", status: "thinking" }));

        // Agent mode: use persistent session (broadcasts to all tabs)
        if (cs) {
          cs.lastUsed = Date.now();
          cs.sockets.add(ws);
          cs.session.sendMessage(msg.content);
          return;
        }

        // Fast mode
        try {
          const result = await runCCBStream(
            msg.content, convId,
            (text, isPartial) => {
              if (isPartial && text) ws.send(JSON.stringify({ type: "text_delta", content: text, status: "streaming" }));
            },
            (tool, id, status, detail) => {
              ws.send(JSON.stringify({ type: "tool_event", tool, id, status, detail }));
            },
            (text) => { ws.send(JSON.stringify({ type: "thinking_delta", content: text })); },
            { bypassPermissions: true, planMode: false }, // fast mode defaults
          );
          if (result.needsPermission) {
            ws.send(JSON.stringify({ type: "permission_request", id: `p_${Date.now()}`, tool: "unknown", message: result.permissionMessage }));
          } else {
            ws.send(JSON.stringify({ type: "text_delta", content: result.text, status: "done" }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: err?.message || "Request failed" }));
        }
        return;
      }

      // ── Plan mode toggle ──────────────────────────────────
      if (msg.type === "plan_mode") {
        if (cs) {
          cs.planMode = !!msg.enabled;
          broadcast(cs, JSON.stringify({ type: "plan_mode_changed", enabled: cs.planMode }));
        }
        return;
      }

      // ── Bypass permissions toggle ──────────────────────────
      if (msg.type === "bypass_mode") {
        if (cs) {
          const wasBypass = cs.bypassPermissions;
          cs.bypassPermissions = !!msg.enabled;
          if (wasBypass !== cs.bypassPermissions) {
            // Restart session to apply the new flag
            broadcast(cs, JSON.stringify({ type: "agent_status", status: "restarting", note: "Restarting to apply bypass setting..." }));
            cs.session.kill();
            const newSession = spawnSession({
              onText(text, isPartial) {
                if (isPartial && text) broadcast(cs, JSON.stringify({ type: "text_delta", content: text, status: "streaming" }));
              },
              onPermission(id, tool, message) {
                broadcast(cs, JSON.stringify({
                  type: "permission_request", id, tool, message,
                  questions: newSession.pendingQuestions || undefined,
                }));
              },
              onTool(tool, id, status, detail) {
                broadcast(cs, JSON.stringify({ type: "tool_event", tool, id, status, detail }));
              },
              onThinking(text) {
                broadcast(cs, JSON.stringify({ type: "thinking_delta", content: text }));
              },
              onDone(fullText) {
                broadcast(cs, JSON.stringify({ type: "text_delta", content: fullText, status: "done" }));
              },
              onError(error) {
                broadcast(cs, JSON.stringify({ type: "error", message: error }));
              },
              onContextStatus(status) {
                broadcast(cs, JSON.stringify({ type: "context_status", status }));
              },
            }, { bypassPermissions: cs.bypassPermissions, planMode: cs.planMode, convId });
            cs.session = newSession;
            broadcast(cs, JSON.stringify({ type: "agent_status", status: "on", note: `Bypass ${cs.bypassPermissions ? "enabled" : "disabled"}` }));
          }
        }
        // Emit mode change to all connected clients
        const convIdForMode = (ws as any).__convId || "default";
        const csForMode = convSessions.get(convIdForMode);
        if (csForMode) {
          broadcast(csForMode, JSON.stringify({ type: "bypass_mode_changed", enabled: csForMode.bypassPermissions }));
        }
        return;
      }

      // ── Agent stop / start (manual session lifecycle) ──────
      if (msg.type === "agent_stop") {
        if (cs) {
          cs.session.kill();
          convSessions.delete(convId);
          broadcast(cs, JSON.stringify({ type: "agent_status", status: "off", note: "Session stopped by user" }));
          broadcast(cs, JSON.stringify({ type: "text_delta", content: "[Session stopped]", status: "done" }));
        }
        return;
      }

      if (msg.type === "agent_start") {
        if (!cs) {
          // Create new session if none exists
          const newCs = createConvSession(convId, ws, {
            planMode: msg.planMode || false,
            bypassPermissions: msg.bypassPermissions !== false,
          });
          convSessions.set(convId, newCs);
          broadcast(newCs, JSON.stringify({ type: "agent_status", status: "on", note: "Session started by user" }));
        } else {
          // Session already running — add this socket
          cs.sockets.add(ws);
          cs.lastUsed = Date.now();
          ws.send(JSON.stringify({ type: "agent_status", status: "on", note: "Reconnected to existing session" }));
        }
        return;
      }

      // ── Cancel / interrupt ────────────────────────────────────
      if (msg.type === "cancel") {
        if (cs) {
          cs.session.kill(); // kills ccb + all child processes
          broadcast(cs, JSON.stringify({ type: "text_delta", content: "[Interrupted]", status: "done" }));
        } else {
          ws.send(JSON.stringify({ type: "text_delta", content: "[Interrupted]", status: "done" }));
        }
        return;
      }

      // ── Permission reply ───────────────────────────────────────
      if (msg.type === "permission_reply") {
        ws.send(JSON.stringify({ type: "text_delta", content: "", status: "thinking" }));
        if (cs) { cs.session.sendPermission(!!msg.approved, msg.answer || undefined); return; }
        const approveText = msg.approved ? "I approve. Please proceed with the previous request." : "I deny. Do not proceed with the previous request.";
        try {
          const result = await runCCBStream(
            approveText, convId,
            (text, isPartial) => { if (isPartial && text) ws.send(JSON.stringify({ type: "text_delta", content: text, status: "streaming" })); },
            (tool, id, status, detail) => { ws.send(JSON.stringify({ type: "tool_event", tool, id, status, detail })); },
            (text) => { ws.send(JSON.stringify({ type: "thinking_delta", content: text })); },
          );
          ws.send(JSON.stringify({ type: "text_delta", content: result.text, status: "done" }));
        } catch (err: any) { ws.send(JSON.stringify({ type: "error", message: err?.message || "Request failed" })); }
      }
    },

    close(ws) {
      if ((ws as any).__pingTimer) clearInterval((ws as any).__pingTimer);
      const convId = (ws as any).__convId;
      if (convId) {
        const cs = convSessions.get(convId);
        if (cs) cs.sockets.delete(ws);
      }
    },
  },
});

console.log(`Deep Desk running at http://localhost:${PORT}`);
console.log(`  cwd: ${moduleDir(import.meta)}`);
console.log(`  mcp-config: ${existsSync(MCP_CONFIG_LOCAL) ? "loaded" : "not found"}`);
