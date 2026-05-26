import type { Message } from "../store";
import { useRef, useEffect, useMemo } from "preact/hooks";

interface Props {
  message: Message;
  onToggleThinking?: (msgId: string) => void;
}

function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n/g, "<br/>");
  return html;
}

export function MessageBubble({ message, onToggleThinking }: Props) {
  if (message.role === "tool") {
    const icon = message.toolStatus === "done" ? "✓" : "⟳";
    const cls = message.toolStatus === "done" ? "tool-done" : "tool-running";
    return (
      <div class="message message--tool">
        <div class={`tool-badge ${cls}`}>
          <span class="tool-icon">{icon}</span>
          <span class="tool-name">{message.toolName}</span>
          <span class="tool-detail">{message.content.replace(/^[^:]+:\s*/, "")}</span>
        </div>
      </div>
    );
  }

  const htmlContent = useMemo(
    () => renderMarkdown(message.content),
    [message.content]
  );

  const hasThinking = (message.thinkingContent?.length || 0) > 3;
  const isActive = message.status === "thinking" || message.status === "streaming";
  // Auto-expand thinking while AI is working; collapse when done
  const expanded = message.thinkingVisible ?? isActive;

  const thinkingEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) thinkingEndRef.current?.scrollIntoView();
  }, [message.thinkingContent, isActive]);

  return (
    <div class={`message message--${message.role}`}>
      <div class="message-bubble">
        {message.role !== "system" && (
          <div class="message-role">
            {message.role === "user" ? "You" : "Claude"}
          </div>
        )}

        {/* Thinking stream — auto-expanded while active */}
        {hasThinking && (
          <div class="thinking-block">
            <button
              class="thinking-toggle"
              onClick={() => onToggleThinking?.(message.id)}
            >
              {expanded ? "▾" : "▸"} 🤔 Thinking
              {!isActive && (
                <span class="thinking-preview">
                  {message.thinkingContent!.slice(0, 60)}
                  {(message.thinkingContent!.length > 60) ? "..." : ""}
                </span>
              )}
            </button>
            {expanded && (
              <div class="thinking-content">
                {message.thinkingContent}
                {isActive && <span class="thinking-cursor">▊</span>}
                <div ref={thinkingEndRef} />
              </div>
            )}
          </div>
        )}

        {/* Thinking indicator when no content yet */}
        {!hasThinking && isActive && (
          <div class="message-thinking-live">
            <span class="thinking-dot" />
            Thinking...
          </div>
        )}

        <div
          class="message-content"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      </div>
    </div>
  );
}
