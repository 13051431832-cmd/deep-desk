import { useState, useEffect } from "preact/hooks";
import { checkProStatus, isPro } from "../store";

interface MCPInfo { enabled: boolean; description: string; }

const isWin = navigator.platform.toLowerCase().includes("win");
const isMac = !isWin && navigator.platform.toLowerCase().includes("mac");

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"keys" | "mcp" | "license">("keys");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [qwenKey, setQwenKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"loading" | "ready" | "saving" | "saved">("loading");
  const [hasConfig, setHasConfig] = useState(false);
  const [mcpServers, setMcpServers] = useState<Record<string, MCPInfo>>({});
  const [mcpLoading, setMcpLoading] = useState(true);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseStatus, setLicenseStatus] = useState<"idle" | "activating" | "success" | "alreadyPro" | "error">("idle");
  const [licenseError, setLicenseError] = useState("");
  const [iapLoading, setIapLoading] = useState(false);
  const [iapStatus, setIapStatus] = useState<"idle" | "loading" | "waiting" | "success" | "error">("idle");
  const [iapError, setIapError] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => { setHasConfig(!!d.deepseekKey || !!d.qwenKey); setKeyStatus("ready"); })
      .catch(() => setKeyStatus("ready"));
    fetch("/api/mcp")
      .then(r => r.json())
      .then(d => { setMcpServers(d.servers || {}); setMcpLoading(false); })
      .catch(() => setMcpLoading(false));

    // Listen for StoreKit purchase results (emitted by Rust transaction observer)
    let unlisten: (() => void) | undefined;
    if (isMac) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen("purchase-updated", (event: { payload: string }) => {
          if (event.payload === "purchased" || event.payload === "restored") {
            setIapStatus("success");
            checkProStatus();
          } else if (event.payload === "failed") {
            setIapStatus("error");
            setIapError("Payment failed or was cancelled.");
          }
        }).then(fn => { unlisten = fn; });
      }).catch(() => {});
    }

    return () => { unlisten?.(); };
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

  const activateLicense = async () => {
    if (!licenseKey.trim()) return;
    setLicenseStatus("activating");
    setLicenseError("");
    try {
      const resp = await fetch("/api/license/redeem", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: licenseKey.trim(), package: "deepdesk-pro" }),
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        await checkProStatus();
        setLicenseStatus("success");
        setLicenseKey("");
      } else if (resp.ok && data.alreadyPro) {
        setLicenseStatus("alreadyPro");
      } else {
        setLicenseStatus("error");
        setLicenseError(data.error || "Activation failed");
      }
    } catch {
      setLicenseStatus("error");
      setLicenseError("Network error — check your connection");
    }
  };

  const purchasePro = async () => {
    setIapLoading(true);
    setIapStatus("loading");
    setIapError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("purchase_pro");
      // Payment sheet presented — wait for transaction observer event
      setIapStatus("waiting");
    } catch (e: any) {
      setIapStatus("error");
      const msg: string = typeof e === "string" ? e : e?.message || "Purchase failed";
      // Distinguish user cancellation from genuine failures
      if (/cancel|2$/i.test(msg)) {
        setIapError("Purchase cancelled — you can try again anytime.");
      } else if (/parental|restrict|disable|not allowed/i.test(msg)) {
        setIapError("Purchases restricted — check Screen Time settings.");
      } else {
        setIapError(msg);
      }
    } finally {
      setIapLoading(false);
    }
  };

  const restorePurchases = async () => {
    setIapLoading(true);
    setIapStatus("loading");
    setIapError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restore_purchases");
      // Restore dialog presented — wait for transaction observer event
      setIapStatus("waiting");
    } catch (e: any) {
      setIapStatus("error");
      setIapError(typeof e === "string" ? e : e?.message || "Restore failed");
    } finally {
      setIapLoading(false);
    }
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
          <button class={`settings-tab ${tab === "license" ? "settings-tab--active" : ""}`} onClick={() => setTab("license")}>📜 License</button>
        </div>

        {tab === "keys" && (
          <div>
            <label class="settings-field">
              <span>DeepSeek API Key {hasConfig ? "✅" : "⚠️"}</span>
              <input type="password" placeholder={hasConfig ? "Already configured" : "sk-..."} value={deepseekKey} onInput={(e) => setDeepseekKey((e.target as HTMLInputElement).value)} />
            </label>
            <label class="settings-field">
              <span>QWEN Vision Key <em style="color:var(--text-muted)">(optional/可选，用于识别图像)</em></span>
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

        {tab === "license" && (
          <div>
            {isMac ? (
              <>
                <p class="settings-desc">Buy Pro via In-App Purchase to unlock MCP servers and 200+ skills.</p>
                {isPro.value ? (
                  <p class="license-ok">✓ You are Pro — all paid features are unlocked.</p>
                ) : (
                  <div class="license-form" style="flex-direction:column;gap:10px">
                    <button
                      class="settings-save"
                      onClick={purchasePro}
                      disabled={iapLoading}
                      style="width:100%"
                    >
                      {iapLoading && iapStatus === "loading" ? "Purchasing..." : "Buy Pro — $4.99"}
                    </button>
                    <button
                      class="settings-save"
                      onClick={restorePurchases}
                      disabled={iapLoading}
                      style="width:100%;background:var(--surface-alt);color:var(--text)"
                    >
                      Restore Purchases
                    </button>
                  </div>
                )}
                {iapStatus === "waiting" && <p class="license-ok">⏳ Waiting for payment confirmation...</p>}
                {iapStatus === "success" && <p class="license-ok">✓ Purchase complete — Pro features unlocked.</p>}
                {iapStatus === "error" && <p class="license-err">{iapError}</p>}
                <p class="settings-note">Purchase is tied to your Apple ID. Restore on any Mac with the same account.</p>
              </>
            ) : (
              <>
                <p class="settings-desc">Activate a Pro license to unlock MCP servers and 200+ skills.</p>
                <div class="license-form">
                  <input
                    type="text"
                    class="license-input"
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    value={licenseKey}
                    onInput={(e) => setLicenseKey((e.target as HTMLInputElement).value)}
                    disabled={licenseStatus === "activating" || licenseStatus === "success"}
                  />
                  <button
                    class="settings-save"
                    onClick={activateLicense}
                    disabled={licenseStatus === "activating" || licenseStatus === "success" || !licenseKey.trim()}
                  >
                    {licenseStatus === "activating" ? "Activating..." : licenseStatus === "success" ? "✓ Activated" : "Activate"}
                  </button>
                </div>
                {licenseStatus === "success" && <p class="license-ok">✓ Pro activated — restart your conversation to load paid skills.</p>}
                {licenseStatus === "alreadyPro" && <p class="license-ok">✓ Already Pro</p>}
                {licenseStatus === "error" && <p class="license-err">{licenseError}</p>}
                <p class="settings-note">Purchase a license at shieldyh.com</p>
              </>
            )}
          </div>
        )}

        {tab === "keys" && (
          <p class="settings-note">Keys are saved to <code>{isWin ? '%USERPROFILE%\\.deepdesk.env' : '~/.deepdesk.env'}</code>.</p>
        )}
      </div>
    </div>
  );
}
