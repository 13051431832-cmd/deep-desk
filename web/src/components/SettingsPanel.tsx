import { useState, useEffect } from "preact/hooks";

interface MCPInfo { enabled: boolean; description: string; }

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"provider" | "mcp">("provider");
  // Provider
  const [provider, setProvider] = useState<"deepseek" | "ollama">("deepseek");
  // DeepSeek keys
  const [deepseekKey, setDeepseekKey] = useState("");
  const [qwenKey, setQwenKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"loading" | "ready" | "saving" | "saved">("loading");
  // Ollama
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434/v1");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaDetecting, setOllamaDetecting] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState("");
  // MCP
  const [mcpServers, setMcpServers] = useState<Record<string, MCPInfo>>({});
  const [mcpLoading, setMcpLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => {
        setProvider(d.provider || "deepseek");
        setDeepseekKey(d.deepseekKey ? "••••configured" : "");
        if (d.ollamaModel) setOllamaModel(d.ollamaModel);
        if (d.ollamaUrl) setOllamaUrl(d.ollamaUrl);
        setKeyStatus("ready");
      })
      .catch(() => setKeyStatus("ready"));
    fetch("/api/mcp")
      .then(r => r.json())
      .then(d => { setMcpServers(d.servers || {}); setMcpLoading(false); })
      .catch(() => setMcpLoading(false));
  }, []);

  const saveDeepSeek = async () => {
    setKeyStatus("saving");
    try {
      const resp = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", deepseekKey: deepseekKey.startsWith("••••") ? undefined : (deepseekKey || undefined), qwenKey: qwenKey || undefined }),
      });
      if (resp.ok) { setKeyStatus("saved"); setDeepseekKey("••••configured"); setQwenKey(""); }
    } catch { setKeyStatus("ready"); }
  };

  const saveOllama = async () => {
    setOllamaStatus("saving");
    try {
      const resp = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "ollama", ollamaModel, ollamaUrl }),
      });
      if (resp.ok) { setOllamaStatus("✓ 已保存，新对话生效"); setProvider("ollama"); }
    } catch { setOllamaStatus("保存失败"); }
    setTimeout(() => setOllamaStatus(""), 2000);
  };

  const detectOllama = async () => {
    setOllamaDetecting(true); setOllamaStatus("");
    try {
      const resp = await fetch("/api/ollama/models");
      const data = await resp.json();
      if (data.ok && data.models.length > 0) {
        setOllamaModels(data.models);
        if (!ollamaModel) setOllamaModel(data.models[0]);
        setOllamaStatus(`检测到 ${data.models.length} 个模型`);
      } else {
        setOllamaStatus("未检测到 Ollama，请确认已安装并运行");
      }
    } catch { setOllamaStatus("连接失败"); }
    setOllamaDetecting(false);
  };

  const toggleMcp = async (name: string, enabled: boolean) => {
    setMcpServers(prev => ({ ...prev, [name]: { ...prev[name], enabled } }));
    await fetch("/api/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toggles: { [name]: enabled } }),
    });
  };

  return (
    <div class="settings-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("settings-overlay")) onClose(); }}>
      <div class="settings-panel">
        <div class="settings-header">
          <h3>⚙ Settings</h3>
          <button class="settings-close" onClick={onClose}>×</button>
        </div>

        <div class="settings-tabs">
          <button class={`settings-tab ${tab === "provider" ? "settings-tab--active" : ""}`} onClick={() => setTab("provider")}>🧠 Model</button>
          <button class={`settings-tab ${tab === "mcp" ? "settings-tab--active" : ""}`} onClick={() => setTab("mcp")}>🔌 MCP</button>
        </div>

        {tab === "provider" && (
          <div>
            <label class="settings-field">
              <span>Provider</span>
              <select class="settings-select" value={provider} onChange={(e) => setProvider((e.target as HTMLSelectElement).value as any)}>
                <option value="deepseek">☁️ DeepSeek API (云端)</option>
                <option value="ollama">🦙 Ollama (本地)</option>
              </select>
            </label>

            {provider === "deepseek" && (
              <>
                <label class="settings-field">
                  <span>DeepSeek API Key</span>
                  <input type="password" placeholder="sk-..." value={deepseekKey} onInput={(e) => setDeepseekKey((e.target as HTMLInputElement).value)} />
                </label>
                <label class="settings-field">
                  <span>QWEN Vision Key <em style="color:var(--text-muted)">(optional)</em></span>
                  <input type="password" placeholder="sk-..." value={qwenKey} onInput={(e) => setQwenKey((e.target as HTMLInputElement).value)} />
                </label>
                <button class="settings-save" onClick={saveDeepSeek} disabled={keyStatus === "saving" || !deepseekKey}>
                  {keyStatus === "saving" ? "Saving..." : keyStatus === "saved" ? "✓ Saved" : "使用 DeepSeek API"}
                </button>
              </>
            )}

            {provider === "ollama" && (
              <>
                <button class="settings-save" onClick={detectOllama} disabled={ollamaDetecting} style="margin-bottom:12px;background:var(--bg-card);color:var(--accent);border:1px solid var(--accent)">
                  {ollamaDetecting ? "检测中..." : "🔍 检测本地模型"}
                </button>
                {ollamaStatus && <p class="settings-note" style="color:var(--accent);margin-bottom:8px">{ollamaStatus}</p>}
                {ollamaModels.length > 0 && (
                  <label class="settings-field">
                    <span>选择模型</span>
                    <select class="settings-select" value={ollamaModel} onChange={(e) => setOllamaModel((e.target as HTMLSelectElement).value)}>
                      {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                )}
                {!ollamaModels.length && (
                  <label class="settings-field">
                    <span>模型名称</span>
                    <input type="text" placeholder="llama3.2" value={ollamaModel} onInput={(e) => setOllamaModel((e.target as HTMLInputElement).value)} />
                  </label>
                )}
                <button class="settings-save" onClick={saveOllama} disabled={!ollamaModel}>
                  使用本地 {ollamaModel || "模型"}
                </button>
                <p class="settings-note">
                  安装：<code>brew install ollama && ollama serve</code> | 下载模型：<code>ollama pull llama3.2</code>
                </p>
              </>
            )}
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
            <p class="settings-note">修改后需重启当前对话（新 Agent 会话生效）</p>
          </div>
        )}
      </div>
    </div>
  );
}
