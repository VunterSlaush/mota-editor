import { ArrowClockwise, SignIn } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { PROVIDERS, type ProviderId } from "../../core/entities/provider";
import type { ProviderStatus, Readiness } from "../../core/ports/providerProbe";

interface Props {
  probe: (provider: ProviderId) => Promise<ProviderStatus>;
  signIn: (provider: ProviderId) => Promise<void>;
}

type Row = { checking: true } | { checking: false; status: ProviderStatus };

/**
 * UI — which agents can actually work right now.
 *
 * Checking launches each agent for real, so it runs on demand rather than
 * on every render. What it deliberately does NOT do is promise more than
 * it knows: opening a session proves the agent runs, not that anyone is
 * signed in, and only a completed turn settles that.
 */
export function SettingsProviders({ probe, signIn }: Props) {
  const [rows, setRows] = useState<Partial<Record<ProviderId, Row>>>({});

  const check = useCallback(
    async (provider: ProviderId) => {
      setRows((current) => ({ ...current, [provider]: { checking: true } }));
      try {
        const status = await probe(provider);
        setRows((current) => ({ ...current, [provider]: { checking: false, status } }));
      } catch (e) {
        setRows((current) => ({
          ...current,
          [provider]: {
            checking: false,
            status: {
              provider,
              readiness: "notInstalled",
              detail: e instanceof Error ? e.message : String(e),
              installHint: "",
              signInCommand: "",
            },
          },
        }));
      }
    },
    [probe],
  );

  useEffect(() => {
    for (const p of PROVIDERS) void check(p.id);
  }, [check]);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Providers</h2>
      <p className="settings-section__hint">
        Checking starts each agent and opens a session. That proves the agent runs — most
        CLIs only check your sign-in when the first message is sent, so a provider turns
        green once a message has gone through.
      </p>

      {PROVIDERS.map((provider) => {
        const row = rows[provider.id];
        const status = row?.checking === false ? row.status : undefined;
        return (
          <div className="provider-row" key={provider.id}>
            <span className={`provider-row__dot ${dotClass(row)}`} aria-hidden="true" />
            <div className="provider-row__text">
              <span className="provider-row__name">
                {provider.displayName}
                <span className="provider-row__vendor">{provider.vendor}</span>
              </span>
              <span className="provider-row__detail">{describe(row)}</span>
              {status?.readiness === "notInstalled" && status.installHint && (
                <code className="provider-row__hint">{status.installHint}</code>
              )}
              {status?.readiness === "signInRequired" && status.signInCommand && (
                <code className="provider-row__hint">{status.signInCommand}</code>
              )}
            </div>
            {status?.readiness === "signInRequired" && status.signInCommand && (
              <button
                type="button"
                className="provider-row__signin"
                onClick={() => void signIn(provider.id)}
              >
                <SignIn size={13} />
                Sign in
              </button>
            )}
            <button
              type="button"
              className="provider-row__recheck"
              disabled={row?.checking === true}
              onClick={() => void check(provider.id)}
            >
              <ArrowClockwise size={13} />
              {row?.checking === true ? "Checking…" : "Re-check"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const DOT_CLASS: Record<Readiness, string> = {
  ready: "provider-row__dot--ready",
  started: "provider-row__dot--unverified",
  signInRequired: "provider-row__dot--blocked",
  notInstalled: "provider-row__dot--missing",
};

function dotClass(row: Row | undefined): string {
  if (!row || row.checking) return "provider-row__dot--checking";
  return DOT_CLASS[row.status.readiness];
}

function describe(row: Row | undefined): string {
  if (!row || row.checking) return "Checking…";
  const { readiness, detail } = row.status;
  switch (readiness) {
    case "ready":
    case "started":
      return detail;
    case "signInRequired":
      return `Not signed in: ${detail}`;
    case "notInstalled":
      return `Not installed: ${detail}`;
  }
}
