import { Lightning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CommandInfo, CommandSource } from "../../core/entities/command";
import { commandConfigKey } from "../../core/entities/commandConfig";
import {
  type CommandOptimization,
  isStale,
  type OptimizationBlocker,
} from "../../core/entities/commandOptimization";
import type { CommandSavings } from "../../core/entities/insights";
import { PROVIDERS, type ProviderId } from "../../core/entities/provider";
import { formatTokens } from "../../core/entities/tokens";
import type { SavedCommandCopy } from "../../core/ports/commandOptimizer";
import type { AppSettings, TabState } from "../../core/state/appState";
import type {
  OptimizeOutcome,
  RewriteOutcome,
} from "../../core/usecases/optimizeCommand";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** The open tabs — each one's project is offered in the picker. */
  tabs: readonly TabState[];
  activeTab: TabState | null;
  loadCommands: (projectPath: string, provider: ProviderId) => Promise<CommandInfo[]>;
  /** Runs the analysis turn — a real agent process, so per click only. */
  optimize: (
    projectPath: string,
    provider: ProviderId,
    commandName: string,
  ) => Promise<OptimizeOutcome>;
  /** Rewrites a declined command into an optimizable variant. */
  rewrite: (
    projectPath: string,
    provider: ProviderId,
    commandName: string,
    blockers: readonly OptimizationBlocker[],
  ) => Promise<RewriteOutcome>;
  /** Writes the approved variant to disk as a NEW command file. */
  saveCopy: (
    projectPath: string,
    provider: ProviderId,
    sourceName: string,
    content: string,
  ) => Promise<SavedCommandCopy>;
  loadSavings: (
    provider: ProviderId,
    command: string,
    activatedAt: number,
  ) => Promise<CommandSavings>;
}

/** What one row is doing right now; nothing here is persisted. */
type RowActivity =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | {
      kind: "proposal";
      script: string;
      instructions?: string;
      summary?: string;
      sourceHash: string;
    }
  | {
      kind: "copyProposal";
      command: string;
      script: string;
      instructions?: string;
      summary?: string;
    }
  | { kind: "error"; error: string };

const GROUPS: readonly { source: CommandSource; label: string }[] = [
  { source: "project", label: "Project" },
  { source: "user", label: "User" },
];

/**
 * UI — turn deterministic slash commands into approved one-call scripts.
 * The analysis proposes; only the user's explicit Activate persists
 * anything, because the script will run real commands in their repo.
 */
