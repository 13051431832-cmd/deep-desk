import { useEffect, useState } from "preact/hooks";
import {
  conversations,
  activeConvId,
  newConversation,
  sendMessage,
  replyPermission,
  closeConversation,
  getActive,
  toggleAgentMode,
  togglePlanMode,
  toggleBypassPermissions,
  toggleThinking,
  renameConversation,
  loadSessions,
  triggerAutoSave,
  stopAgent,
  startAgent,
} from "./store";
import { ChatView } from "./components/ChatView";
import { InputBox } from "./components/InputBox";
import { PermissionCard } from "./components/PermissionCard";
import { ConversationTabs } from "./components/ConversationTabs";

const PORT = 3456;

export function App() {
  useEffect(() => {
    if (conversations.value.length === 0) {
      loadSessions(PORT).then((restored) => {
        if (!restored) newConversation(PORT);
      });
    }
  }, []);

  const active = getActive();

  const handleSend = (text: string) => {
    if (!activeConvId.value) return;
    sendMessage(activeConvId.value, text);
  };

  const handleApprove = (permId: string) => {
    if (!activeConvId.value) return;
    replyPermission(activeConvId.value, true);
  };

  const handleDeny = (permId: string) => {
    if (!activeConvId.value) return;
    replyPermission(activeConvId.value, false);
  };

  const handleToggleThinking = (msgId: string) => {
    if (!activeConvId.value) return;
    toggleThinking(activeConvId.value, msgId);
  };

  const handleRename = (id: string, title: string) => {
    renameConversation(id, title);
  };

  // Auto-save on message changes
  useEffect(() => {
    if (conversations.value.some((c) => c.messages.length > 0)) {
      triggerAutoSave();
    }
  }, [conversations.value]);

  const addSystemMsg = (cid: string, content: string) => {
    conversations.value = conversations.value.map((c) =>
      c.id === cid ? {
        ...c, messages: [...c.messages, {
          id: Math.random().toString(36).slice(2, 10),
          role: "system" as const, content, status: "done" as const,
        }],
      } : c
    );
  };

  const handleCommand = async (cmd: string, arg: string): Promise<boolean> => {
    const cid = activeConvId.value;
    if (!cid) return false;
    switch (cmd) {
      case "new":
        newConversation(PORT);
        return true;
      case "clear":
        conversations.value = conversations.value.map((c) =>
          c.id === cid ? { ...c, messages: [], title: "New Chat" } : c
        );
        return true;
      case "rename":
        if (arg) renameConversation(cid, arg);
        return true;
      case "agent":
        if (arg === "on") { toggleAgentMode(cid, true, PORT); addSystemMsg(cid, "**Agent Mode enabled.** Plan, Agents, Skills available. First warmup ~25s."); }
        else if (arg === "off") { toggleAgentMode(cid, false); addSystemMsg(cid, "**Agent Mode disabled.** Back to Fast Mode."); }
        else addSystemMsg(cid, "**/agent** — Usage:\n- `/agent on` — Enable Agent Mode\n- `/agent off` — Disable Agent Mode");
        return true;
      case "status": {
        try {
          const resp = await fetch("/api/status");
          const s = await resp.json();
          const statuses = [
            `**System Status**`,
            `Bun: ${s.bun ? "✅" : "❌"}`,
            `CCB: ${s.ccb ? "✅" : "❌"}`,
            `API Key: ${s.apiKey ? "✅" : "❌"}`,
            `MCP Config: ${s.mcpConfig ? "✅" : "❌"}`,
            `Vision: ${s.vision ? "✅" : "❌"}`,
            `Ready: ${s.ready ? "✅" : "❌"}`,
          ].join("\n");
          addSystemMsg(cid, statuses);
        } catch { addSystemMsg(cid, "Status unavailable."); }
        return true;
      }
      case "help": {
        addSystemMsg(cid, [
          "**Commands**",
          "",
          "`/new` — New conversation",
          "`/clear` — Clear current chat",
          "`/rename <name>` — Rename tab",
          "`/agent on|off` — Toggle Agent Mode",
          "`/status` — System health check",
          "`/help` — Show this help",
          "",
          "**Mode Buttons** (below input)",
          "🤖 Agent — Tools, Skills, MCP",
          "📋 Plan — Plan first, implement after approval",
          "⚡ Bypass — Auto-approve tool permissions",
          "",
          "**Tips**",
          "- Paste or drop images for analysis",
          "- Click 🤔 Thinking to see reasoning",
          "- Double-click tab to rename",
          "- Tabs auto-save on close",
        ].join("\n"));
        return true;
      }
    }
    return false;
  };

  const handleCancel = () => {
    if (!activeConvId.value || !active?.ws) return;
    active.ws.send(JSON.stringify({ type: "cancel" }));
  };

  const handleStopAgent = () => {
    if (!activeConvId.value) return;
    stopAgent(activeConvId.value);
  };

  const handleStartAgent = () => {
    if (!activeConvId.value) return;
    startAgent(activeConvId.value, PORT);
  };

  const handleToggleAgent = (enabled: boolean) => {
    if (!activeConvId.value) return;
    toggleAgentMode(activeConvId.value, enabled, PORT);
  };

  const handleTogglePlan = (enabled: boolean) => {
    if (!activeConvId.value) return;
    togglePlanMode(activeConvId.value, enabled);
    addSystemMsg(activeConvId.value, enabled
      ? "**Plan Mode ON** — AI will create a plan and wait for your approval before implementing."
      : "**Plan Mode OFF** — AI will implement directly.");
  };

  const handleToggleBypass = (enabled: boolean) => {
    if (!activeConvId.value) return;
    toggleBypassPermissions(activeConvId.value, enabled, PORT);
    addSystemMsg(activeConvId.value, enabled
      ? "**Bypass ON** — Tool permissions auto-approved. Session restarting..."
      : "**Bypass OFF** — You'll be asked to approve each tool use.");
  };

  // Warming countdown timer
  const [warmingSec, setWarmingSec] = useState(0);
  useEffect(() => {
    if (active?.agentStatus !== "warming") { setWarmingSec(0); return; }
    const start = Date.now();
    const t = setInterval(() => setWarmingSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active?.agentStatus]);

  // ── Update check ───────────────────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<{
    hasUpdate: boolean; latest: string; current: string;
    macUrl: string; winUrl: string; checking: boolean; error?: string;
  } | null>(null);

  const checkUpdate = async () => {
    try {
      const resp = await fetch("/api/check-update");
      const data = await resp.json();
      setUpdateInfo({
        hasUpdate: data.hasUpdate,
        latest: data.latest || data.current,
        current: data.current,
        macUrl: data.macUrl || "",
        winUrl: data.winUrl || "",
        checking: false,
        error: data.error,
      });
    } catch {
      // Silently fail — update check is non-critical
      setUpdateInfo((prev) => prev ? { ...prev, checking: false } : null);
    }
  };

  useEffect(() => {
    checkUpdate();
    const timer = setInterval(checkUpdate, 30 * 60 * 1000); // every 30 min
    return () => clearInterval(timer);
  }, []);

  const handleUpdate = () => {
    const url = updateInfo?.macUrl || updateInfo?.winUrl;
    if (url) window.open(url, "_blank");
  };

  const isStreaming = active?.status === "Thinking..." || active?.status === "Streaming..." || active?.agentStatus === "warming";

  return (
    <div class="app">
      <ConversationTabs
        conversations={conversations.value}
        activeId={activeConvId.value}
        onSelect={(id) => (activeConvId.value = id)}
        onNew={() => newConversation(PORT)}
        onClose={closeConversation}
        onRename={handleRename}
      />

      {active ? (
        <>
          <main class="main">
            <ChatView
              messages={active.messages}
              pendingPermission={active.pendingPermission}
              onApprove={handleApprove}
              onDeny={handleDeny}
              onToggleThinking={handleToggleThinking}
            />
          </main>
          <InputBox
            onSend={handleSend}
            onCancel={handleCancel}
            onCommand={handleCommand}
            agentMode={active.agentMode}
            agentStatus={active.agentStatus}
            onToggleAgent={handleToggleAgent}
            onStopAgent={handleStopAgent}
            onStartAgent={handleStartAgent}
            isStreaming={isStreaming}
            planMode={active.planMode}
            bypassPermissions={active.bypassPermissions}
            onTogglePlan={handleTogglePlan}
            onToggleBypass={handleToggleBypass}
          />
          <footer class="status-bar">
            <span>{active.status}</span>
            <div style="display:flex;gap:8px;align-items:center">
              {updateInfo?.hasUpdate && (
                <button class="update-btn" onClick={handleUpdate} title={`v${updateInfo.current} → v${updateInfo.latest}. Click to download.`}>
                  Update v{updateInfo.latest}
                </button>
              )}
              <a
                href="https://shieldyh.com"
                target="_blank"
                class="upgrade-btn"
                title="Get Pro: 200+ skills, auto-start, 3 devices"
              >
                Upgrade to Pro
              </a>
              {active.agentStatus === "warming" && (
                <span class="status-bar-agent">⟳ Warming... {warmingSec}s（通常 15-30s）</span>
              )}
              {active.pendingPermission && (
                <span class="status-bar-pending">⏳ Permission required</span>
              )}
              {!active.connected && (
                <span class="status-bar-pending disconnected">⟳ Reconnecting...</span>
              )}
            </div>
          </footer>
        </>
      ) : (
        <main class="main">
          <div class="empty-state">
            <h2>Deep Desk</h2>
            <p class="empty-subtitle">AI 编程助手，用自然语言完成任务</p>
            <div class="onboard-grid">
              <div class="onboard-card" onClick={() => { newConversation(PORT); setTimeout(() => { const ta = document.querySelector('textarea') as HTMLTextAreaElement; if (ta) { ta.value = '帮我分析当前项目结构'; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 500); }}>
                <span class="onboard-icon">🔍</span>
                <strong>代码分析</strong>
                <span>帮我分析当前项目结构</span>
              </div>
              <div class="onboard-card" onClick={() => { newConversation(PORT); setTimeout(() => { const ta = document.querySelector('textarea') as HTMLTextAreaElement; if (ta) { ta.value = '帮我写一个周报，总结本周工作'; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 500); }}>
                <span class="onboard-icon">📝</span>
                <strong>文档写作</strong>
                <span>帮我写周报、总结本周工作</span>
              </div>
              <div class="onboard-card" onClick={() => { newConversation(PORT); setTimeout(() => { const ta = document.querySelector('textarea') as HTMLTextAreaElement; if (ta) { ta.value = '这段代码有什么问题？如何优化？'; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 500); }}>
                <span class="onboard-icon">🐛</span>
                <strong>Debug 排错</strong>
                <span>这段代码有什么问题？如何优化？</span>
              </div>
              <div class="onboard-card" onClick={() => { newConversation(PORT); setTimeout(() => { const ta = document.querySelector('textarea') as HTMLTextAreaElement; if (ta) { ta.value = '帮我查一下最新的 React 19 有哪些新特性'; ta.dispatchEvent(new Event('input', {bubbles:true})); } }, 500); }}>
                <span class="onboard-icon">🌐</span>
                <strong>联网搜索</strong>
                <span>帮我查最新技术资讯</span>
              </div>
            </div>
            <p class="empty-hint">点击上方卡片快速开始，或在输入框输入你的问题</p>
          </div>
        </main>
      )}
    </div>
  );
}
