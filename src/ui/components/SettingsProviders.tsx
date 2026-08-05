import { ArrowClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { PROVIDERS, type ProviderId } from "../../core/entities/provider";
import type { ProviderStatus } from "../../core/ports/providerProbe";

interface Props {
  probe: (provider: ProviderId) => Promise<ProviderStatus>;
}

type Row = { checking: true } | { checking: false; status: ProviderStatus };

/**
 * UI — which agents can actually work right now. Checking launches each
 * agent for real, so it runs on demand rather than on every render.
 */
export function SettingsProviders({ probe }: Props) {
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
              installed: false,
              authenticated: false,
              detail: e instanceof Error ? e.message : String(e),
              installHint: "",
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
        Checking starts each agent and opens a session — the same thing a real turn does,
        so a green light here means it will work.
      </p>

      {PROVIDERS.map((provider) => {
        const row = rows[provider.id];
        return (
          <div className="provider-row" key={provider.id}>
            <span className={`provider-row__dot ${dotClass(row)}`} aria-hidden="true" />
            <div className="provider-row__text">
              <span className="provider-row__name">
                {provider.displayName}
                <span className="provider-row__vendor">{provider.vendor}</span>
              </span>
              <span className="provider-row__detail">{describe(row)}</span>
              {row?.checking === false &&
                !row.status.installed &&
                row.status.installHint && (
                  <code className="provider-row__hint">{row.status.installHint}</code>
                )}
            </div>
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

function dotClass(row: Row | undefined): string {
  if (!row || row.checking) return "provider-row__dot--checking";
  if (row.status.authenticated) return "provider-row__dot--ready";
  if (row.status.installed) return "provider-row__dot--blocked";
  return "provider-row__dot--missing";
}

function describe(row: Row | undefined): string {
  if (!row || row.checking) return "Checking…";
  if (row.status.authenticated) return row.status.detail;
  if (row.status.installed) {
    return `Installed, but not ready: ${row.status.detail}`;
  }
  return `Not installed: ${row.status.detail}`;
}