export function SettingsOptimization({
  settings,
  onChange,
  tabs,
  activeTab,
  loadCommands,
  optimize,
  rewrite,
  saveCopy,
  loadSavings,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(settings.defaultProvider);
  // Project commands live in the chosen project's folders; scoping to the
  // active tab silently would hide every other open project's commands.
  const [projectPath, setProjectPath] = useState(
    activeTab?.project.path ?? tabs[0]?.project.path ?? "",
  );
  const [commands, setCommands] = useState<readonly CommandInfo[]>([]);
  const [activity, setActivity] = useState<Record<string, RowActivity>>({});
  const [savings, setSavings] = useState<Record<string, CommandSavings>>({});
  // Bumped when a copy is written, so the new command's row appears.
  const [discoveredAt, setDiscoveredAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadCommands(projectPath, provider).then((loaded) => {
      if (!cancelled) setCommands(loaded.filter((c) => c.source !== "builtin"));
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, provider, loadCommands, discoveredAt]);

  const optimizations = settings.commandOptimizations;
  const recordFor = (name: string): CommandOptimization | undefined =>
    optimizations[commandConfigKey(provider, name)];

  // Savings are derived from transcript stats on demand, like Insights —
  // re-derived when an activation changes the split point.
  useEffect(() => {
    let cancelled = false;
    for (const command of commands) {
      const record = recordFor(command.name);
      if (record?.status !== "active" || record.activatedAt === undefined) continue;
      loadSavings(provider, command.name, record.activatedAt).then((loaded) => {
        if (!cancelled) setSavings((prev) => ({ ...prev, [command.name]: loaded }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [provider, commands, optimizations, loadSavings]);

  const setRow = (name: string, state: RowActivity) =>
    setActivity((prev) => ({ ...prev, [name]: state }));

  const write = (name: string, record: CommandOptimization | undefined) => {
    const key = commandConfigKey(provider, name);
    const next = { ...optimizations };
    if (record === undefined) delete next[key];
    else next[key] = record;
    onChange({ commandOptimizations: next });
  };

  const analyze = async (name: string) => {
    setRow(name, { kind: "analyzing" });
    const outcome = await optimize(projectPath, provider, name);
    if (outcome.kind === "failed") {
      setRow(name, { kind: "error", error: outcome.error });
      return;
    }
    if (!outcome.proposal.optimizable) {
      // A declined verdict is an answer worth keeping, not a draft to
      // review — persisting it is what marks the row "not optimizable".
      write(name, {
        status: "notOptimizable",
        reason: outcome.proposal.reason,
        ...(outcome.proposal.blockers ? { blockers: outcome.proposal.blockers } : {}),
        sourceHash: outcome.sourceHash,
      });
      setRow(name, { kind: "idle" });
      return;
    }
    setRow(name, {
      kind: "proposal",
      script: outcome.proposal.script,
      instructions: outcome.proposal.instructions,
      summary: outcome.proposal.summary,
      sourceHash: outcome.sourceHash,
    });
  };

  const activate = (name: string, proposal: RowActivity & { kind: "proposal" }) => {
    // Instructions the user blanked out mean "script-only after all".
    const instructions = proposal.instructions?.trim();
    write(name, {
      status: "active",
      script: proposal.script,
      ...(instructions ? { instructions } : {}),
      summary: proposal.summary,
      sourceHash: proposal.sourceHash,
      activatedAt: Date.now(),
    });
    setRow(name, { kind: "idle" });
  };

  const rewriteCopy = async (name: string) => {
    setRow(name, { kind: "analyzing" });
    const blockers = recordFor(name)?.blockers ?? [];
    const outcome = await rewrite(projectPath, provider, name, blockers);
    if (outcome.kind === "failed") {
      setRow(name, { kind: "error", error: outcome.error });
      return;
    }
    setRow(name, {
      kind: "copyProposal",
      command: outcome.proposal.command,
      script: outcome.proposal.script,
      instructions: outcome.proposal.instructions,
      summary: outcome.proposal.summary,
    });
  };

  const createCopy = async (
    name: string,
    proposal: RowActivity & { kind: "copyProposal" },
  ) => {
    let saved: SavedCommandCopy;
    try {
      saved = await saveCopy(projectPath, provider, name, proposal.command);
    } catch (error) {
      setRow(name, { kind: "error", error: String(error) });
      return;
    }
    const instructions = proposal.instructions?.trim();
    write(saved.name, {
      status: "active",
      script: proposal.script,
      ...(instructions ? { instructions } : {}),
      summary: proposal.summary,
      sourceHash: saved.contentHash,
      activatedAt: Date.now(),
    });
    setRow(name, { kind: "idle" });
    setDiscoveredAt(Date.now());
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Optimization</h2>
      <p className="settings-section__hint">
        A command that always plays out the same way — format, commit, push — makes the
        agent re-derive those steps every run, tool call by tool call. Optimizing distills
        it into a script you review and approve; from then on, running the command costs
        one tool call instead.
      </p>
      <p className="settings-section__hint">
        A command that is mostly mechanical with a little judgment becomes a hybrid: the
        judgment stays a short prompt, the rest becomes the script — still far cheaper
        than the full command. One that needs judgment through and through stays a prompt,
        and its row says why. If a command's file changes later, its row flags the
        approved script as stale so you can re-optimize.
      </p>

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">Provider</span>
          <span className="settings-field__hint">
            Commands differ per agent, so each keeps its own scripts.
          </span>
        </div>
        <div className="settings-field__control">
          <OptionPicker
            ariaLabel="Provider whose commands are shown"
            placement="bottom"
            disabled={false}
            value={provider}
            options={PROVIDERS.map((p) => ({ id: p.id, label: p.displayName }))}
            onChange={setProvider}
          />
        </div>
      </div>

      {tabs.length > 0 && (
        <div className="settings-field">
          <div className="settings-field__text">
            <span className="settings-field__label">Project</span>
            <span className="settings-field__hint">
              Whose command and skill folders are scanned. Your user commands show for
              every project.
            </span>
          </div>
          <div className="settings-field__control">
            <OptionPicker
              ariaLabel="Project whose commands are shown"
              placement="bottom"
              disabled={tabs.length === 1}
              value={projectPath}
              options={tabs.map((t) => ({
                id: t.project.path,
                label: t.project.name,
              }))}
              onChange={setProjectPath}
            />
          </div>
        </div>
      )}

      {commands.length === 0 && (
        <p className="settings-section__hint">
          No custom commands found for this provider yet.
        </p>
      )}

      {commands.length > 0 && !commands.some((c) => c.source === "project") && (
        <p className="settings-section__hint">
          This project has no commands of its own — no .claude/commands or .claude/skills
          folder — so everything below comes from your home folder.
        </p>
      )}

      {GROUPS.map((group) => {
        const grouped = commands.filter((c) => c.source === group.source);
        if (grouped.length === 0) return null;
        return (
          <section key={group.source} aria-label={`${group.label} commands`}>
            <div className="command-group">
              <span className="command-group__label">{group.label}</span>
            </div>
            {grouped.map((command) => (
              <OptimizationRow
                key={command.name}
                command={command}
                record={recordFor(command.name)}
                activity={activity[command.name] ?? { kind: "idle" }}
                savings={savings[command.name]}
                onOptimize={() => void analyze(command.name)}
                onRewriteCopy={() => void rewriteCopy(command.name)}
                onActivate={(proposal) => activate(command.name, proposal)}
                onCreateCopy={(proposal) => void createCopy(command.name, proposal)}
                onDiscard={() => setRow(command.name, { kind: "idle" })}
                onDeactivate={() => write(command.name, undefined)}
                onEditScript={(script) => {
                  const current = activity[command.name];
                  if (current?.kind === "proposal" || current?.kind === "copyProposal")
                    setRow(command.name, { ...current, script });
                }}
                onEditInstructions={(instructions) => {
                  const current = activity[command.name];
                  if (current?.kind === "proposal" || current?.kind === "copyProposal")
                    setRow(command.name, { ...current, instructions });
                }}
                onEditCommand={(text) => {
                  const current = activity[command.name];
                  if (current?.kind === "copyProposal")
                    setRow(command.name, { ...current, command: text });
                }}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

interface RowProps {
  command: CommandInfo;
  record: CommandOptimization | undefined;
  activity: RowActivity;
  savings: CommandSavings | undefined;
  onOptimize: () => void;
  onRewriteCopy: () => void;
  onActivate: (proposal: RowActivity & { kind: "proposal" }) => void;
  onCreateCopy: (proposal: RowActivity & { kind: "copyProposal" }) => void;
  onDiscard: () => void;
  onDeactivate: () => void;
  onEditScript: (script: string) => void;
  onEditInstructions: (instructions: string) => void;
  onEditCommand: (text: string) => void;
}

function OptimizationRow({
  command,
  record,
  activity,
  savings,
  onOptimize,
  onRewriteCopy,
  onActivate,
  onCreateCopy,
  onDiscard,
  onDeactivate,
  onEditScript,
  onEditInstructions,
  onEditCommand,
}: RowProps) {
  const analyzing = activity.kind === "analyzing";
  const stale = record !== undefined && isStale(record, command.contentHash);

  return (
    <div className="optimization-row">
      <div className="optimization-row__header">
        <div className="command-row__text">
          <span className="command-row__name">
            {command.name}
            {record?.status === "active" && (
              <span className="optimization-badge optimization-badge--active">
                <Lightning size={11} weight="fill" />
                {record.instructions ? "Optimized · hybrid" : "Optimized"}
              </span>
            )}
            {record?.status === "notOptimizable" && (
              <span className="optimization-badge">Not optimizable</span>
            )}
            {stale && (
              <span className="optimization-badge optimization-badge--stale">
                Source changed
              </span>
            )}
          </span>
          <span className="command-row__description">
            {record?.status === "active"
              ? (record.summary ?? command.description)
              : command.description}
          </span>
        </div>
        <div className="optimization-row__actions">
          {record?.status === "active" ? (
            <>
              <button
                type="button"
                className="tool-add"
                onClick={onOptimize}
                disabled={analyzing}
              >
                {analyzing ? "Analyzing…" : "Re-optimize"}
              </button>
              <button type="button" className="tool-add" onClick={onDeactivate}>
                Deactivate
              </button>
            </>
          ) : (
            <>
              {record?.status === "notOptimizable" && (
                <button
                  type="button"
                  className="tool-add"
                  onClick={onRewriteCopy}
                  disabled={analyzing}
                >
                  <Lightning size={14} /> {analyzing ? "Analyzing…" : "Optimize a copy"}
                </button>
              )}
              <button
                type="button"
                className="tool-add"
                onClick={onOptimize}
                disabled={analyzing}
              >
                {record?.status === "notOptimizable" ? (
                  analyzing ? (
                    "…"
                  ) : (
                    "Try again"
                  )
                ) : (
                  <>
                    <Lightning size={14} /> {analyzing ? "Analyzing…" : "Optimize"}
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {record?.status === "notOptimizable" && record.reason !== undefined && (
        <p className="optimization-row__reason">{record.reason}</p>
      )}

      {record?.status === "notOptimizable" &&
        record.blockers !== undefined &&
        record.blockers.length > 0 && (
          <div className="optimization-row__blockers">
            <span className="optimization-row__blockers-title">
              To make it optimizable, edit the command file — or let "Optimize a copy"
              apply these for you:
            </span>
            <ul>
              {record.blockers.map((blocker) => (
                <li key={blocker.quote}>
                  <q>{blocker.quote}</q> — {blocker.advice}
                </li>
              ))}
            </ul>
          </div>
        )}

      {record?.status === "active" && (
        <>
          <p className="optimization-row__savings">{savingsLine(savings)}</p>
          {record.script !== undefined && (
            <details className="optimization-row__script">
              <summary>
                {record.instructions ? "View instructions and script" : "View script"}
              </summary>
              {record.instructions !== undefined && <pre>{record.instructions}</pre>}
              <pre>{record.script}</pre>
            </details>
          )}
        </>
      )}

      {stale && (
        <p className="optimization-row__reason">
          The command's file changed after this was analyzed
          {record?.status === "active" ? "; the approved script still runs" : ""} —
          re-optimize to catch up.
        </p>
      )}

      {activity.kind === "error" && (
        <p className="optimization-row__error">{activity.error}</p>
      )}

      {activity.kind === "proposal" && (
        <div className="optimization-row__proposal">
          {activity.summary !== undefined && (
            <p className="optimization-row__savings">{activity.summary}</p>
          )}
          <p className="optimization-row__reason">
            {activity.instructions !== undefined
              ? "Review before activating — a hybrid: the instructions stay a prompt " +
                "for the judgment part, and the script runs in one call for the rest. " +
                "Both replace the command's file at run time; edit either here."
              : "Review before activating — this script will run in your repository, " +
                "filled in and executed by the agent in one call. Edit it here if it " +
                "needs a touch-up."}
          </p>
          {activity.instructions !== undefined && (
            <textarea
              className="settings-input optimization-row__editor"
              aria-label={`Proposed instructions for ${command.name}`}
              value={activity.instructions}
              rows={Math.min(8, activity.instructions.split("\n").length + 1)}
              onChange={(e) => onEditInstructions(e.target.value)}
              spellCheck={false}
            />
          )}
          <textarea
            className="settings-input optimization-row__editor"
            aria-label={`Proposed script for ${command.name}`}
            value={activity.script}
            rows={Math.min(12, activity.script.split("\n").length + 1)}
            onChange={(e) => onEditScript(e.target.value)}
            spellCheck={false}
          />
          <div className="optimization-row__actions">
            <button
              type="button"
              className="tool-add"
              onClick={() => onActivate(activity)}
            >
              <Lightning size={14} /> Activate
            </button>
            <button type="button" className="tool-add" onClick={onDiscard}>
              Discard
            </button>
          </div>
        </div>
      )}

      {activity.kind === "copyProposal" && (
        <div className="optimization-row__proposal">
          {activity.summary !== undefined && (
            <p className="optimization-row__savings">{activity.summary}</p>
          )}
          <p className="optimization-row__reason">
            This creates a NEW command, {command.name}-optimized, next to the original —{" "}
            {command.name} itself is not touched. Review the rewritten command text and
            the script that will run for it; edit anything here before creating.
          </p>
          <textarea
            className="settings-input optimization-row__editor"
            aria-label={`Rewritten command for ${command.name}`}
            value={activity.command}
            rows={Math.min(14, activity.command.split("\n").length + 1)}
            onChange={(e) => onEditCommand(e.target.value)}
            spellCheck={false}
          />
          {activity.instructions !== undefined && (
            <textarea
              className="settings-input optimization-row__editor"
              aria-label={`Instructions for ${command.name}-optimized`}
              value={activity.instructions}
              rows={Math.min(8, activity.instructions.split("\n").length + 1)}
              onChange={(e) => onEditInstructions(e.target.value)}
              spellCheck={false}
            />
          )}
          <textarea
            className="settings-input optimization-row__editor"
            aria-label={`Script for ${command.name}-optimized`}
            value={activity.script}
            rows={Math.min(12, activity.script.split("\n").length + 1)}
            onChange={(e) => onEditScript(e.target.value)}
            spellCheck={false}
          />
          <div className="optimization-row__actions">
            <button
              type="button"
              className="tool-add"
              onClick={() => onCreateCopy(activity)}
            >
              <Lightning size={14} /> Create copy & activate
            </button>
            <button type="button" className="tool-add" onClick={onDiscard}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The measured outcome, phrased honestly — including "it got worse". */
function savingsLine(savings: CommandSavings | undefined): string {
  if (savings === undefined) return "Measuring savings…";
  const marker = savings.estimated ? "≈" : "";
  if (savings.baselineAvgTokens === null) {
    return "No baseline recorded — there were no earlier runs to compare against.";
  }
  if (savings.optimizedTurns === 0) {
    return `Baseline ${marker}${formatTokens(savings.baselineAvgTokens)} tokens per run — savings appear after the next run.`;
  }
  const runs = `${savings.optimizedTurns} run${savings.optimizedTurns === 1 ? "" : "s"}`;
  const saved = savings.savedTokens ?? 0;
  if (saved < 0) {
    return `${marker}${formatTokens(-saved)} tokens MORE than the baseline over ${runs} — this optimization is not paying off.`;
  }
  return `${marker}${formatTokens(saved)} tokens saved over ${runs} (baseline ${marker}${formatTokens(savings.baselineAvgTokens)}/run).`;
}
