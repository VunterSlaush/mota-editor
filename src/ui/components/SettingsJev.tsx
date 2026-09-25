import { ArrowSquareOut, FloppyDisk, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { JevSettings } from "../../core/entities/jev";
import type { JevKeyStatus, JevKeyStore } from "../../core/ports/jevKeyStore";
import type { AppSettings } from "../../core/state/appState";
import { openExternalLink } from "../externalLink";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  jevKeys: JevKeyStore;
}

const TYPESAFE_URL = "https://typesafe.ai";

/**
 * UI — Jev, a second opinion on the agent (ADR-0025). The key field is
 * write-only: it is never filled from the backend, because the backend
 * never hands the key back.
 */
export function SettingsJev({ settings, onChange, jevKeys }: Props) {
  const jev = settings.jev;
  const [status, setStatus] = useState<JevKeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await jevKeys.status().catch(() => null));
  }, [jevKeys]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const change = (patch: Partial<JevSettings>) => onChange({ jev: { ...jev, ...patch } });

  const save = async () => {
    setProblem(null);
    try {
      await jevKeys.setKey(key.trim());
      setKey("");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  };

  const remove = async () => {
    setProblem(null);
    await jevKeys.clearKey().catch((e: unknown) => setProblem(String(e)));
    await refresh();
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Jev</h2>
      <p className="settings-section__hint">
        Jev is a fast classifier from TypeSafe AI. Mota asks it fixed yes/no questions
        about the agent's tool calls and finished turns. It is a second opinion, never an
        authority: if Jev is unreachable, everything works exactly as it does with Jev
        off.
      </p>
      <div className="settings-section__actions">
        <button
          type="button"
          className="tool-add"
          onClick={() => openExternalLink(TYPESAFE_URL)}
        >
          <ArrowSquareOut size={14} /> Get a key at typesafe.ai
        </button>
      </div>

      <Field label="Enable Jev" hint="Nothing below runs while this is off.">
        <Switch
          label="Enable Jev"
          checked={jev.enabled}
          onChange={(enabled) => change({ enabled })}
        />
      </Field>

      <Field
        label="Risk gate"
        hint="Under Bypass or Auto, a call Jev rates risky is shown to you instead of approved. Adds the “Auto with Jev” permission."
      >
        <Switch
          label="Risk gate"
          checked={jev.gate}
          disabled={!jev.enabled}
          onChange={(gate) => change({ gate })}
        />
      </Field>

      <Field
        label="Turn judge"
        hint="After each turn, a badge on your prompt says whether the agent looks done, and flags the tab when it does not."
      >
        <Switch
          label="Turn judge"
          checked={jev.judge}
          disabled={!jev.enabled}
          onChange={(judge) => change({ judge })}
        />
      </Field>

      <h3 className="settings-section__subtitle">API key</h3>
      <p className="settings-section__hint">{describeStatus(status)}</p>
      <div className="settings-section__actions">
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            status?.configured ? "Replace the saved key" : "Paste your TypeSafe key"
          }
          aria-label="Jev API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className="tool-add"
          disabled={key.trim() === ""}
          onClick={() => void save()}
        >
          <FloppyDisk size={14} /> Save
        </button>
        <button
          type="button"
          className="tool-add"
          disabled={status?.source !== "file"}
          onClick={() => void remove()}
        >
          <Trash size={14} /> Remove
        </button>
      </div>
      {problem && <p className="insights-error">{problem}</p>}
    </div>
  );
}

function describeStatus(status: JevKeyStatus | null): string {
  if (!status) return "Checking…";
  const curl = status.curlFound ? "" : " curl not found on PATH — Jev cannot be reached.";
  switch (status.source) {
    case "file":
      return `Key configured (saved here).${curl}`;
    case "env":
      return `Key configured (from TYPESAFE_API_KEY).${curl}`;
    case "none":
      return `No key yet. Save one here, or set TYPESAFE_API_KEY.${curl}`;
  }
}

function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="verbose-toggle">
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch__input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
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
