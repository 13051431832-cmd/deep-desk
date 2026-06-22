import { useRef, useState, useCallback, useEffect } from "preact/hooks";
import { t } from "../i18n";

interface Props {
  onSend: (text: string) => void;
  onCancel?: () => void;
  onCommand?: (cmd: string, arg: string) => boolean | Promise<boolean>;
  onImageChat: (imageFile: File, question: string, description: string) => Promise<void>;
  agentMode: boolean;
  agentStatus: "off" | "warming" | "on";
  onToggleAgent: (enabled: boolean) => void;
  onStopAgent: () => void;
  onStartAgent: () => void;
  isStreaming?: boolean;
  planMode: boolean;
  bypassPermissions: boolean;
  onTogglePlan: (enabled: boolean) => void;
  onToggleBypass: (enabled: boolean) => void;
  hasApiKey: boolean;
  onShowSettings: () => void;
}

interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
  description: string | null;
  filePath: string | null;
  originalPath: string | null;
  loading: boolean;
}

interface FileAttachment {
  id: string;
  file: File;
  content: string | null;
  loading: boolean;
  error: string | null;
}

// Extensions that are safe to read as text
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "js", "ts", "jsx", "tsx", "py", "rb", "go", "rs",
  "java", "c", "cpp", "h", "hpp", "cs", "swift", "kt", "scala", "r",
  "css", "scss", "less", "html", "htm", "xml", "svg", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "fish", "ps1",
  "bat", "cmd", "sql", "graphql", "gql", "env", "gitignore", "dockerfile",
  "editorconfig", "eslintrc", "prettierrc", "babelrc", "log",
  "vue", "svelte", "astro", "php", "pl", "pm", "lua", "dart", "ex", "exs",
  "erl", "hrl", "hs", "elm", "clj", "cljs", "edn", "coffee", "litcoffee",
]);

const MAX_TEXT_FILE_SIZE = 500 * 1024;
const MAX_BINARY_FILE_SIZE = 10 * 1024 * 1024;

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml" || file.type === "application/javascript") return true;
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return TEXT_EXTENSIONS.has(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(file: File): string {
  if (file.type.startsWith("image/")) return "🖼";
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    pdf: "📄", doc: "📝", docx: "📝", xls: "📊", xlsx: "📊", ppt: "📽", pptx: "📽",
    zip: "📦", tar: "📦", gz: "📦", rar: "📦", "7z": "📦",
    mp3: "🎵", wav: "🎵", mp4: "🎬", mov: "🎬", avi: "🎬",
    py: "🐍", js: "🟨", ts: "🔷", jsx: "⚛", tsx: "⚛", go: "🔵", rs: "🦀",
    java: "☕", rb: "💎", php: "🐘", swift: "🦅", kt: "🟣",
    html: "🌐", css: "🎨", json: "📋", md: "📖", sql: "🗄",
    sh: "💻", bash: "💻", zsh: "💻", yaml: "⚙", yml: "⚙", toml: "⚙",
  };
  return map[ext] || "📎";
}

