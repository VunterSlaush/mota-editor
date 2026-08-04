import {
  ArrowUp,
  Bug,
  ClipboardText,
  Gauge,
  Lightning,
  Paperclip,
  Plus,
  Robot,
  ShieldCheck,
  Stop,
  X,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentMode, PermissionPolicy } from "../../core/entities/agentSettings";
import { MODES, PERMISSIONS } from "../../core/entities/agentSettings";
import { type CommandInfo, filterCommands } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import { EFFORT_OPTIONS } from "../../core/entities/provider";
import { AUTO_COMPACT_THRESHOLD } from "../../core/usecases/sendPrompt";
import { fileName } from "../fileName";
import { CommandPalette } from "./CommandPalette";
import { ContextGauge } from "./ContextGauge";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker, type PickerOption } from "./OptionPicker";

/** The input grows with the text up to this many lines, then scrolls. */
const MAX_INPUT_LINES = 4;
const LINE_HEIGHT_PX = 22;

/**
 * Icons for the core's mode and permission descriptors. They live here,
 * not beside the descriptors: the entities layer knows nothing of icons.
 */
const MODE_ICONS: Record<AgentMode, ReactNode> = {
  agent: <Robot />,
  plan: <ClipboardText />,
  debug: <Bug />,
};

const PERMISSION_ICONS: Record<PermissionPolicy, ReactNode> = {
  manual: <ShieldCheck />,
  bypass: <Lightning />,
};

const MODE_OPTIONS: readonly PickerOption<AgentMode>[] = MODES.map((mode) => ({
  ...mode,
  icon: MODE_ICONS[mode.id],
}));

const PERMISSION_OPTIONS: readonly PickerOption<PermissionPolicy>[] = PERMISSIONS.map(
  (permission) => ({ ...permission, icon: PERMISSION_ICONS[permission.id] }),
);

interface Props {
  busy: boolean;
  queued: readonly { prompt: string; attachments: readonly string[] }[];
  onRemoveQueued: (index: number) => void;
  placeholder: string;
  commands: readonly CommandInfo[];
  provider: ProviderId;
  mode: AgentMode;
  permission: PermissionPolicy;
  model: string;
  effort: string;
  usage: { readonly used: number; readonly size: number } | undefined;
  hasPlan: boolean;
  onShowPlan: () => void;
  onSend: (prompt: string, attachments: readonly string[]) => void;
  onCancel: () => void;
  onPickFiles: () => Promise<string[]>;
  onSelectMode: (mode: AgentMode) => void;
  onSelectPermission: (permission: PermissionPolicy) => void;
  onSelectModel: (model: string) => void;
  onSelectEffort: (effort: string) => void;
}

/**
 * UI — the prompt composer: a borderless input on top that grows with
 * the text (up to 4 lines, then scrolls), and a toolbar underneath —
 * attach and agent settings on the left, model/effort and the round
 * send/stop button on the right. Enter sends, Shift+Enter adds a line,
 * typing "/" opens the command palette.
 */
