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
import { ConversationTabs } from "./components/ConversationTabs";
import { t, lang, toggleLang } from "./i18n";

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
          c.id === cid ? { ...c, messages: [], title: t("tab.newChat") } : c
        );
        return true;
      case "rename":
        if (arg) renameConversation(cid, arg);
        return true;
      case "agent":
        if (arg === "on") { toggleAgentMode(cid, true, PORT); addSystemMsg(cid, t("agent.enabled")); }
        else if (arg === "off") { toggleAgentMode(cid, false); addSystemMsg(cid, t("agent.disabled")); }
        else addSystemMsg(cid, t("cmd.agentUsage"));
        return true;
      case "status": {
        try {
          const resp = await fetch("/api/status");
          const s = await resp.json();
          const statuses = [
            t("cmd.status.title"),
            `Bun: ${s.bun ? "✅" : "❌"}`,
            `CCB: ${s.ccb ? "✅" : "❌"}`,
            `API Key: ${s.apiKey ? "✅" : "❌"}`,
            `MCP Config: ${s.mcpConfig ? "✅" : "❌"}`,
            `Vision: ${s.vision ? "✅" : "❌"}`,
            `Ready: ${s.ready ? "✅" : "❌"}`,
          ].join("\n");
          addSystemMsg(cid, statuses);
        } catch { addSystemMsg(cid, t("cmd.status.unavail")); }
        return true;
      }
      case "help": {
        addSystemMsg(cid, t("cmd.help"));
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
    addSystemMsg(activeConvId.value, enabled ? t("plan.on") : t("plan.off"));
  };

  const handleToggleBypass = (enabled: boolean) => {
    if (!activeConvId.value) return;
    toggleBypassPermissions(activeConvId.value, enabled, PORT);
    addSystemMsg(activeConvId.value, enabled ? t("bypass.on") : t("bypass.off"));
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
      setUpdateInfo((prev) => prev ? { ...prev, checking: false } : null);
    }
  };

  useEffect(() => {
    checkUpdate();
    const timer = setInterval(checkUpdate, 30 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const handleUpdate = () => {
    const url = updateInfo?.macUrl || updateInfo?.winUrl;
    if (url) window.open(url, "_blank");
  };

  const isStreaming = active?.status === "Thinking..." || active?.status === "Streaming..." || active?.agentStatus === "warming";

  // Onboarding card descriptions
  const onboardCards = [
    { icon: "🔍", titleKey: "onboard.analyzeTitle", descKey: "onboard.analyzeDesc", text: t("onboard.analyzeDesc") },
    { icon: "📝", titleKey: "onboard.docTitle", descKey: "onboard.docDesc", text: t("onboard.docDesc") },
    { icon: "🐛", titleKey: "onboard.debugTitle", descKey: "onboard.debugDesc", text: t("onboard.debugDesc") },
    { icon: "🌐", titleKey: "onboard.searchTitle", descKey: "onboard.searchDesc", text: t("onboard.searchDesc") },
  ];

  return (
    <div class="app">
      <div class="lang-bar">
        <button class="lang-btn" onClick={toggleLang} title="Switch language / 切换语言">
          {t("lang.switch")}
        </button>
      </div>
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
            <span>{(() => {
              const s = active.status;
              if (s === "Ready") return t("status.ready");
              if (s === "Connecting...") return t("status.connecting");
              if (s === "Thinking...") return t("status.thinking");
              if (s === "Streaming...") return t("status.streaming");
              if (s.startsWith("Reconnecting")) return t("status.reconnecting");
              if (s === "Connection lost — refresh to retry") return t("status.connectionLost");
              if (s === "Restored") return t("status.restored");
              return s;
            })()}</span>
            <div style="display:flex;gap:8px;align-items:center">
              {updateInfo?.hasUpdate && (
                <button class="update-btn" onClick={handleUpdate} title={`v${updateInfo.current} → v${updateInfo.latest}. Click to download.`}>
                  {t("misc.update", { version: updateInfo.latest })}
                </button>
              )}
              <a
                href="https://shieldyh.com"
                target="_blank"
                class="upgrade-btn"
                title="Get Pro: 200+ skills, auto-start, 3 devices"
              >
                {t("misc.upgrade")}
              </a>
              {active.agentStatus === "warming" && (
                <span class="status-bar-agent">⟳ {t("agent.warmingShort")} {warmingSec}s（通常 15-30s）</span>
              )}
              {active.pendingPermission && (
                <span class="status-bar-pending">⏳ {t("status.permissionReq")}</span>
              )}
              {!active.connected && (
                <span class="status-bar-pending disconnected">{t("misc.reconnecting")}</span>
              )}
            </div>
          </footer>
        </>
      ) : (
        <main class="main">
          <div class="empty-state">
            <h2>{t("app.title")}</h2>
            <p class="empty-subtitle">{t("app.subtitle")}</p>
            <div class="onboard-grid">
              {onboardCards.map((card) => (
                <div class="onboard-card" key={card.descKey} onClick={() => {
                  newConversation(PORT);
                  setTimeout(() => {
                    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
                    if (ta) { ta.value = card.text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
                  }, 500);
                }}>
                  <span class="onboard-icon">{card.icon}</span>
                  <strong>{t(card.titleKey)}</strong>
                  <span>{t(card.descKey)}</span>
                </div>
              ))}
            </div>
            <p class="empty-hint">{t("misc.emptyHint")}</p>
          </div>
        </main>
      )}
    </div>
  );
}
