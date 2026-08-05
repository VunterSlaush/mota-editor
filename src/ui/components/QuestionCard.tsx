import { Question as QuestionIcon } from "@phosphor-icons/react";
import { memo, useState } from "react";
import type { ChatMessage, Question } from "../../core/entities/message";

interface Props {
  message: ChatMessage;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
}

/**
 * UI — the agent asking the user something it can't decide alone.
 *
 * Deliberately not an approval card: nothing is being consented to, so
 * there is no allow/deny framing. A single-choice question submits the
 * moment an option is clicked (the common case is one question with a
 * handful of answers); anything with several questions, a multi-select,
 * or a typed answer gets an explicit Send.
 */
export const QuestionCard = memo(function QuestionCard({ message, onAnswer }: Props) {
  const state = message.question;
  // Selections by field. Multi-select values are joined on submit, which
  // is the shape the agent reads back.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  if (!state) return null;
  const answered = Boolean(state.answers) || state.skipped || state.cancelled;
  const questions = state.questions;

  /** One click answers the simple case; everything else needs Send. */
  const submitsOnClick =
    questions.length === 1 && !questions[0].multiSelect && !hasTyping();

  function hasTyping(): boolean {
    return Object.values(typed).some((t) => t.trim() !== "");
  }

  const answersFor = (overrides?: Record<string, string[]>): Record<string, string> => {
    const selections = overrides ?? picked;
    const answers: Record<string, string> = {};
    for (const question of questions) {
      // A typed answer wins: the user chose to write their own instead of
      // picking. This mirrors what the agent's own bridge does.
      const custom = question.customField ? typed[question.customField]?.trim() : "";
      if (custom) {
        answers[question.customField as string] = custom;
        continue;
      }
      const values = selections[question.field] ?? [];
      if (values.length > 0) answers[question.field] = values.join(", ");
    }
    return answers;
  };

  const toggle = (question: Question, value: string) => {
    if (answered) return;
    if (!question.multiSelect) {
      const next = { ...picked, [question.field]: [value] };
      setPicked(next);
      if (submitsOnClick) onAnswer(state.requestId, answersFor(next));
      return;
    }
    const current = picked[question.field] ?? [];
    setPicked({
      ...picked,
      [question.field]: current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    });
  };

  const answers = answersFor();
  const canSend = Object.keys(answers).length > 0;

  return (
    <div className={`question ${answered ? "question--answered" : ""}`}>
      <div className="question__title">
        <QuestionIcon weight="bold" /> {message.text}
      </div>

      {questions.map((question) => {
        const selected = picked[question.field] ?? [];
        return (
          <div key={question.field} className="question__block">
            {question.header && <div className="question__header">{question.header}</div>}
            {/* With one question the title above already asked it. */}
            {questions.length > 1 && (
              <div className="question__text">{question.text}</div>
            )}
            <div className="question__options">
              {question.options.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={`question__option ${
                    selected.includes(option.value) ? "question__option--picked" : ""
                  }`}
                  disabled={answered}
                  onClick={() => toggle(question, option.value)}
                >
                  <span className="question__option-label">{option.label}</span>
                  {option.description && (
                    <span className="question__option-description">
                      {option.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {question.customField && !answered && (
              <input
                className="question__custom"
                placeholder="…or type your own answer"
                value={typed[question.customField] ?? ""}
                onChange={(e) =>
                  setTyped({
                    ...typed,
                    [question.customField as string]: e.target.value,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSend) {
                    e.preventDefault();
                    onAnswer(state.requestId, answers);
                  }
                }}
              />
            )}
          </div>
        );
      })}

      {!answered && (
        <div className="question__actions">
          {!submitsOnClick && (
            <button
              type="button"
              className="question__send"
              disabled={!canSend}
              onClick={() => onAnswer(state.requestId, answers)}
            >
              Send
            </button>
          )}
          {/* Skipping is a real answer: the agent continues without it
              rather than the turn dying. */}
          <button
            type="button"
            className="question__skip"
            onClick={() => onAnswer(state.requestId, {})}
          >
            Skip
          </button>
        </div>
      )}

      {state.answers && (
        <div className="question__status">
          You answered: {Object.values(state.answers).join(" · ")}
        </div>
      )}
      {state.skipped && <div className="question__status">You skipped this.</div>}
      {state.cancelled && !state.answers && (
        <div className="question__status">The turn ended before you answered.</div>
      )}
    </div>
  );
});
