import { useState } from "preact/hooks";
import type { PermissionRequest } from "../store";
import { t } from "../i18n";

interface Props {
  permission: PermissionRequest;
  onApprove: (id: string, answer?: Record<string, string>) => void;
  onDeny: (id: string) => void;
}

export function PermissionCard({ permission, onApprove, onDeny }: Props) {
  const questions = permission.questions;
  const isAskUserQuestion = permission.tool === "AskUserQuestion" && questions?.length;
  const [submitted, setSubmitted] = useState(false);

  // ── AskUserQuestion form ──────────────────────────────────────
  if (isAskUserQuestion) {
    return <AskUserQuestionForm
      questions={questions!}
      onSubmit={(answers) => { setSubmitted(true); onApprove(permission.id, answers); }}
      onCancel={() => onDeny(permission.id)}
    />;
  }

  // ── Generic permission prompt ──────────────────────────────────
  return (
    <div class="perm-card">
      <div class="perm-card-header">
        <span class="perm-card-icon">⚠️</span>
        <span class="perm-card-title">{t("perm.title")}</span>
      </div>
      <div class="perm-card-body">
        <p>{permission.message}</p>
      </div>
      <div class="perm-card-actions">
        <button
          class="perm-btn perm-btn--approve"
          onClick={() => { setSubmitted(true); onApprove(permission.id); }}
          disabled={submitted}
        >
          {t("perm.approve")}
        </button>
        <button
          class="perm-btn perm-btn--deny"
          onClick={() => onDeny(permission.id)}
          disabled={submitted}
        >
          {t("perm.deny")}
        </button>
      </div>
    </div>
  );
}

// ── AskUserQuestion sub-component ──────────────────────────────────

interface QuestionDef {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

function AskUserQuestionForm({ questions, onSubmit, onCancel }: {
  questions: QuestionDef[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  // Initialize answers — keyed by question text
  const [answers, setAnswers] = useState<Record<string, string[]>>({});

  const handleSelect = (questionText: string, optionLabel: string, multi: boolean) => {
    setAnswers((prev) => {
      if (multi) {
        const current = prev[questionText] || [];
        const next = current.includes(optionLabel)
          ? current.filter((l) => l !== optionLabel)
          : [...current, optionLabel];
        return { ...prev, [questionText]: next };
      }
      return { ...prev, [questionText]: [optionLabel] };
    });
  };

  const handleSubmit = () => {
    const result: Record<string, string> = {};
    for (const q of questions) {
      const selected = answers[q.question] || [];
      result[q.question] = q.multiSelect
        ? JSON.stringify(selected)
        : (selected[0] || "");
    }
    onSubmit(result);
  };

  const allAnswered = questions.every((q) => (answers[q.question]?.length || 0) > 0);

  return (
    <div class="perm-card perm-card--question">
      <div class="perm-card-header">
        <span class="perm-card-icon">❓</span>
        <span class="perm-card-title">{t("perm.questionTitle")}</span>
      </div>
      <div class="perm-card-body">
        {questions.map((q) => (
          <div key={q.question} class="question-block">
            <div class="question-header">{q.header}</div>
            <div class="question-text">{q.question}</div>
            <div class="question-options">
              {q.options.map((opt) => {
                const selected = (answers[q.question] || []).includes(opt.label);
                return (
                  <label
                    key={opt.label}
                    class={`question-option ${selected ? "question-option--selected" : ""}`}
                  >
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={q.question}
                      checked={selected}
                      onChange={() => handleSelect(q.question, opt.label, !!q.multiSelect)}
                      class="question-radio"
                    />
                    <div class="question-option-content">
                      <span class="question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span class="question-option-desc">{opt.description}</span>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            {q.multiSelect && (
              <div class="question-multiselect-hint">{t("perm.multiSelect")}</div>
            )}
          </div>
        ))}
      </div>
      <div class="perm-card-actions">
        <button
          class="perm-btn perm-btn--approve"
          onClick={handleSubmit}
          disabled={!allAnswered}
        >
          {t("perm.submit")}
        </button>
        <button
          class="perm-btn perm-btn--deny"
          onClick={onCancel}
        >
          {t("perm.deny")}
        </button>
      </div>
    </div>
  );
}
