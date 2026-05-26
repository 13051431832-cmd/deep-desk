import { useState } from "preact/hooks";
import type { Conversation } from "../store";
import { t } from "../i18n";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export function ConversationTabs({
  conversations, activeId, onSelect, onNew, onClose, onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditValue(conv.title === t("tab.newChat") ? "" : conv.title);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditingId(null);
  };

  return (
    <header class="tabs-bar">
      <div class="tabs-list">
        {conversations.map((conv) => {
          const hasPermission = !!conv.pendingPermission;
          const isActive = conv.id === activeId;
          const isEditing = conv.id === editingId;
          const isRunning = !isActive && (
            conv.status === "Thinking..." ||
            conv.status === "Streaming..." ||
            conv.agentStatus === "warming"
          );

          return (
            <div
              key={conv.id}
              class={`tab ${isActive ? "tab--active" : ""} ${hasPermission ? "tab--permission" : ""}`}
              onClick={() => onSelect(conv.id)}
            >
              {isEditing ? (
                <input
                  class="tab-edit-input"
                  value={editValue}
                  onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                  onKeyDown={handleKeyDown}
                  onBlur={commitEdit}
                  onClick={(e) => e.stopPropagation()}
                  autofocus
                  placeholder={t("tab.placeholder")}
                />
              ) : (
                <span
                  class="tab-title"
                  onDblClick={() => startEdit(conv)}
                  title={`${conv.title}${isRunning ? " (running in background)" : ""} — double-click to rename`}
                >
                  {hasPermission && <span class="tab-badge">⏳</span>}
                  {isRunning && <span class="tab-running-dot" title="Running in background">●</span>}
                  {conv.title}
                </span>
              )}
              {conversations.length > 1 && (
                <button class="tab-close" onClick={(e) => { e.stopPropagation(); onClose(conv.id); }} title="Close">×</button>
              )}
            </div>
          );
        })}
      </div>
      <button class="tab-new" onClick={onNew} title={t("tab.newChat")}>+</button>
    </header>
  );
}
