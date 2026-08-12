import { ArrowsClockwise, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import {
  type ExtensionDescriptor,
  type ExtensionStatus,
  isDangerousPermission,
  permissionLabel,
} from "../../core/entities/extension";

interface Props {
  extensions: readonly ExtensionDescriptor[];
  /** Enabling opens a NATIVE consent dialog — this only asks. */
  onEnable: (id: string) => void;
  onDisable: (id: string) => void;
  onReload: () => void;
  readLog: (id: string) => Promise<string>;
}

const STATUS_LABEL: Record<ExtensionStatus, string> = {
  "needs-approval": "Needs approval",
  disabled: "Disabled",
  enabled: "Enabled",
  running: "Running",
  crashed: "Crashed",
  invalid: "Invalid manifest",
  incompatible: "Needs a newer Mota",
};

/**
 * UI — installed extensions: list by origin, enable behind the native
 * consent dialog, disable, and surface each one's log for authors.
 * Install is deliberately just a folder drop; this screen only reflects
 * the disk.
 */
export function SettingsExtensions({
  extensions,
  onEnable,
  onDisable,
  onReload,
  readLog,
}: Props) {
  const [logs, setLogs] = useState<Record<string, string>>({});

  const toggleLog = async (id: string) => {
    if (logs[id] !== undefined) {
      setLogs(({ [id]: _closed, ...rest }) => rest);
      return;
    }
    const text = await readLog(id);
    setLogs((prev) => ({ ...prev, [id]: text || "(the log is empty)" }));
  };

  const user = extensions.filter((e) => e.origin === "user");
  const project = extensions.filter((e) => e.origin === "project");

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Extensions</h2>
      <p className="settings-section__hint">
        An extension is a folder dropped into <code>~/.mota/extensions/</code> (or a
        repo's <code>.mota/extensions/</code>): a manifest plus, optionally, a script
        speaking JSON-RPC over stdio. Enabling one shows a system dialog listing exactly
        what it may do; extensions run with your user account — the permissions are
        informed consent, not a sandbox.
      </p>

      <button type="button" className="tool-add" onClick={onReload}>
        <ArrowsClockwise size={14} /> Reload list
      </button>

      {extensions.length === 0 && (
        <p className="settings-section__hint">No extensions installed.</p>
      )}

      {[
        { label: "Your extensions", items: user },
        { label: "From open projects", items: project },
      ]
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.label}>
            <h3 className="settings-section__subtitle">{group.label}</h3>
            {group.items.map((extension) => (
              <div className="extension-row" key={extension.id}>
                <div className="extension-row__main">
                  <span className="extension-row__name">
                    {extension.displayName}
                    {extension.version && (
                      <span className="extension-row__version">v{extension.version}</span>
                    )}
                    <span
                      className={`extension-row__status extension-row__status--${extension.status}`}
                    >
                      {STATUS_LABEL[extension.status]}
                    </span>
                  </span>
                  {extension.description && (
                    <span className="extension-row__description">
                      {extension.description}
                    </span>
                  )}
                  {extension.permissions.length > 0 && (
                    <span className="extension-row__permissions">
                      {extension.permissions.map((permission) => (
                        <span
                          key={permission}
                          className={`extension-row__permission ${
                            isDangerousPermission(permission)
                              ? "extension-row__permission--dangerous"
                              : ""
                          }`}
                          title={permission}
                        >
                          {isDangerousPermission(permission) && <Warning size={11} />}
                          {permissionLabel(permission)}
                        </span>
                      ))}
                    </span>
                  )}
                  {extension.error && (
                    <span className="extension-row__error">{extension.error}</span>
                  )}
                </div>
                <div className="extension-row__actions">
                  {(extension.status === "needs-approval" ||
                    extension.status === "disabled" ||
                    extension.status === "crashed") && (
                    <button
                      type="button"
                      className="tool-add extension-row__action"
                      onClick={() => onEnable(extension.id)}
                    >
                      {extension.status === "needs-approval" ? "Approve…" : "Enable"}
                    </button>
                  )}
                  {(extension.status === "enabled" || extension.status === "running") && (
                    <button
                      type="button"
                      className="tool-add extension-row__action"
                      onClick={() => onDisable(extension.id)}
                    >
                      Disable
                    </button>
                  )}
                  <button
                    type="button"
                    className="tool-add extension-row__action"
                    onClick={() => void toggleLog(extension.id)}
                  >
                    {logs[extension.id] !== undefined ? "Hide log" : "Show log"}
                  </button>
                </div>
                {logs[extension.id] !== undefined && (
                  <pre className="extension-row__log">{logs[extension.id]}</pre>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
