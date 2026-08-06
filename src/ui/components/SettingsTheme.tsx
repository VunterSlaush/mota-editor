import { Check } from "@phosphor-icons/react";
import { THEMES, themeById } from "../../core/entities/theme";
import type { AppSettings } from "../../core/state/appState";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

/** UI — pick the app's color theme; applies (and saves) immediately. */
export function SettingsTheme({ settings, onChange }: Props) {
  const active = themeById(settings.theme).id;

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Theme</h2>
      <p className="settings-section__hint">
        Palettes in the spirit of well-known editors. Changes apply immediately.
      </p>

      <div className="theme-grid" role="radiogroup" aria-label="Color theme">
        {THEMES.map((theme) => (
          <button
            type="button"
            key={theme.id}
            role="radio"
            aria-checked={theme.id === active}
            className={`theme-card ${theme.id === active ? "theme-card--active" : ""}`}
            onClick={() => onChange({ theme: theme.id })}
          >
            <span
              className="theme-card__preview"
              style={{ background: theme.swatch[0] }}
              aria-hidden="true"
            >
              <span className="theme-card__dot" style={{ background: theme.swatch[1] }} />
              <span className="theme-card__dot" style={{ background: theme.swatch[2] }} />
              <span className="theme-card__dot" style={{ background: theme.swatch[3] }} />
            </span>
            <span className="theme-card__text">
              <span className="theme-card__label">
                {theme.label}
                {theme.id === active && <Check size={14} aria-hidden="true" />}
              </span>
              <span className="theme-card__hint">{theme.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
