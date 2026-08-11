import {
  ArrowUp,
  Bug,
  ClipboardText,
  Gauge,
  Lightning,
  Paperclip,
  PencilSimple,
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
import {
  FILE_MENTION_LIMIT,
  filterFiles,
  mentionToken,
  replaceMention,
} from "../../core/entities/fileMention";
import type { ProviderId } from "../../core/entities/provider";
import { EFFORT_OPTIONS } from "../../core/entities/provider";
import { fileName } from "../fileName";
import { CommandPalette } from "./CommandPalette";
import { CommandText } from "./CommandText";
import { ContextGauge } from "./ContextGauge";
import { FileMentionMenu } from "./FileMentionMenu";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker, type PickerOption } from "./OptionPicker";

/** The input grows with the text up to this many lines, then scrolls. */
const MAX_INPUT_LINES = 4;
const LINE_HEIGHT_PX = 22;

/**
 * How long a fetched file list is reused before "@" asks git again. Long
 * enough that a burst of typing costs one `git ls-files`, short enough
 * that a file the agent just wrote shows up while you are still reading
 * about it.
 */
const FILE_LIST_TTL_MS = 30_000;

/** Bounds for a hand-resized input: one line up to half the window. */
const MIN_INPUT_HEIGHT_PX = LINE_HEIGHT_PX;
const maxInputHeight = () => Math.round(window.innerHeight * 0.5);

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
  auto: <PencilSimple />,
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
  /** What "default" resolves to for this provider (from Settings →
   *  Defaults), so the pickers can say it. Empty = the provider's own. */
  defaultModel: string;
  defaultEffort: string;
  usage: { readonly used: number; readonly size: number } | undefined;
  /** Fraction of the context window at which auto-compact kicks in. */
  autoCompactThreshold: number;
  onSend: (prompt: string, attachments: readonly string[]) => void;
  onCancel: () => void;
  onPickFiles: () => Promise<string[]>;
  /** Save an image pasted into the composer; returns its file path. */
  onPasteImage: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  /** The project's files, for the "@" menu. Empty outside a repository. */
  loadProjectFiles: () => Promise<string[]>;
  onSelectMode: (mode: AgentMode) => void;
  onSelectPermission: (permission: PermissionPolicy) => void;
  onSelectModel: (model: string) => void;
  onSelectEffort: (effort: string) => void;
  /** A model/effort change queued for the next chat, when any. The
   *  pickers show it so the toolbar reflects what the user picked, and
   *  mark it so they never mistake it for what is running. */
  pendingSpec?: { readonly model?: string; readonly effort?: string };
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
  defaultModel,
  defaultEffort,
  usage,
  autoCompactThreshold,
  onSend,
  onCancel,
  onPickFiles,
  onPasteImage,
  loadProjectFiles,
  onSelectMode,
  onSelectPermission,
  onSelectModel,
  onSelectEffort,
  pendingSpec,
}: Props) {
  // One dismissal serves both menus: only one of them can be open, since
  // a word starts with either "/" or "@", never both.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projectFiles, setProjectFiles] = useState<readonly string[]>([]);
  // A height the user dragged the input to; null means auto-grow.
  const [userHeight, setUserHeight] = useState<number | null>(null);
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
  // The empty id is the way back from a choice: the app's configured
  // default when there is one (named, so the user knows what they get),
  // otherwise the provider's own.
  const effortPickerOptions: readonly PickerOption<string>[] = [
    {
      id: "",
      label: defaultEffort ? `Default: ${defaultEffort}` : "Default effort",
      icon: <Gauge />,
    },
    ...effortOptions.map((level) => ({ id: level, label: level, icon: <Gauge /> })),
  ];
  // The "/..." word being typed at the end of the draft, if any. Typing
  // "/" mid-message (after other text) opens the palette too — commands
  // are not only ever the first thing in a prompt.
  const commandToken = useMemo(() => {
    const token = draft.split(/\s/).pop() ?? "";
    return token.startsWith("/") ? token : null;
  }, [draft]);

  const paletteCommands =
    !menuDismissed && commandToken !== null
      ? filterCommands(commands, commandToken ?? "")
      : [];

  // The "@..." word being typed, if any — the file menu's trigger.
  const mention = useMemo(() => mentionToken(draft), [draft]);
  const mentionOpen = !menuDismissed && mention !== null;
  const mentionFiles = mentionOpen
    ? filterFiles(projectFiles, mention ?? "", FILE_MENTION_LIMIT)
    : [];

  // The list is fetched on the first "@" rather than on mount: most
  // messages never mention a file, and a repository's file list is the
  // same for every keystroke that follows.
  const filesFetchedAt = useRef(0);
  useEffect(() => {
    if (!mentionOpen || Date.now() - filesFetchedAt.current < FILE_LIST_TTL_MS) return;
    filesFetchedAt.current = Date.now(); // stamped first: one fetch per burst
    let cancelled = false;
    void loadProjectFiles().then((files) => {
      if (!cancelled) setProjectFiles(files);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, loadProjectFiles]);

  // Auto-grow: fit the content, capped at MAX_INPUT_LINES — unless the
  // user dragged the input to a height of their own, which then wins.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (userHeight !== null) {
      el.style.height = `${userHeight}px`;
      el.style.overflowY = "auto";
      return;
    }
    const max = MAX_INPUT_LINES * LINE_HEIGHT_PX;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft, userHeight]);

  // Drag the handle up for a taller input, down for a smaller one.
  // Double-click returns to auto-grow.
  const startInputResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = inputRef.current?.offsetHeight ?? MIN_INPUT_HEIGHT_PX;

    const onMove = (move: PointerEvent) => {
      const next = startHeight - (move.clientY - startY);
      setUserHeight(Math.min(maxInputHeight(), Math.max(MIN_INPUT_HEIGHT_PX, next)));
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
  };

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

  // A picked file goes into the prompt as its path — the agent reads it
  // itself, so there is nothing to attach.
  const pickFile = (path: string) => {
    onDraftChange(replaceMention(draft, mention ?? "", path), attachments);
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

  // Saving a paste is async; the user may keep typing meanwhile. The ref
  // always holds this render's draft and attachments, so the update that
  // lands after the save cannot revert what was typed in between.
  const latest = useRef({ draft, attachments });
  latest.current = { draft, attachments };

  // Pasting an image (a screenshot, a copied picture) attaches it: the
  // bytes are saved to a file and the path joins the attachments exactly
  // as if it had been picked. Plain text pastes pass through untouched.
  const onPaste = (e: React.ClipboardEvent) => {
    const images = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length === 0) return;
    e.preventDefault();
    void attachPasted(images);
  };

  const attachPasted = async (images: File[]) => {
    const saved: string[] = [];
    for (const image of images) {
      const bytes = new Uint8Array(await image.arrayBuffer());
      // Best-effort, like every attachment affordance: a failed save
      // drops that image rather than breaking the composer.
      const path = await onPasteImage(bytes, image.type).catch(() => null);
      if (path) saved.push(path);
    }
    const current = latest.current;
    const fresh = saved.filter((p) => !current.attachments.includes(p));
    if (fresh.length > 0) {
      onDraftChange(current.draft, [...current.attachments, ...fresh]);
    }
  };

  // Whichever menu is open owns the arrows, Enter, Tab and Escape — the
  // keys mean the same thing in both, so they are handled once.
  const openMenu =
    paletteCommands.length > 0
      ? {
          count: paletteCommands.length,
          pick: (i: number) => pickCommand(paletteCommands[i]),
        }
      : mentionFiles.length > 0
        ? { count: mentionFiles.length, pick: (i: number) => pickFile(mentionFiles[i]) }
        : null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (openMenu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSelectedIndex((selectedIndex + delta + openMenu.count) % openMenu.count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        openMenu.pick(Math.min(selectedIndex, openMenu.count - 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
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
      <FileMentionMenu
        files={mentionFiles}
        selectedIndex={Math.min(selectedIndex, Math.max(mentionFiles.length - 1, 0))}
        onPick={pickFile}
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
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the input itself stays fully keyboard-accessible at any height */}
        <div
          className="composer-card__resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={startInputResize}
          onDoubleClick={() => setUserHeight(null)}
        />
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
              setMenuDismissed(false);
              setSelectedIndex(0);
            }}
            onScroll={syncHighlightScroll}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
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
            <ContextGauge usage={usage} threshold={autoCompactThreshold} />
            <ModelPicker
              provider={provider}
              value={model}
              defaultModel={defaultModel}
              pendingValue={pendingSpec?.model}
              disabled={busy}
              onChange={onSelectModel}
            />
            {effortOptions.length > 0 && (
              <OptionPicker
                ariaLabel="Reasoning effort"
                options={effortPickerOptions}
                value={pendingSpec?.effort ?? effort}
                disabled={busy}
                placeholder="effort"
                align="end"
                className={
                  pendingSpec?.effort !== undefined
                    ? "picker__trigger--dim picker__trigger--pending"
                    : "picker__trigger--dim"
                }
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
