import {
  ChartBar,
  Gauge,
  GitFork,
  Palette,
  PlugsConnected,
  PuzzlePiece,
  Sliders,
  Terminal,
  TerminalWindow,
  Toolbox,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CommandInfo } from "../../core/entities/command";
import type { ExtensionDescriptor } from "../../core/entities/extension";
import type { InsightsRange, InsightsReport } from "../../core/entities/insights";
import type { ProviderId } from "../../core/entities/provider";
import type { SubagentInfo } from "../../core/entities/subagent";
import type { BoundaryPreset } from "../../core/entities/subtask";
import type { ProvisionEntry } from "../../core/entities/worktree";
import type { McpProbe } from "../../core/ports/mcpProbe";
import type { ProviderStatus } from "../../core/ports/providerProbe";
import type { AppSettings, TabState } from "../../core/state/appState";
import type { SuggestedPresets } from "../../core/usecases/subtasks";
import { APP_VERSION } from "../version";
import { SettingsCommands } from "./SettingsCommands";
import { SettingsDefaults } from "./SettingsDefaults";
import { SettingsExtensions } from "./SettingsExtensions";
import { SettingsInsights } from "./SettingsInsights";
import { SettingsProviders } from "./SettingsProviders";
import { SettingsSubtasks } from "./SettingsSubtasks";
import { SettingsTerminal } from "./SettingsTerminal";
import { SettingsTheme } from "./SettingsTheme";
import { SettingsTools } from "./SettingsTools";
import { SettingsUsage } from "./SettingsUsage";
import { SettingsWorktrees } from "./SettingsWorktrees";

export type SettingsSection =
  | "defaults"
  | "commands"
  | "tools"
  | "extensions"
  | "providers"
  | "worktrees"
  | "subtasks"
  | "terminal"
  | "usage"
  | "insights"
  | "theme";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  loadCommands: (provider: ProviderId) => Promise<CommandInfo[]>;
  loadSubagents: (provider: ProviderId) => Promise<SubagentInfo[]>;
  probeProvider: (provider: ProviderId) => Promise<ProviderStatus>;
  /** Opens the provider's own login prompt in a terminal. */
  signInProvider: (provider: ProviderId) => Promise<void>;
  /** Historical usage report for the Insights section. */
  loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
  /** The open tabs — the Usage section reads their live context usage. */
  tabs: readonly TabState[];
  /** The tab the Tools section scopes servers for; null with none open. */
  activeTab: TabState | null;
  mcpProbe: McpProbe;
  onScopeMcpServer: (serverId: string, enabled: boolean | undefined) => void;
  /** The active project's own heavy-folder list; undefined follows the default. */
  onScopeProvisioning: (entries: readonly ProvisionEntry[] | undefined) => void;
  newId: () => string;
  /** Installed extensions and their lifecycle, for the Extensions section. */
  extensions: readonly ExtensionDescriptor[];
  onEnableExtension: (id: string) => void;
  onDisableExtension: (id: string) => void;
  onReloadExtensions: () => void;
  readExtensionLog: (id: string) => Promise<string>;
  /** Whether this disk clones; null until the probe answers. */
  supportsCow: boolean | null;
  /** The active project's folders, for the Worktrees path suggestions. */
  loadFolders?: () => Promise<string[]>;
  /** The active project's named subtask areas: save, and propose with an agent. */
  onSaveBoundaryPresets: (
    presets: readonly BoundaryPreset[],
  ) => Promise<string | undefined>;
  onSuggestBoundaryPresets: () => Promise<SuggestedPresets>;
  onClose: () => void;
}

