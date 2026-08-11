import type { AppSettings } from "../../core/state/appState";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

/**
 * A short list rather than a number box: every intermediate value a
 * typist passes through ("1" on the way to "14") is one the terminal
 * would have to accept and redraw at.
 */
const FONT_SIZES: readonly PickerOption<string>[] = [
  { id: "11", label: "11 px" },
  { id: "12", label: "12 px" },
  { id: "13", label: "13 px" },
  { id: "14", label: "14 px" },
  { id: "16", label: "16 px" },
  { id: "18", label: "18 px" },
];

/**
 * UI — terminal preferences: which shell the panel runs, and how big its
 * text is. Applies to terminals opened from here on; the ones already
 * running keep the shell they started with.
 */
export function SettingsTerminal({ settings, onChange }: Props) {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Terminal</h2>
      <p className="settings-section__hint">
        The terminal opens in the active project's folder — a worktree tab gets a shell in
        that worktree. Toggle it with <kbd>Ctrl</kbd> + <kbd>`</kbd>.
      </p>

      <Field
        label="Shell"
        hint="A program path, not a command. Blank uses the system default (PowerShell on Windows, your $SHELL elsewhere)."
      >
        <input
          className="settings-input"
          placeholder={defaultShellPlaceholder()}
          value={settings.terminalShell}
          onChange={(e) => onChange({ terminalShell: e.target.value })}
        />
      </Field>

      <Field label="Font size" hint="Applies to every terminal, open or not.">
        <OptionPicker
          ariaLabel="Terminal font size"
          options={FONT_SIZES}
          value={String(settings.terminalFontSize)}
          disabled={false}
          placement="bottom"
          align="end"
          onChange={(size) => onChange({ terminalFontSize: Number(size) })}
        />
      </Field>

      <Field
        label="Suggestions"
        hint="Greys in the rest of a command you run often; Tab or → accepts it. Ranked by how often you have run it, seeded from your shell's own history."
      >
        <label className="verbose-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-checked={settings.terminalSuggestions}
            aria-label="Terminal suggestions"
            className="switch__input"
            checked={settings.terminalSuggestions}
            onChange={(e) => onChange({ terminalSuggestions: e.target.checked })}
          />
          <span className="switch" aria-hidden="true" />
        </label>
      </Field>
    </div>
  );
}

/** Show the platform's own default, so the field explains itself. */
function defaultShellPlaceholder(): string {
  return navigator.userAgent.includes("Windows") ? "pwsh.exe" : "/bin/zsh";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field__text">
        <span className="settings-field__label">{label}</span>
        <span className="settings-field__hint">{hint}</span>
      </div>
      <div className="settings-field__control">{children}</div>
    </div>
  );
}
