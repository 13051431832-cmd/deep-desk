import { runCCBStream, spawnSession } from "./ccb";
import type { CCBSession } from "./ccb";
import type { ServerWebSocket } from "bun";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, normalize } from "path";
import { fileURLToPath } from "node:url";

const PORT = parseInt(process.env.PORT || "3456");

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
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
try { CURRENT_VERSION = (await Bun.file(VERSION_FILE).text()).trim(); } catch { /* use default */ }
mkdirSync(VISION_UPLOAD_DIR, { recursive: true });
mkdirSync(CONVERSATIONS_DIR, { recursive: true });
const DEEPDESK_ENV = join(homedir(), ".deepdesk.env");

// ── Session management ────────────────────────────────────────────────
// Sessions live by conversation ID. Multiple browser tabs share one session.
// Events broadcast to all connected WebSockets for the same convId.

interface ConvSession {
  session: CCBSession;
  lastUsed: number;
  sockets: Set<ServerWebSocket<unknown>>;
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

async function describeImage(imageBuffer: Uint8Array, mimeType: string): Promise<string> {
  const qwenKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
  if (!qwenKey) return "Vision API key not configured (set QWEN_API_KEY)";
  const b64 = Buffer.from(imageBuffer).toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;
  const resp = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-vl-plus",
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: "请详细描述这张图片中的所有内容，包括文字、布局、颜色、图表数据等所有可见信息。用中文回答。" },
      ]}],
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) { const err = await resp.text().catch(() => ""); return `Vision API error (${resp.status}): ${err.slice(0, 100)}`; }
  const data = await resp.json() as any;
  return data?.choices?.[0]?.message?.content || "No description returned";
}

// ── Session helpers ───────────────────────────────────────────────────

function createConvSession(convId: string, ws: ServerWebSocket<unknown>, opts?: { planMode?: boolean; bypassPermissions?: boolean }): ConvSession {
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
      broadcast(cs, JSON.stringify({ type: "permission_request", id, tool, message }));
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
  }, { bypassPermissions: cs.bypassPermissions, planMode: cs.planMode });
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

Bun.serve({
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
      const bunBin = join(homedir(), ".bun", "bin", "bun");
      const ccbScript = join(homedir(), "node_modules", "claude-code-best", "dist", "cli.js");
      const hasKey = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY);
      return new Response(JSON.stringify({
        bun: existsSync(bunBin), ccb: existsSync(ccbScript),
        mcpConfig: existsSync(MCP_CONFIG_LOCAL),
        claudeMd: existsSync(join(homedir(), "CLAUDE.md")) || existsSync(join(homedir(), ".claude", "CLAUDE.md")),
        apiKey: hasKey, vision: !!(process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY),
        ready: existsSync(bunBin) && existsSync(ccbScript) && hasKey,
        version: CURRENT_VERSION, sessions: convSessions.size,
      }), { headers: { "Content-Type": "application/json" } });
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
          try { envContent = await Bun.file(DEEPDESK_ENV).text(); } catch { /* new file */ }
          const lines = envContent.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
          const envMap: Record<string, string> = {};
          for (const line of lines) {
            const eq = line.indexOf("=");
            if (eq > 0) envMap[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          if (body.deepseekKey) envMap.DEEPSEEK_API_KEY = body.deepseekKey;
          if (body.qwenKey) envMap.QWEN_API_KEY = body.qwenKey;
          const newContent = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
          await Bun.write(DEEPDESK_ENV, newContent);
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
          new Bun.Glob("*.json").scanSync({ cwd: CONVERSATIONS_DIR, absolute: false })
        ).sort();
        const list = [];
        for (const name of files) {
          const id = name.replace(/\.json$/, "");
          try {
            const raw = await Bun.file(join(CONVERSATIONS_DIR, name)).text();
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
          const file = Bun.file(convPath);
          if (!(await file.exists())) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
          return new Response(file);
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      if (req.method === "PUT") {
        try {
          const body = await req.json();
          body.updatedAt = Date.now();
          await Bun.write(convPath, JSON.stringify(body, null, 2));
          return new Response(JSON.stringify({ ok: true, id: convId }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }

      if (req.method === "DELETE") {
        try {
          await Bun.file(convPath).delete?.().catch(() => {});
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
                await Bun.write(destPath, buf);
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

            if (url.pathname === "/api/vision" && req.method === "POST") {
      try {
        const contentType = req.headers.get("content-type") || "";
        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();
          const file = formData.get("image") as File | null;
          if (!file) return new Response(JSON.stringify({ error: "No image" }), { status: 400 });
          const buf = new Uint8Array(await file.arrayBuffer());
          const desc = await describeImage(buf, file.type || "image/png");
          return new Response(JSON.stringify({ ok: true, description: desc }), { headers: { "Content-Type": "application/json" } });
        }
        const body = await req.json() as any;
        if (body.image) {
          const buf = Buffer.from(body.image, "base64");
          const desc = await describeImage(new Uint8Array(buf), body.mime || "image/png");
          return new Response(JSON.stringify({ ok: true, description: desc }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "No image data" }), { status: 400 });
      } catch (err: any) { return new Response(JSON.stringify({ error: err.message }), { status: 500 }); }
    }

    const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, "");
    for (const dir of [STATIC_DIR, WEB_SRC]) {
      const fullPath = join(dir, safePath);
      if (!fullPath.startsWith(dir)) continue;
      const file = Bun.file(fullPath);
      if (await file.exists()) return new Response(file);
    }
    if (url.pathname === "/") {
      const file = Bun.file(WEB_INDEX);
      if (await file.exists()) return new Response(file);
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
                broadcast(cs, JSON.stringify({ type: "permission_request", id, tool, message }));
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
            }, { bypassPermissions: cs.bypassPermissions, planMode: cs.planMode });
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
        if (cs) { cs.session.sendPermission(!!msg.approved); return; }
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
console.log(`  cwd: ${import.meta.dir}`);
console.log(`  mcp-config: ${existsSync(MCP_CONFIG_LOCAL) ? "loaded" : "not found"}`);
