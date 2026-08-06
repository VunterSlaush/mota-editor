import {
  Gauge,
  Palette,
  PlugsConnected,
  Sliders,
  TerminalWindow,
  Toolbox,
  X,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CommandInfo } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import type { ProviderStatus } from "../../core/ports/providerProbe";
import type { AppSettings, TabState } from "../../core/state/appState";
import { SettingsCommands } from "./SettingsCommands";
import { SettingsDefaults } from "./SettingsDefaults";
import { SettingsProviders } from "./SettingsProviders";
import { SettingsTheme } from "./SettingsTheme";
import { SettingsTools } from "./SettingsTools";
import { SettingsUsage } from "./SettingsUsage";

export type SettingsSection =
  | "defaults"
  | "commands"
  | "tools"
  | "providers"
  | "usage"
  | "theme";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  loadCommands: (provider: ProviderId) => Promise<CommandInfo[]>;
  probeProvider: (provider: ProviderId) => Promise<ProviderStatus>;
  /** The open tabs — the Usage section reads their live context usage. */
  tabs: readonly TabState[];
  newId: () => string;
  onClose: () => void;
}

const SECTIONS: readonly { id: SettingsSection; label: string; Icon: typeof Sliders }[] =
  [
    { id: "defaults", label: "Defaults", Icon: Sliders },
    { id: "commands", label: "Commands", Icon: TerminalWindow },
    { id: "tools", label: "Tools", Icon: Toolbox },
    { id: "providers", label: "Providers", Icon: PlugsConnected },
    { id: "usage", label: "Usage", Icon: Gauge },
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
  probeProvider,
  tabs,
  newId,
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
            />
          )}
          {section === "tools" && (
            <SettingsTools settings={settings} onChange={onChange} newId={newId} />
          )}
          {section === "providers" && <SettingsProviders probe={probeProvider} />}
          {section === "usage" && (
            <SettingsUsage settings={settings} onChange={onChange} tabs={tabs} />
          )}
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
