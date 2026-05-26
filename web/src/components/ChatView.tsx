import { useRef, useEffect, useState } from "preact/hooks";
import { MessageBubble } from "./MessageBubble";
import type { Message, PermissionRequest } from "../store";
import { t } from "../i18n";

interface Props {
  messages: Message[];
  pendingPermission: PermissionRequest | null;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onToggleThinking?: (msgId: string) => void;
}

function ToolSummary({ tools }: { tools: Message[] }) {
  const [expanded, setExpanded] = useState(false);
  const running = tools.filter((t) => t.toolStatus !== "done");
  const done = tools.filter((t) => t.toolStatus === "done");

  return (
    <div class="tool-summary">
      {running.map((t) => (
        <div key={t.id} class="tool-line tool-running">
          <span class="tool-icon">⟳</span>
          <span class="tool-name">{t.toolName}</span>
          <span class="tool-detail">{t.content.replace(/^[^:]+:\s*/, "")}</span>
        </div>
      ))}
      {done.length > 0 && (
        <button class="tool-done-toggle" onClick={() => setExpanded(!expanded)}>
          {t("tool.completedCount", { n: done.length })}
          <span class="tool-chevron">{expanded ? " ▾" : " ▸"}</span>
        </button>
      )}
      {expanded && done.map((t) => (
        <div key={t.id} class="tool-line tool-done tool-done-expanded">
          <span class="tool-name">{t.toolName}</span>
          <span class="tool-detail">{t.content.replace(/^[^:]+:\s*/, "")}</span>
        </div>
      ))}
    </div>
  );
}

export function ChatView({
  messages,
  pendingPermission,
  onApprove,
  onDeny,
  onToggleThinking,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const userMsgCount = messages.filter((m) => m.role === "user").length;
  const scrollKey = `${userMsgCount}`;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollKey]);

  const groups: (Message | { type: "tools"; tools: Message[] })[] = [];
  let toolBuffer: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      toolBuffer.push(msg);
    } else {
      if (toolBuffer.length > 0) {
        groups.push({ type: "tools", tools: [...toolBuffer] });
        toolBuffer = [];
      }
      groups.push(msg);
    }
  }
  if (toolBuffer.length > 0) {
    groups.push({ type: "tools", tools: toolBuffer });
  }

  return (
    <div class="chat-view">
      {groups.length === 0 && (
        <div class="empty-state">
          <h2>{t("misc.emptyChat")}</h2>
          <p>{t("misc.emptyDesc")}</p>
        </div>
      )}
      {groups.map((item) =>
        "type" in item ? (
          <ToolSummary key={item.tools[0].id} tools={item.tools} />
        ) : (
          <MessageBubble
            key={item.id}
            message={item}
            onToggleThinking={onToggleThinking}
          />
        )
      )}
      <div ref={bottomRef} />
    </div>
  );
}
