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
 * there is no allow/deny framing. Several questions present as steps,
 * Claude-Code style: one at a time, answering advances, and a single
 * Send at the end delivers everything at once. Answered steps stay
 * visible as compact rows — click one to go back and change it. A lone
 * single-choice question still submits the moment an option is clicked.
 */
export const QuestionCard = memo(function QuestionCard({ message, onAnswer }: Props) {
  const state = message.question;
  // Selections by field. Multi-select values are joined on submit, which
  // is the shape the agent reads back.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);

  if (!state) return null;
  const answered = Boolean(state.answers) || state.skipped || state.cancelled;
  const questions = state.questions;
  const current = questions[step];
  const isLast = step === questions.length - 1;

  /** One click answers the simple case; everything else needs Send. */
  const submitsOnClick =
    questions.length === 1 && !questions[0].multiSelect && !hasTyping();

  function hasTyping(): boolean {
    return Object.values(typed).some((t) => t.trim() !== "");
  }

  /** What the user settled on for one question, custom text winning. */
  const answerText = (
    question: Question,
    selections: Record<string, string[]> = picked,
  ): string => {
    const custom = question.customField ? typed[question.customField]?.trim() : "";
    if (custom) return custom;
    return (selections[question.field] ?? []).join(", ");
  };

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
      // Picking is the whole answer for a single-select: move on.
      else if (!isLast) setStep(step + 1);
      return;
    }
    const selected = picked[question.field] ?? [];
    setPicked({
      ...picked,
      [question.field]: selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    });
  };

  const answers = answersFor();
  const canSend = Object.keys(answers).length > 0;
  const currentAnswered = answerText(current) !== "";

  return (
    <div className={`question ${answered ? "question--answered" : ""}`}>
      <div className="question__title">
        <QuestionIcon weight="bold" /> {message.text}
        {!answered && questions.length > 1 && (
          <span className="question__step">
            {step + 1} of {questions.length}
          </span>
        )}
      </div>

      {/* Steps already answered, kept as rows: click to go back. */}
      {!answered &&
        questions.slice(0, step).map((question, index) => (
          <button
            type="button"
            key={question.field}
            className="question__done"
            title="Change this answer"
            onClick={() => setStep(index)}
          >
            <span className="question__done-question">
              {question.header ?? question.text}
            </span>
            <span className="question__done-answer">{answerText(question) || "—"}</span>
          </button>
        ))}

      {!answered && (
        <div key={current.field} className="question__block">
          {current.header && <div className="question__header">{current.header}</div>}
          {/* With one question the title above already asked it. */}
          {questions.length > 1 && <div className="question__text">{current.text}</div>}
          <div className="question__options">
            {current.options.map((option) => (
              <button
                type="button"
                key={option.value}
                className={`question__option ${
                  (picked[current.field] ?? []).includes(option.value)
                    ? "question__option--picked"
                    : ""
                }`}
                onClick={() => toggle(current, option.value)}
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
          {current.customField && (
            <input
              className="question__custom"
              placeholder="…or type your own answer"
              value={typed[current.customField] ?? ""}
              onChange={(e) =>
                setTyped({
                  ...typed,
                  [current.customField as string]: e.target.value,
                })
              }
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!isLast && currentAnswered) setStep(step + 1);
                else if (isLast && canSend) onAnswer(state.requestId, answers);
              }}
            />
          )}
        </div>
      )}

      {!answered && (
        <div className="question__actions">
          {!submitsOnClick && !isLast && (
            <button
              type="button"
              className="question__send"
              disabled={!currentAnswered}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          )}
          {!submitsOnClick && isLast && (
            <button
              type="button"
              className="question__send"
              disabled={!canSend}
              onClick={() => onAnswer(state.requestId, answers)}
            >
              Answer
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
