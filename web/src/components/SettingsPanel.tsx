import { useState, useEffect } from "preact/hooks";

interface MCPInfo { enabled: boolean; description: string; }

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"keys" | "mcp">("keys");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [qwenKey, setQwenKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"loading" | "ready" | "saving" | "saved">("loading");
  const [hasConfig, setHasConfig] = useState(false);
  const [mcpServers, setMcpServers] = useState<Record<string, MCPInfo>>({});
  const [mcpLoading, setMcpLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => { setHasConfig(!!d.deepseekKey || !!d.qwenKey); setKeyStatus("ready"); })
      .catch(() => setKeyStatus("ready"));
    fetch("/api/mcp")
      .then(r => r.json())
      .then(d => { setMcpServers(d.servers || {}); setMcpLoading(false); })
      .catch(() => setMcpLoading(false));
  }, []);

  const saveKeys = async () => {
    setKeyStatus("saving");
    try {
      const resp = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deepseekKey: deepseekKey || undefined, qwenKey: qwenKey || undefined }),
      });
      if (resp.ok) { setKeyStatus("saved"); setHasConfig(true); setDeepseekKey(""); setQwenKey(""); }
    } catch { setKeyStatus("ready"); }
  };

  const toggleMcp = async (name: string, enabled: boolean) => {
    setMcpServers(prev => ({ ...prev, [name]: { ...prev[name], enabled } }));
    try {
      await fetch("/api/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toggles: { [name]: enabled } }),
      });
    } catch { /* revert on error */ }
  };

  return (
    <div class="settings-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("settings-overlay")) onClose(); }}>
      <div class="settings-panel">
        <div class="settings-header">
          <h3>⚙ Settings</h3>
          <button class="settings-close" onClick={onClose}>×</button>
        </div>

        <div class="settings-tabs">
          <button class={`settings-tab ${tab === "keys" ? "settings-tab--active" : ""}`} onClick={() => setTab("keys")}>🔑 Keys</button>
          <button class={`settings-tab ${tab === "mcp" ? "settings-tab--active" : ""}`} onClick={() => setTab("mcp")}>🔌 MCP</button>
        </div>

        {tab === "keys" && (
          <div>
            <label class="settings-field">
              <span>DeepSeek API Key {hasConfig ? "✅" : "⚠️"}</span>
              <input type="password" placeholder={hasConfig ? "Already configured" : "sk-..."} value={deepseekKey} onInput={(e) => setDeepseekKey((e.target as HTMLInputElement).value)} />
            </label>
            <label class="settings-field">
              <span>QWEN Vision Key <em style="color:var(--text-muted)">(optional)</em></span>
              <input type="password" placeholder="sk-..." value={qwenKey} onInput={(e) => setQwenKey((e.target as HTMLInputElement).value)} />
            </label>
            <button class="settings-save" onClick={saveKeys} disabled={keyStatus === "saving" || (!deepseekKey && !qwenKey)}>
              {keyStatus === "saving" ? "Saving..." : keyStatus === "saved" ? "✓ Saved" : "Save"}
            </button>
          </div>
        )}

        {tab === "mcp" && (
          <div>
            <p class="settings-desc">Pro 版内置 8 个 MCP Server。无需手动安装，一键开关。</p>
            {mcpLoading ? <p style="color:var(--text-muted)">Loading...</p> : (
              <div class="mcp-list">
                {Object.entries(mcpServers).map(([name, info]) => (
                  <label key={name} class="mcp-toggle">
                    <input type="checkbox" checked={info.enabled} onChange={(e) => toggleMcp(name, (e.target as HTMLInputElement).checked)} />
                    <span class="mcp-name">{name}</span>
                    <span class="mcp-desc">{info.description}</span>
                  </label>
                ))}
              </div>
            )}
            <p class="settings-note">修改后需关闭并重启当前对话（新 Agent 会话生效）</p>
          </div>
        )}

        {tab === "keys" && (
          <p class="settings-note">Keys are saved to <code>~/.deepdesk.env</code>.</p>
        )}
      </div>
    </div>
  );
}
