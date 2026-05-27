import { useState, useEffect } from "preact/hooks";
import { t } from "../i18n";

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const [deepseekKey, setDeepseekKey] = useState("");
  const [qwenKey, setQwenKey] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved">("loading");
  const [hasConfig, setHasConfig] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => {
        setHasConfig(!!d.deepseekKey || !!d.qwenKey);
        setStatus("ready");
      })
      .catch(() => setStatus("ready"));
  }, []);

  const save = async () => {
    setStatus("saving");
    try {
      const resp = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deepseekKey: deepseekKey || undefined,
          qwenKey: qwenKey || undefined,
        }),
      });
      if (resp.ok) {
        setStatus("saved");
        setHasConfig(true);
        setDeepseekKey("");
        setQwenKey("");
      }
    } catch { setStatus("ready"); }
  };

  return (
    <div class="settings-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("settings-overlay")) onClose(); }}>
      <div class="settings-panel">
        <div class="settings-header">
          <h3>⚙ API Keys</h3>
          <button class="settings-close" onClick={onClose}>×</button>
        </div>

        <p class="settings-desc">
          {t("settings.desc")}
        </p>

        <label class="settings-field">
          <span>DeepSeek API Key {hasConfig ? "✅" : "⚠️"}</span>
          <input
            type="password"
            placeholder={hasConfig ? "Already configured" : "sk-..."}
            value={deepseekKey}
            onInput={(e) => setDeepseekKey((e.target as HTMLInputElement).value)}
          />
        </label>

        <label class="settings-field">
          <span>QWEN Vision Key <em style="color:var(--text-muted)">(optional)</em></span>
          <input
            type="password"
            placeholder="sk-..."
            value={qwenKey}
            onInput={(e) => setQwenKey((e.target as HTMLInputElement).value)}
          />
        </label>

        <button
          class="settings-save"
          onClick={save}
          disabled={status === "saving" || (!deepseekKey && !qwenKey)}
        >
          {status === "saving" ? "Saving..." : status === "saved" ? "✓ Saved" : "Save"}
        </button>

        <p class="settings-note">
          Keys are saved to <code>~/.deepdesk.env</code>. Restart the conversation after saving.
        </p>
      </div>
    </div>
  );
}
