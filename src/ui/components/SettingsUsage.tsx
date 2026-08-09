import { AUTO_COMPACT_POLICIES } from "../../core/entities/agentSettings";
import { formatTokens } from "../../core/entities/tokens";
import type { AppSettings, TabState } from "../../core/state/appState";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** The open tabs, for the live per-session usage readout. */
  tabs: readonly TabState[];
}

/** The auto-compact ceiling is picked from sane bounds, not free text:
 *  below 50% compaction would thrash, above 95% it fires too late. */
const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 95;

/**
 * UI — context usage per open session, and the knob for how full a
 * session's context may get before it auto-compacts. The window SIZE
 * belongs to each model and cannot be changed here; the ceiling can.
 */
export function SettingsUsage({ settings, onChange, tabs }: Props) {
  const percent = Math.round(settings.autoCompactThreshold * 100);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Usage</h2>
      <p className="settings-section__hint">
        Each session's context window is set by its model. What you can choose is how full
        a session may get before Mota asks the agent to compact the conversation.
      </p>

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">When the context fills up</span>
          <span className="settings-field__hint">
            Compacting costs a full pass over the conversation and a fresh cache on the
            next turn; a new chat costs nothing but starts the agent empty.
          </span>
        </div>
        <div className="settings-field__control">
          <OptionPicker
            ariaLabel="What happens when a session's context fills up"
            placement="bottom"
            disabled={false}
            value={settings.autoCompact}
            options={AUTO_COMPACT_POLICIES.map((p) => ({
              id: p.id,
              label: p.label,
              description: p.description,
            }))}
            onChange={(autoCompact) => onChange({ autoCompact })}
          />
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">Auto-compact at</span>
          <span className="settings-field__hint">
            Applies to every session. Currently {percent}% of the context window.
          </span>
        </div>
        <div className="settings-field__control usage-threshold">
          <input
            type="range"
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={5}
            value={percent}
            aria-label="Context percentage at which sessions auto-compact"
            onChange={(e) =>
              onChange({ autoCompactThreshold: Number(e.target.value) / 100 })
            }
          />
          <span className="usage-threshold__value">{percent}%</span>
        </div>
      </div>

      <h3 className="settings-section__subtitle">Open sessions</h3>
      {tabs.length === 0 && (
        <p className="settings-section__hint">No projects are open.</p>
      )}
      {tabs.map((tab) => {
        const usage = tab.usage;
        const fraction =
          usage && usage.size > 0 ? Math.min(usage.used / usage.size, 1) : 0;
        const over = fraction >= settings.autoCompactThreshold;
        return (
          <div className="usage-row" key={tab.project.id}>
            <div className="usage-row__text">
              <span className="usage-row__name">{tab.project.name}</span>
              <span className="usage-row__provider">{tab.project.provider}</span>
            </div>
            {usage && usage.size > 0 ? (
              <div className="usage-row__reading">
                <div
                  className="usage-row__bar"
                  role="img"
                  aria-label={`${Math.round(fraction * 100)} percent of context used`}
                >
                  <div
                    className={`usage-row__fill ${over ? "usage-row__fill--over" : ""}`}
                    style={{ width: `${fraction * 100}%` }}
                  />
                </div>
                <span className="usage-row__numbers">
                  {usage.estimated ? "≈ " : ""}
                  {formatTokens(usage.used)} / {formatTokens(usage.size)} (
                  {Math.round(fraction * 100)}%)
                </span>
              </div>
            ) : (
              <span className="usage-row__numbers usage-row__numbers--none">
                No usage reported yet
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