const SECTIONS: readonly { id: SettingsSection; label: string; Icon: typeof Sliders }[] =
  [
    { id: "defaults", label: "Defaults", Icon: Sliders },
    { id: "commands", label: "Commands", Icon: TerminalWindow },
    { id: "tools", label: "Tools", Icon: Toolbox },
    { id: "extensions", label: "Extensions", Icon: PuzzlePiece },
    { id: "providers", label: "Providers", Icon: PlugsConnected },
    { id: "worktrees", label: "Worktrees", Icon: GitFork },
    { id: "subtasks", label: "Subtasks", Icon: TreeStructure },
    { id: "terminal", label: "Terminal", Icon: Terminal },
    { id: "usage", label: "Usage", Icon: Gauge },
    { id: "insights", label: "Insights", Icon: ChartBar },
    { id: "theme", label: "Theme", Icon: Palette },
  ];

/**
 * UI — settings as a modal over the workbench, the way VS Code opens its
 * settings: a nav of sections on the left, one section at a time on the
 * right. Every change saves immediately; there is no OK button to forget.
 */
export function SettingsModal({
  settings,
  onChange,
  loadCommands,
  loadSubagents,
  probeProvider,
  signInProvider,
  loadInsights,
  tabs,
  activeTab,
  mcpProbe,
  onScopeMcpServer,
  onScopeProvisioning,
  newId,
  extensions,
  onEnableExtension,
  onDisableExtension,
  onReloadExtensions,
  readExtensionLog,
  supportsCow,
  loadFolders,
  onSaveBoundaryPresets,
  onSuggestBoundaryPresets,
  onClose,
}: Props) {
  const [section, setSection] = useState<SettingsSection>("defaults");

  // Escape closes from anywhere in the dialog, including the pickers.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-modal__nav" aria-label="Settings sections">
          <span className="settings-modal__title">Settings</span>
          {SECTIONS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`settings-modal__nav-item ${
                section === item.id ? "settings-modal__nav-item--active" : ""
              }`}
              onClick={() => setSection(item.id)}
            >
              <item.Icon size={16} />
              {item.label}
            </button>
          ))}
          {/* Under the sections, where an About box would be if this
              modal had one — the version is the only thing such a box
              would have said. */}
          <span className="settings-modal__version">Mota Editor {APP_VERSION}</span>
        </nav>
        <div className="settings-modal__body">
          {section === "defaults" && (
            <SettingsDefaults settings={settings} onChange={onChange} />
          )}
          {section === "commands" && (
            <SettingsCommands
              settings={settings}
              onChange={onChange}
              loadCommands={loadCommands}
              loadSubagents={loadSubagents}
            />
          )}
          {section === "tools" && (
            <SettingsTools
              settings={settings}
              onChange={onChange}
              newId={newId}
              activeTab={activeTab}
              mcpProbe={mcpProbe}
              onOverrideChange={onScopeMcpServer}
            />
          )}
          {section === "extensions" && (
            <SettingsExtensions
              extensions={extensions}
              onEnable={onEnableExtension}
              onDisable={onDisableExtension}
              onReload={onReloadExtensions}
              readLog={readExtensionLog}
            />
          )}
          {section === "providers" && (
            <SettingsProviders probe={probeProvider} signIn={signInProvider} />
          )}
          {section === "worktrees" && (
            <SettingsWorktrees
              settings={settings}
              onChange={onChange}
              activeTab={activeTab}
              onScopeProvisioning={onScopeProvisioning}
              supportsCow={supportsCow}
              loadFolders={loadFolders}
            />
          )}
          {section === "subtasks" && (
            <SettingsSubtasks
              activeTab={activeTab}
              onSave={onSaveBoundaryPresets}
              onSuggest={onSuggestBoundaryPresets}
              loadFolders={loadFolders}
              newId={newId}
            />
          )}
          {section === "terminal" && (
            <SettingsTerminal settings={settings} onChange={onChange} />
          )}
          {section === "usage" && (
            <SettingsUsage
              settings={settings}
              onChange={onChange}
              tabs={tabs}
              loadInsights={loadInsights}
            />
          )}
          {section === "insights" && <SettingsInsights loadInsights={loadInsights} />}
          {section === "theme" && (
            <SettingsTheme settings={settings} onChange={onChange} />
          )}
        </div>
        <button
          type="button"
          className="settings-modal__close"
          aria-label="Close settings"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
