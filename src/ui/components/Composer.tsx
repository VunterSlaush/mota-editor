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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMode, PermissionPolicy } from "../../core/entities/agentSettings";
import { MODES, PERMISSIONS } from "../../core/entities/agentSettings";
import {
  type CommandInfo,
  commandNames,
  filterCommands,
} from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import { EFFORT_OPTIONS } from "../../core/entities/provider";
import { AUTO_COMPACT_THRESHOLD } from "../../core/usecases/sendPrompt";
import { fileName } from "../fileName";
import { CommandPalette } from "./CommandPalette";
import { CommandText } from "./CommandText";
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
  /** The half-written prompt. Owned by the tab, not by this component:
   *  switching tabs remounts the chat, and a remount must not eat it. */
  draft: string;
  attachments: readonly string[];
  onDraftChange: (draft: string, attachments: readonly string[]) => void;
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
  draft,
  attachments,
  onDraftChange,
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
  onSend,
  onCancel,
  onPickFiles,
  onSelectMode,
  onSelectPermission,
  onSelectModel,
  onSelectEffort,
}: Props) {
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const commandNameSet = useMemo(() => commandNames(commands), [commands]);

  // The highlight layer is taller than its box once the input scrolls;
  // keep it in step with the textarea or the colours drift off the text.
  const syncHighlightScroll = () => {
    const input = inputRef.current;
    const highlight = highlightRef.current;
    if (input && highlight) highlight.scrollTop = input.scrollTop;
  };

  const effortOptions = EFFORT_OPTIONS[provider];
  // The empty id is the provider's own default — the way back from a choice.
  const effortPickerOptions: readonly PickerOption<string>[] = [
    { id: "", label: "Default effort", icon: <Gauge /> },
    ...effortOptions.map((level) => ({ id: level, label: level, icon: <Gauge /> })),
  ];
  // The "/..." word being typed at the end of the draft, if any. Typing
  // "/" mid-message (after other text) opens the palette too — commands
  // are not only ever the first thing in a prompt.
  const commandToken = useMemo(() => {
    const token = draft.split(/\s/).pop() ?? "";
    return token.startsWith("/") ? token : null;
  }, [draft]);

  const paletteCommands = paletteVisible()
    ? filterCommands(commands, commandToken ?? "")
    : [];

  function paletteVisible(): boolean {
    return !paletteDismissed && commandToken !== null;
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
    onDraftChange("", []);
  };

  const pickCommand = (command: CommandInfo) => {
    // Replace only the "/..." word being typed; text before it stays.
    const base = commandToken ? draft.slice(0, draft.length - commandToken.length) : "";
    onDraftChange(`${base}${command.name} `, attachments);
    setSelectedIndex(0);
    inputRef.current?.focus();
  };

  const attach = async () => {
    const picked = await onPickFiles();
    if (picked.length === 0) return;
    onDraftChange(draft, [
      ...attachments,
      ...picked.filter((p) => !attachments.includes(p)),
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
              <span className="queued-item__text">
                <CommandText text={q.prompt} commands={commandNameSet} />
              </span>
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
                onClick={() =>
                  onDraftChange(
                    draft,
                    attachments.filter((p) => p !== path),
                  )
                }
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-card">
        <div className="composer-card__input-wrap">
          {/* A textarea cannot colour part of its own value, so the text
              is drawn again underneath and the textarea made
              transparent. The two layers share every metric that affects
              wrapping (see styles.css) and scroll together. */}
          <div className="composer-card__highlight" ref={highlightRef} aria-hidden="true">
            <CommandText text={draft} commands={commandNameSet} />
            {"\n"}
          </div>
          <textarea
            ref={inputRef}
            className="composer-card__input"
            value={draft}
            placeholder={busy ? "Queue another message… (Esc to stop)" : placeholder}
            rows={1}
            onChange={(e) => {
              onDraftChange(e.target.value, attachments);
              setPaletteDismissed(false);
              setSelectedIndex(0);
            }}
            onScroll={syncHighlightScroll}
            onKeyDown={onKeyDown}
          />
        </div>
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
                align="end"
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
