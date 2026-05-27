import { signal } from "@preact/signals";
import { randomUUID } from "./utils";
import { t } from "./i18n";

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  status: "thinking" | "streaming" | "done" | "error";
  toolName?: string;
  toolStatus?: "start" | "running" | "done";
  toolId?: string;
  thinkingContent?: string;
  thinkingVisible?: boolean;
}

export interface PermissionRequest {
  id: string;
  tool: string;
  message: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  pendingPermission: PermissionRequest | null;
  connected: boolean;
  status: string;
  ws: WebSocket | null;
  agentMode: boolean;
  agentStatus: "off" | "warming" | "on";
  planMode: boolean;
  bypassPermissions: boolean;
  reconnectAttempts: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;

function cid() {
  return randomUUID().slice(0, 8);
}

// ── Persistence ────────────────────────────────────────────────────────
// Each conversation is saved as a separate file on the server:
//   ~/.deepdesk/conversations/{convId}.json
// This survives server restarts, has no size limit, and works across browsers.

const STORAGE_KEY = "deepdesk-sessions"; // legacy migration key

interface SavedConv {
  id: string; title: string;
  messages: { id: string; role: string; content: string; status: string; thinkingContent?: string }[];
  agentMode: boolean;
  planMode: boolean;
  bypassPermissions: boolean;
  updatedAt?: number;
}

// ── Server API helpers ────────────────────────────────────────────────

async function apiFetch(path: string, init?: RequestInit) {
  const resp = await fetch(path, init);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

async function saveConvToServer(conv: Conversation) {
  if (conv.messages.length === 0) return;
  const data: SavedConv = {
    id: conv.id, title: conv.title,
    messages: conv.messages
      .filter((m) => m.status === "done")
      .map((m) => ({
        id: m.id, role: m.role, content: m.content,
        status: m.status, thinkingContent: m.thinkingContent,
      })),
    agentMode: conv.agentMode,
    planMode: conv.planMode,
    bypassPermissions: conv.bypassPermissions,
  };
  await apiFetch(`/api/conversations/${conv.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function deleteConvFromServer(convId: string) {
  try { await apiFetch(`/api/conversations/${convId}`, { method: "DELETE" }); } catch {}
}

function saveSessions() {
  // Save each conversation individually to server (fire-and-forget)
  for (const c of conversations.value) {
    if (c.messages.some((m) => m.status === "done")) {
      saveConvToServer(c).catch(() => {});
    }
  }
}

export async function loadSessions(port: number): Promise<boolean> {
  // ── Try server-side persistence first ──────────────────────────
  try {
    const data = await apiFetch("/api/conversations");
    const list = data.conversations as { id: string }[];
    if (!list?.length) {
      // No server files — try legacy localStorage migration
      return loadFromLocalStorage(port);
    }

    // Load each conversation from its individual file
    const restored: Conversation[] = [];
    for (const item of list) {
      try {
        const convData = await apiFetch(`/api/conversations/${item.id}`);
        if (!convData.messages?.length) continue;
        restored.push({
          id: convData.id, title: convData.title || "Untitled",
          messages: convData.messages.map((sm: any) => ({
            ...sm, role: sm.role as Message["role"],
            status: "done" as const,
            thinkingVisible: false,
          })),
          pendingPermission: null,
          connected: false, status: "Restored",
          ws: null,
          agentMode: convData.agentMode || false, agentStatus: "off" as const,
          planMode: convData.planMode || false,
          bypassPermissions: convData.bypassPermissions !== false,
          reconnectAttempts: 0,
        });
      } catch {}
    }

    if (restored.length === 0) return false;
    conversations.value = restored;
    activeConvId.value = restored[0].id;

    // If there was a previously active tab, select it (last updated)
    const active = getActive();
    if (active) connectConversation(active.id, port);

    return true;
  } catch {
    // Server unreachable — try localStorage fallback
    return loadFromLocalStorage(port);
  }
}

// Legacy localStorage migration (kept for backward compat)
function loadFromLocalStorage(port: number): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.conversations?.length) return false;

    // Migrate: save each conversation to server, then clear localStorage
    const idMap = new Map<string, string>();
    const restored: Conversation[] = data.conversations.map((sc: any) => {
      const newId = cid();
      idMap.set(sc.id, newId);
      const conv: Conversation = {
        id: newId, title: sc.title,
        messages: (sc.messages || []).map((sm: any) => ({
          ...sm, role: sm.role as Message["role"],
          status: "done" as const,
          thinkingVisible: false,
        })),
        pendingPermission: null,
        connected: false, status: "Restored",
        ws: null,
        agentMode: sc.agentMode || false, agentStatus: "off" as const,
        planMode: sc.planMode || false,
        bypassPermissions: sc.bypassPermissions !== false,
        reconnectAttempts: 0,
      };
      // Migrate to server
      saveConvToServer(conv).catch(() => {});
      return conv;
    });

    conversations.value = restored;
    activeConvId.value = data.activeId && idMap.has(data.activeId)
      ? idMap.get(data.activeId)! : restored[0].id;

    try { localStorage.removeItem(STORAGE_KEY); } catch {}

    const active = getActive();
    if (active) connectConversation(active.id, port);

    return true;
  } catch { return false; }
}

// ── Global state ───────────────────────────────────────────────────────
export const conversations = signal<Conversation[]>([]);
export const activeConvId = signal<string | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function triggerAutoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessions, 2000);
}

export function getActive(): Conversation | null {
  const id = activeConvId.value;
  if (!id) return null;
  return conversations.value.find((c) => c.id === id) || null;
}

// Create a new conversation (tab)
export function newConversation(port: number): string {
  const id = cid();
  const conv: Conversation = {
    id, title: t("tab.newChat"), messages: [], pendingPermission: null,
    connected: false, status: "Connecting...", ws: null,
    agentMode: false, agentStatus: "off",
    planMode: false, bypassPermissions: true,
    reconnectAttempts: 0,
  };
  conversations.value = [...conversations.value, conv];
  activeConvId.value = id;
  connectConversation(id, port);
  return id;
}

// Rename a conversation
export function renameConversation(convId: string, newTitle: string) {
  const t = newTitle.trim();
  if (!t) return;
  conversations.value = conversations.value.map((c) =>
    c.id === convId ? { ...c, title: t } : c
  );
  saveSessions();
}

// Connect a conversation's WebSocket
export function connectConversation(convId: string, port: number) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;

  // Hardcoded localhost: webview uses localhost:3456, browser dev uses Vite proxy
  const ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => {
    updateConv(convId, { connected: true, status: "Ready", reconnectAttempts: 0 });
    // Send session init with convId and agent mode state
    const c = conversations.value.find((c1) => c1.id === convId);
    ws.send(JSON.stringify({
      type: "session_init",
      convId,
      agentMode: c?.agentMode || false,
      planMode: c?.planMode || false,
      bypassPermissions: c?.bypassPermissions !== false,
    }));
  };

  ws.onmessage = (e) => {
    try {
      handleConvEvent(convId, JSON.parse(e.data));
    } catch {}
  };

  ws.onerror = () => {
    // onclose will fire after this — no need to handle separately
  };

  ws.onclose = () => {
    const c = conversations.value.find((c1) => c1.id === convId);
    if (!c) return;

    const attempts = (c.reconnectAttempts || 0) + 1;
    if (attempts <= MAX_RECONNECT_ATTEMPTS) {
      updateConv(convId, {
        connected: false,
        status: `Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`,
        reconnectAttempts: attempts,
      });
      setTimeout(() => {
        const current = conversations.value.find((c1) => c1.id === convId);
        if (current && !current.connected) connectConversation(convId, port);
      }, RECONNECT_INTERVAL);
    } else {
      updateConv(convId, {
        connected: false,
        status: "Connection lost — refresh to retry",
      });
    }
  };

  updateConv(convId, { ws });
}

// Find the current streaming/thinking message (the one actively being built)
function getActiveAssistantMsg(conv: Conversation): Message | null {
  return (
    conv.messages.find(
      (m) =>
        m.role === "assistant" &&
        (m.status === "thinking" || m.status === "streaming"),
    ) || null
  );
}

// Translate technical errors into beginner-friendly messages
function friendlyError(raw: string): string {
  if (/524|timeout|ETIMEDOUT/i.test(raw)) return t("error.timeout");
  if (/401|unauthorized|invalid.*key/i.test(raw)) return t("error.apiKey");
  if (/429|rate.?limit/i.test(raw)) return t("error.rateLimit");
  if (/ENOTFOUND|ECONNREFUSED|network/i.test(raw)) return t("error.network");
  if (/Session restarted/i.test(raw)) return raw; // Already friendly
  if (/Session ended after/i.test(raw)) return t("error.sessionEnded");
  return raw.length > 150 ? raw.slice(0, 150) + "..." : raw;
}

// Process events for a specific conversation
function handleConvEvent(convId: string, event: any) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;

  switch (event.type) {
    case "ping":
      conv.ws?.send(JSON.stringify({ type: "pong" }));
      break;

    case "welcome":
      updateConv(convId, { status: "Ready" });
      break;

    case "text_delta": {
      if (event.status === "thinking") {
        // Don't create duplicate if thinking_delta already built one
        if (!getActiveAssistantMsg(conv)) {
          conv.messages = [...conv.messages, {
            id: cid(), role: "assistant", content: "Thinking...", status: "thinking",
          }];
        }
        updateConv(convId, { status: "Thinking..." });
      } else if (event.status === "streaming") {
        // Append streaming delta to current message
        let msg = getActiveAssistantMsg(conv);
        if (!msg) {
          // No active streaming msg — create one
          msg = {
            id: cid(),
            role: "assistant",
            content: event.content || "",
            status: "streaming",
          };
          conv.messages = [...conv.messages, msg];
        } else {
          // Append to existing streaming message
          if (msg.status === "thinking") {
            msg.content = event.content || "";
            msg.status = "streaming";
          } else {
            msg.content += event.content || "";
          }
        }
        updateConv(convId, { status: "Streaming..." });
      } else if (event.status === "done") {
        // Finalize the streaming message
        const msg = getActiveAssistantMsg(conv);
        if (msg) {
          // If we already have streaming content, the done event carries the full text
          if (event.content) {
            msg.content = event.content;
          }
          msg.status = "done";
        } else if (event.content) {
          // No streaming msg existed — create one (fallback for non-streaming)
          conv.messages = [
            ...conv.messages,
            {
              id: cid(),
              role: "assistant",
              content: event.content,
              status: "done",
            },
          ];
        }
        updateConv(convId, { status: "Ready" });
        saveSessions();

        // Auto-title from first exchange
        if (conv.title === t("tab.newChat") && conv.messages.length >= 2) {
          const firstMsg = conv.messages[0]?.content || "";
          updateConv(convId, {
            title:
              firstMsg.slice(0, 30) + (firstMsg.length > 30 ? "..." : ""),
          });
        }
      }
      break;
    }

    case "permission_request":
      updateConv(convId, {
        pendingPermission: {
          id: event.id,
          tool: event.tool,
          message: event.message,
        },
        status: "Permission required",
      });
      // Browser notification for background tabs
      if (conv.id !== activeConvId.value && "Notification" in window) {
        try {
          if (Notification.permission === "granted") {
            new Notification("Deep Desk — Permission Required", {
              body: `${event.tool}: ${(event.message || "").slice(0, 100)}`,
              tag: `perm-${conv.id}`,
            });
          } else if (Notification.permission === "default") {
            Notification.requestPermission();
          }
        } catch {}
      }
      break;

    case "tool_event": {
      // Show tool execution progress — update single message per tool, force re-render
      const toolIdx = conv.messages.findIndex(
        (m) => m.role === "tool" && m.toolId === event.id && m.toolStatus !== "done"
      );
      if (event.status === "done") {
        // Mark tool as complete
        if (toolIdx >= 0) {
          const msgs = [...conv.messages];
          msgs[toolIdx] = {
            ...msgs[toolIdx],
            content: `${event.tool} completed`,
            toolStatus: "done" as const,
            status: "done" as const,
          };
          conv.messages = msgs;
        }
      } else if (toolIdx >= 0) {
        // Update existing — throttle: only update meaningful changes
        conv.messages = conv.messages.map((m, i) =>
          i === toolIdx
            ? { ...m, content: `${event.tool}: ${event.detail || "running..."}`, toolStatus: event.status }
            : m
        );
      } else {
        // New tool — create message
        conv.messages = [...conv.messages, {
          id: cid(), role: "tool" as const,
          content: `${event.tool}: ${event.detail || "running..."}`,
          status: "streaming" as const, toolName: event.tool,
          toolStatus: event.status as "start" | "running",
          toolId: event.id,
        }];
      }
      updateConv(convId, {
        status: event.status === "done" ? "Ready" : `Running ${event.tool}...`,
      });
      break;
    }

    case "thinking_delta": {
      // Accumulate thinking stream into current assistant message
      let msg = getActiveAssistantMsg(conv);
      if (!msg) {
        msg = { id: cid(), role: "assistant", content: "", status: "thinking", thinkingContent: event.content || "" };
        conv.messages = [...conv.messages, msg];
      } else {
        msg.thinkingContent = (msg.thinkingContent || "") + (event.content || "");
      }
      updateConv(convId, { status: "Thinking..." });
      break;
    }

    case "agent_status":
      updateConv(convId, {
        agentStatus: event.status,
        status: event.status === "warming" ? "Agent warming up (~25s)..." : conv.status,
      });
      break;

    case "error":
      const errText = friendlyError(event.message || "");
      updateConv(convId, { status: errText });
      const activeMsg = getActiveAssistantMsg(conv);
      if (activeMsg) {
        activeMsg.content = errText;
        activeMsg.status = "error";
      } else {
        conv.messages = [
          ...conv.messages,
          {
            id: cid(),
            role: "assistant",
            content: errText,
            status: "error",
          },
        ];
      }
      break;
  }
}

// Send a user message in a conversation
export function sendMessage(convId: string, text: string) {
  // Re-read from signal after any pending updates
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;

  // Auto-start agent if agent mode is ON but process is OFF
  if (conv.agentMode && conv.agentStatus === "off") {
    startAgent(convId, parseInt(location.port) || 3456);
    // Queue the message to be sent after agent starts
    updateConv(convId, { status: "Agent warming up (~25s)..." });
    setTimeout(() => {
      const c = conversations.value.find((c1) => c1.id === convId);
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: "user_message", content: text }));
      }
    }, 3000);
    // Still add user message to chat
    const msgs = [
      ...conv.messages,
      { id: cid(), role: "user" as const, content: text, status: "done" as const },
    ];
    conversations.value = conversations.value.map((c) =>
      c.id === convId ? { ...c, messages: msgs, pendingPermission: null } : c
    );
    saveSessions();
    return;
  }

  // Always add user message to chat first (even if WS not ready)
  const newMessages = [
    ...conv.messages,
    { id: cid(), role: "user" as const, content: text, status: "done" as const },
  ];
  conversations.value = conversations.value.map((c) =>
    c.id === convId ? { ...c, messages: newMessages, pendingPermission: null } : c
  );
  saveSessions();

  // Try to send via WebSocket, reconnect if needed
  if (conv.ws && conv.ws.readyState === WebSocket.OPEN) {
    conv.ws.send(JSON.stringify({ type: "user_message", content: text }));
  } else {
    // Retry connecting, then queue the message
    updateConv(convId, { connected: false, status: "Reconnecting..." });
    connectConversation(convId, parseInt(location.port) || 3456);
    setTimeout(() => {
      const c = conversations.value.find((c1) => c1.id === convId);
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: "user_message", content: text }));
      }
    }, 2000);
  }
}

// Approve/deny permission
export function replyPermission(convId: string, approved: boolean) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv?.ws) return;
  conv.ws.send(JSON.stringify({ type: "permission_reply", approved }));
  updateConv(convId, { pendingPermission: null, status: "Thinking..." });
}

// Close a conversation
export function closeConversation(convId: string) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (conv?.ws) conv.ws.close();

  const remaining = conversations.value.filter((c) => c.id !== convId);
  conversations.value = remaining;

  if (activeConvId.value === convId) {
    activeConvId.value = remaining[0]?.id || null;
  }

  // Delete from server
  deleteConvFromServer(convId);
}

// Toggle thinking visibility for a message
export function toggleThinking(convId: string, msgId: string) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;
  conv.messages = conv.messages.map((m) =>
    m.id === msgId ? { ...m, thinkingVisible: !m.thinkingVisible } : m
  );
  conversations.value = conversations.value.map((c) =>
    c.id === convId ? { ...c } : c
  );
}

// Stop agent process (explicit user action — kills CCB, session removed)
export function stopAgent(convId: string) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv?.ws || conv.ws.readyState !== WebSocket.OPEN) return;
  conv.ws.send(JSON.stringify({ type: "agent_stop" }));
}

// Start agent process (explicit user action — creates new CCB session)
export function startAgent(convId: string, port: number) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;

  // Auto-connect if disconnected
  if (!conv.ws || conv.ws.readyState > 1) {
    connectConversation(convId, port);
    updateConv(convId, {
      agentMode: true,
      agentStatus: "warming",
      status: "Agent warming up (~25s)...",
    });
    setTimeout(() => {
      const c = conversations.value.find((c1) => c1.id === convId);
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: "agent_start" }));
      }
    }, 1000);
    return;
  }

  conv.ws.send(JSON.stringify({
    type: "agent_start",
    planMode: conv.planMode,
    bypassPermissions: conv.bypassPermissions,
  }));
  updateConv(convId, {
    agentMode: true,
    agentStatus: "warming",
    status: "Agent warming up (~25s)...",
  });
}

// Toggle agent mode for a conversation
export function toggleAgentMode(convId: string, enabled: boolean, port?: number) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;

  // Auto-connect WebSocket if not connected (e.g. restored tab)
  if (!conv.ws || conv.ws.readyState > 1) {
    if (port) connectConversation(convId, port);
    // Queue the toggle — WebSocket will send session_init then agent_mode
    updateConv(convId, {
      agentMode: enabled,
      agentStatus: enabled ? "warming" : "off",
      status: enabled ? "Agent warming up (~25s)..." : "Ready",
    });
    // Retry send after connection
    setTimeout(() => {
      const c = conversations.value.find((c1) => c1.id === convId);
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: "agent_mode", enabled }));
      }
    }, 1000);
    return;
  }

  conv.ws.send(JSON.stringify({
    type: "agent_mode", enabled,
    planMode: conv.planMode,
    bypassPermissions: conv.bypassPermissions,
  }));
  updateConv(convId, {
    agentMode: enabled,
    agentStatus: enabled ? "warming" : "off",
    status: enabled ? "Agent warming up (~25s)..." : "Ready",
  });
}

// Toggle plan mode for a conversation
export function togglePlanMode(convId: string, enabled: boolean) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;
  if (conv.ws && conv.ws.readyState === WebSocket.OPEN) {
    conv.ws.send(JSON.stringify({ type: "plan_mode", enabled }));
  }
  updateConv(convId, { planMode: enabled });
}

// Toggle bypass permissions for a conversation (requires session restart)
export function toggleBypassPermissions(convId: string, enabled: boolean, port?: number) {
  const conv = conversations.value.find((c) => c.id === convId);
  if (!conv) return;
  if (conv.ws && conv.ws.readyState === WebSocket.OPEN) {
    conv.ws.send(JSON.stringify({ type: "bypass_mode", enabled }));
  }
  updateConv(convId, { bypassPermissions: enabled });
}

// Helper: update a conversation field
function updateConv(convId: string, updates: Partial<Conversation>) {
  conversations.value = conversations.value.map((c) =>
    c.id === convId ? { ...c, ...updates } : c,
  );
}