export function InputBox({ onSend, onCancel, onCommand, onImageChat, agentMode, agentStatus, onToggleAgent, onStopAgent, onStartAgent, isStreaming, planMode, bypassPermissions, onTogglePlan, onToggleBypass, hasApiKey, onShowSettings }: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const tauriDropHandled = useRef(false);
  const [inputText, setInputText] = useState("");
  const isComposing = useRef(false);

  const describeImage = async (img: ImageAttachment) => {
    try {
      const formData = new FormData();
      formData.append("image", img.file);
      const resp = await fetch("/api/vision", { method: "POST", body: formData });
      const data = await resp.json();
      if (data.ok) {
        setImages((prev) => prev.map((i) =>
          i.id === img.id ? { ...i, description: data.description, filePath: data.filePath || null, loading: false } : i
        ));
      } else {
        setImages((prev) => prev.map((i) =>
          i.id === img.id ? { ...i, description: `Error: ${data.error}`, loading: false } : i
        ));
      }
    } catch (err: any) {
      setImages((prev) => prev.map((i) =>
        i.id === img.id ? { ...i, description: `Error: ${err.message}`, loading: false } : i
      ));
    }
  };

  const addImage = (file: File, originalPath?: string) => {
    const img: ImageAttachment = {
      id: Math.random().toString(36).slice(2, 8),
      file,
      previewUrl: URL.createObjectURL(file),
      description: null,
      filePath: null,
      originalPath: originalPath || null,
      loading: true,
    };
    setImages((prev) => [...prev, img]);
    describeImage(img);
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((i) => i.id !== id));
  };

  const readTextFile = (fa: FileAttachment) => {
    const reader = new FileReader();
    reader.onload = () => {
      setFiles((prev) => prev.map((f) =>
        f.id === fa.id ? { ...f, content: reader.result as string, loading: false } : f
      ));
    };
    reader.onerror = () => {
      setFiles((prev) => prev.map((f) =>
        f.id === fa.id ? { ...f, error: "Failed to read file", loading: false } : f
      ));
    };
    reader.readAsText(fa.file);
  };

  const uploadFile = async (fa: FileAttachment) => {
    try {
      const formData = new FormData();
      formData.append("file", fa.file);
      const resp = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await resp.json();
      if (data.ok) {
        let content = `[File path: ${data.path}]\n`;
        if (data.textPreview) {
          const ext = fa.file.name.split(".").pop()?.toLowerCase() || "";
          content += `\`\`\`${ext}\n${data.textPreview}${data.textPreview.length >= 5000 ? "\n...(truncated)" : ""}\n\`\`\``;
        } else {
          content += `(Binary file — use Read tool with the path above to read it)`;
        }
        setFiles((prev) => prev.map((f) =>
          f.id === fa.id ? { ...f, content, loading: false } : f
        ));
      } else {
        setFiles((prev) => prev.map((f) =>
          f.id === fa.id ? { ...f, error: data.error || "Upload failed", loading: false } : f
        ));
      }
    } catch (err: any) {
      setFiles((prev) => prev.map((f) =>
        f.id === fa.id ? { ...f, error: err.message || "Upload failed", loading: false } : f
      ));
    }
  };

  const addFile = (file: File) => {
    const isText = isTextFile(file);
    const maxSize = isText ? MAX_TEXT_FILE_SIZE : MAX_BINARY_FILE_SIZE;
    if (file.size > maxSize) {
      const fa: FileAttachment = {
        id: Math.random().toString(36).slice(2, 8),
        file, content: null, loading: false,
        error: `File too large (max ${formatSize(maxSize)})`,
      };
      setFiles((prev) => [...prev, fa]);
      return;
    }

    const fa: FileAttachment = {
      id: Math.random().toString(36).slice(2, 8),
      file, content: null, loading: true, error: null,
    };
    setFiles((prev) => [...prev, fa]);

    if (isText) {
      readTextFile(fa);
    } else {
      uploadFile(fa);
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const doSend = () => {
    const text = inputRef.current?.value.trim() || "";
    const hasImages = images.length > 0 && images.some((i) => i.description);
    const hasFiles = files.length > 0;

    // Require API key before sending
    if (!hasApiKey) {
      onShowSettings();
      return;
    }

    // Image-only messages: use direct QWEN → DeepSeek chat (bypass CCB)
    if (hasImages && !hasFiles) {
      const firstImg = images.find((i) => i.description && !i.description.startsWith("Error"));
      if (firstImg) {
        const q = text || "请描述这张图片";
        if (inputRef.current) { inputRef.current.value = ""; setInputText(""); }
        for (const img of images) URL.revokeObjectURL(img.previewUrl);
        setImages([]);
        onImageChat(firstImg.file, q, firstImg.description!);
        return;
      }
    }

    if (text.startsWith("/") && !hasImages && !hasFiles) {
      const space = text.indexOf(" ");
      const cmd = space > 0 ? text.slice(1, space) : text.slice(1);
      const arg = space > 0 ? text.slice(space + 1).trim() : "";
      const cmdResult = onCommand?.(cmd, arg);
      if (cmdResult) {
        if (inputRef.current) { inputRef.current.value = ""; setInputText(""); }
        if (cmdResult instanceof Promise) {
          cmdResult.then((handled) => { if (!handled) onSend(text); });
        }
        return;
      }
    }

    if (!text && !hasImages && !hasFiles) return;

    let fullText = "";

    for (const f of files) {
      if (f.error) {
        fullText += `[File: ${f.file.name} — ${f.error}]\n\n`;
      } else if (f.content) {
        if (f.content.startsWith("[File path:")) {
          fullText += f.content + "\n\n";
        } else {
          const ext = f.file.name.split(".").pop()?.toLowerCase() || "";
          fullText += `[File: ${f.file.name}]\n\`\`\`${ext}\n${f.content}\n\`\`\`\n\n`;
        }
      }
    }

    for (const img of images) {
      if (img.description && !img.description.startsWith("Error")) {
        if (img.originalPath) {
          fullText += `[Image: ${img.originalPath}]\n${img.description}\n\n`;
        } else {
          fullText += `[Image: ${img.file.name}]\n${img.description}\n\n`;
        }
      }
    }

    if (text) fullText += text;
    if (!fullText.trim()) return;

    onSend(fullText.trim());

    if (inputRef.current) { inputRef.current.value = ""; setInputText(""); }
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    setImages([]);
    setFiles([]);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    doSend();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      doSend();
    }
  };

  const handleInput = () => {
    setInputText(inputRef.current?.value || "");
  };

  const isImageFile = (f: File) => {
    if (f.type.startsWith("image/")) return true;
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    return new Set(["jpg","jpeg","png","gif","webp","bmp","svg","ico","tiff","tif","heic","heif"]).has(ext);
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          if (isImageFile(file)) addImage(file);
          else addFile(file);
        }
      } else if (item.kind === "image" || (item.kind === "string" && item.type.startsWith("image/"))) {
        // Raw image data from clipboard (e.g., screenshots on some platforms)
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const ext = item.type.split("/")[1] || "png";
          const file = new File([blob], `clipboard.${ext}`, { type: item.type });
          addImage(file);
        }
      }
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    // If Tauri native handler already processed this drop, skip DOM path
    if (tauriDropHandled.current) return;
    const droppedFiles = e.dataTransfer?.files;
    if (!droppedFiles) return;
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i];
      if (isImageFile(file)) addImage(file);
      else addFile(file);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  // Listen for Tauri-native file drops (forwarded from Rust)
  useEffect(() => {
    const IMG_EXT = new Set(["jpg","jpeg","png","gif","webp","bmp","svg","ico","tiff","tif","heic","heif"]);
    (window as any).__tauri_drop = async (paths: string[]) => {
      tauriDropHandled.current = true;
      console.log("[tauri-drop] received paths:", paths);
      try {
        const resp = await fetch("/api/drop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
        });
        const data = await resp.json();
        if (data.ok && data.files) {
          for (const f of data.files) {
            if (f.error) {
              setFiles((prev) => [...prev, {
                id: Math.random().toString(36).slice(2, 8),
                file: new File([], f.name),
                content: `Error: ${f.error}`,
                loading: false,
                error: f.error,
              }]);
              continue;
            }
            const ext = f.name.split(".").pop()?.toLowerCase() || "";
            if (IMG_EXT.has(ext)) {
              // Fetch image data and route through QWEN Vision
              try {
                const imgResp = await fetch(`/api/file?path=${encodeURIComponent(f.path)}`);
                if (imgResp.ok) {
                  const blob = await imgResp.blob();
                  const file = new File([blob], f.name, { type: blob.type || `image/${ext}` });
                  addImage(file, f.path);
                  console.log("[tauri-drop] image added via QWEN path:", f.path);
                }
              } catch (e) { console.error("[tauri-drop] fetch image failed:", e); }
            } else {
              setFiles((prev) => [...prev, {
                id: Math.random().toString(36).slice(2, 8),
                file: new File([], f.name),
                content: f.textPreview || `[File path: ${f.path}]`,
                loading: false,
                error: null,
              }]);
            }
          }
        }
      } catch (e) { console.error("[tauri-drop] failed:", e); }
      // Reset flag after a short delay so subsequent drops work
      setTimeout(() => { tauriDropHandled.current = false; }, 500);
    };
    return () => { delete (window as any).__tauri_drop; };
  }, []);

  const handleFileSelect = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const f = input.files;
    if (!f) return;
    for (let i = 0; i < f.length; i++) {
      const file = f[i];
      if (isImageFile(file)) addImage(file);
      else addFile(file);
    }
    input.value = "";
  };

  const allImagesReady = images.every((i) => !i.loading);
  const allFilesReady = files.every((f) => !f.loading);
  const allReady = allImagesReady && allFilesReady;
  const hasContent = inputText.trim() || images.some((i) => i.description && !i.description!.startsWith("Error")) || files.some((f) => f.content && !f.error);
  const canSend = hasContent && allReady;
  const attachmentCount = images.length + files.length;

  return (
    <div class="input-area">
      <div class="mode-bar">
        {/* Agent Mode toggle */}
        <label class={`mode-chip ${agentMode ? "mode-chip--active" : ""}`}>
          <input
            type="checkbox"
            checked={agentMode}
            onChange={(e) => onToggleAgent((e.target as HTMLInputElement).checked)}
            style="display:none"
          />
          <span class="mode-chip-icon">🤖</span>
          <span class="mode-chip-label">Agent</span>
          <span class="mode-chip-badge">{agentStatus === "warming" ? "⟳" : agentMode ? t("agent.on") : t("agent.off")}</span>
        </label>
        <span class="agent-hint">
          {agentStatus === "warming"
            ? t("agent.warming")
            : agentMode && agentStatus === "on"
            ? t("agent.toolsHint")
            : agentMode
            ? t("agent.readyHint")
            : ""}
        </span>

        {/* Plan Mode toggle — only meaningful when agent is active */}
        {agentMode && agentStatus !== "off" && (
        <label class={`mode-chip ${planMode ? "mode-chip--plan" : ""}`} title="Plan first, then implement after approval">
          <input
            type="checkbox"
            checked={planMode}
            onChange={(e) => onTogglePlan((e.target as HTMLInputElement).checked)}
            style="display:none"
          />
          <span class="mode-chip-icon">📋</span>
          <span class="mode-chip-label">{t("plan.label")}</span>
          <span class="mode-chip-badge">{planMode ? t("agent.on") : t("agent.off")}</span>
        </label>
        )}

        {/* Bypass Permissions toggle — only meaningful when agent is active */}
        {agentMode && agentStatus !== "off" && (
        <label class={`mode-chip ${bypassPermissions ? "mode-chip--bypass" : ""}`} title="Skip tool confirmation prompts (restarts session)">
          <input
            type="checkbox"
            checked={bypassPermissions}
            onChange={(e) => onToggleBypass((e.target as HTMLInputElement).checked)}
            style="display:none"
          />
          <span class="mode-chip-icon">⚡</span>
          <span class="mode-chip-label">{t("bypass.label")}</span>
          <span class="mode-chip-badge">{bypassPermissions ? t("agent.on") : t("agent.off")}</span>
        </label>
        )}

        <div style="flex:1" />

        {agentMode && agentStatus !== "off" && (
          agentStatus === "warming" ? (
            <button class="mode-btn mode-btn--warming" disabled>
              {t("agent.starting")}
            </button>
          ) : (
            <button class="mode-btn mode-btn--stop" onClick={onStopAgent} title="Stop the agent process for this tab">
              {t("agent.stop")}
            </button>
          )
        )}
        {agentMode && agentStatus === "off" && (
          <button class="mode-btn mode-btn--start" onClick={onStartAgent} title="Start the agent process for this tab">
            {t("agent.start")}
          </button>
        )}
        <label class="image-upload-btn" title={t("attach.upload")}>
          📎
          <input type="file" multiple onChange={handleFileSelect} style="display:none" />
        </label>
      </div>

      {/* Image previews */}
      {images.length > 0 && (
        <div class="attachment-bar">
          {images.map((img) => (
            <div key={img.id} class={`attachment-card ${img.loading ? "loading" : img.description?.startsWith("Error") ? "error" : "ready"}`}>
              <img src={img.previewUrl} alt="" class="attachment-card-img" />
              <button class="attachment-remove" onClick={() => removeImage(img.id)}>×</button>
              <div class="attachment-status">
                {img.loading ? t("attach.analyzing") : img.description?.startsWith("Error") ? t("attach.error") : t("attach.ready")}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* File previews */}
      {files.length > 0 && (
        <div class="attachment-bar">
          {files.map((f) => (
            <div key={f.id} class={`attachment-card attachment-card--file ${f.loading ? "loading" : f.error ? "error" : "ready"}`}>
              <div class="attachment-file-icon">{fileIcon(f.file)}</div>
              <div class="attachment-file-name">{f.file.name}</div>
              <div class="attachment-file-size">{formatSize(f.file.size)}</div>
              <button class="attachment-remove" onClick={() => removeFile(f.id)}>×</button>
              <div class="attachment-status">
                {f.loading ? t("attach.reading") : f.error ? f.error : t("attach.ready")}
              </div>
            </div>
          ))}
        </div>
      )}

      <form class="input-box" onSubmit={handleSubmit} onDragOver={handleDragOver} onDrop={handleDrop}>
        <textarea
          ref={inputRef}
          class="input-box-textarea"
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }}
          placeholder={
            attachmentCount > 0
              ? t("input.placeholderAttach")
              : agentMode
              ? t("input.placeholderAgent")
              : t("input.placeholderFast")
          }
          rows={2}
        />
        <button type="submit" class="input-box-send" disabled={!canSend}>
          {t("input.send")}
        </button>
        {isStreaming && (
          <button type="button" class="input-box-stop" onClick={() => onCancel?.()}>
            {t("input.stop")}
          </button>
        )}
      </form>
    </div>
  );
}