export function Composer({
  busy,
  queued,
  onRemoveQueued,
  placeholder,
  commands,
  provider,
  mode,
  permission,
  model,
  effort,
  usage,
  hasPlan,
  onShowPlan,
  onSend,
  onCancel,
  onPickFiles,
  onSelectMode,
  onSelectPermission,
  onSelectModel,
  onSelectEffort,
}: Props) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const effortOptions = EFFORT_OPTIONS[provider];
  // The empty id is the provider's own default — the way back from a choice.
  const effortPickerOptions: readonly PickerOption<string>[] = [
    { id: "", label: "Default effort", icon: <Gauge /> },
    ...effortOptions.map((level) => ({ id: level, label: level, icon: <Gauge /> })),
  ];
  const paletteCommands = paletteVisible() ? filterCommands(commands, draft) : [];

  function paletteVisible(): boolean {
    return !paletteDismissed && draft.startsWith("/") && !/\s/.test(draft);
  }

  // Auto-grow: fit the content, capped at MAX_INPUT_LINES.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const max = MAX_INPUT_LINES * LINE_HEIGHT_PX;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  // Sending while busy queues the message (Claude-Code style) — the use
  // case delivers it as soon as the running turn completes.
  const send = () => {
    if (draft.trim() === "" && attachments.length === 0) return;
    onSend(draft, attachments);
    setDraft("");
    setAttachments([]);
  };

  const pickCommand = (command: CommandInfo) => {
    setDraft(`${command.name} `);
    setSelectedIndex(0);
    inputRef.current?.focus();
  };

  const attach = async () => {
    const picked = await onPickFiles();
    if (picked.length === 0) return;
    setAttachments((current) => [
      ...current,
      ...picked.filter((p) => !current.includes(p)),
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (paletteCommands.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex(
          (selectedIndex + delta + paletteCommands.length) % paletteCommands.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(paletteCommands[Math.min(selectedIndex, paletteCommands.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaletteDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="composer-area">
      <CommandPalette
        commands={paletteCommands}
        selectedIndex={Math.min(selectedIndex, Math.max(paletteCommands.length - 1, 0))}
        onPick={pickCommand}
      />
      {queued.length > 0 && (
        <div className="queued-list" aria-label="Queued messages">
          {queued.map((q, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the queue is removed by index (onRemoveQueued), so position is the identity
              key={`${index}-${q.prompt}`}
              className="queued-item"
              title={q.prompt}
            >
              <span className="queued-item__badge">queued</span>
              <span className="queued-item__text">{q.prompt}</span>
              <button
                type="button"
                className="queued-item__remove"
                aria-label="Remove queued message"
                onClick={() => onRemoveQueued(index)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((path) => (
            <span key={path} className="attachment-chip" title={path}>
              <Paperclip size={13} /> {fileName(path)}
              <button
                type="button"
                className="attachment-chip__remove"
                aria-label={`Remove ${fileName(path)}`}
                onClick={() => setAttachments(attachments.filter((p) => p !== path))}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-card">
        <textarea
          ref={inputRef}
          className="composer-card__input"
          value={draft}
          placeholder={busy ? "Queue another message… (Esc to stop)" : placeholder}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            setPaletteDismissed(false);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-card__toolbar">
          <div className="composer-card__group">
            <button
              type="button"
              className="icon-button"
              title="Attach files"
              aria-label="Attach files"
              onClick={() => void attach()}
            >
              <Plus />
            </button>
            <button
              type="button"
              className="icon-button icon-button--plan"
              title={
                hasPlan
                  ? "View the current plan"
                  : "No plan yet — the agent publishes one when it breaks a task into steps"
              }
              aria-label="View plan"
              disabled={!hasPlan}
              onClick={onShowPlan}
            >
              <ClipboardText />
            </button>
            <OptionPicker
              ariaLabel="Agent mode"
              options={MODE_OPTIONS}
              value={mode}
              disabled={busy}
              onChange={onSelectMode}
            />
            <OptionPicker
              ariaLabel="Permissions"
              options={PERMISSION_OPTIONS}
              value={permission}
              disabled={busy}
              onChange={onSelectPermission}
            />
          </div>
          <div className="composer-card__group">
            <ContextGauge usage={usage} threshold={AUTO_COMPACT_THRESHOLD} />
            <ModelPicker
              provider={provider}
              value={model}
              disabled={busy}
              onChange={onSelectModel}
            />
            {effortOptions.length > 0 && (
              <OptionPicker
                ariaLabel="Reasoning effort"
                options={effortPickerOptions}
                value={effort}
                disabled={busy}
                placeholder="effort"
                className="picker__trigger--dim"
                onChange={onSelectEffort}
              />
            )}
            {busy ? (
              <button
                type="button"
                className="send-button send-button--stop"
                title="Stop"
                aria-label="Stop"
                onClick={onCancel}
              >
                <Stop size={14} weight="fill" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                title="Send"
                aria-label="Send"
                disabled={draft.trim() === "" && attachments.length === 0}
                onClick={send}
              >
                <ArrowUp weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
