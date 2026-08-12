import { BUILTIN_COMMANDS, type CommandInfo } from "./command";
import type { McpServerConfig } from "./mcpServer";
import { PROVIDERS, type ProviderId } from "./provider";

/**
 * Entities layer — an installed extension as the workbench sees it.
 *
 * An extension is a folder with a manifest and (optionally) a process
 * speaking the Mota Extension Protocol over stdio (ADR-0012). Everything
 * here is the DESCRIPTOR the backend derived from the manifest — the
 * core never parses manifests or touches the wire.
 */
export type ExtensionPermission =
  | "commands:register"
  | "tools:register"
  | "events:subscribe"
  | "notifications"
  | "transcripts:read"
  | "agent:prompt"
  | "fs:project-read"
  | "ui:panel"
  | "ui:theme"
  | "shell:exec"
  | "provider:register";

export type ExtensionStatus =
  | "needs-approval"
  | "disabled"
  | "enabled"
  | "running"
  | "crashed"
  | "invalid"
  | "incompatible";

export interface ExtensionCommandContribution {
  /** Bare name, no leading slash (`standup`). */
  readonly name: string;
  readonly description: string;
  readonly argsHint?: string;
  readonly kind: "prompt" | "programmatic";
  /** The expansion text — present for prompt commands. */
  readonly template?: string;
}

export interface ExtensionMcpContribution {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ExtensionDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly origin: "user" | "project";
  readonly projectPath?: string;
  /** The install folder, for the settings screen. */
  readonly path: string;
  readonly permissions: readonly ExtensionPermission[];
  readonly status: ExtensionStatus;
  readonly error?: string;
  readonly commands: readonly ExtensionCommandContribution[];
  readonly mcpServers: readonly ExtensionMcpContribution[];
  readonly events: readonly string[];
}

/** Granted and switched on — its contributions count. A crashed process
 *  stays active: prompt commands and MCP servers need no process. */
export function isActive(extension: ExtensionDescriptor): boolean {
  return (
    extension.status === "enabled" ||
    extension.status === "running" ||
    extension.status === "crashed"
  );
}

/** Rendered with a warning badge in settings, mirroring the consent
 *  dialog's own ⚠ (the backend is the enforcer; this only displays). */
export function isDangerousPermission(permission: ExtensionPermission): boolean {
  return (
    permission === "shell:exec" ||
    permission === "agent:prompt" ||
    permission === "provider:register"
  );
}

export function permissionLabel(permission: ExtensionPermission): string {
  switch (permission) {
    case "commands:register":
      return "Slash commands";
    case "tools:register":
      return "Agent tools (MCP)";
    case "events:subscribe":
      return "Workbench events";
    case "notifications":
      return "Notifications";
    case "transcripts:read":
      return "Read transcripts";
    case "agent:prompt":
      return "Start agent turns";
    case "fs:project-read":
      return "Read project files";
    case "ui:panel":
      return "Sidebar panel";
    case "ui:theme":
      return "Themes";
    case "shell:exec":
      return "Run programs";
    case "provider:register":
      return "AI provider";
  }
}

/** The always-unambiguous form of an extension command's name. */
export function qualifiedCommandName(extensionId: string, command: string): string {
  return `/${extensionId}.${command}`;
}

/**
 * Expand a prompt-template command, matching the Claude custom-command
 * contract so authors' intuition transfers: `$ARGUMENTS` is replaced
 * where present, otherwise the arguments are appended.
 */
export function expandPromptCommand(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", args);
  return args.length > 0 ? `${template}\n\n${args}` : template;
}

/**
 * Extension commands as palette entries. Naming is deterministic: the
 * bare `/name`, unless a builtin or another extension claims it — then
 * only the qualified `/<ext>.<name>` is listed. (Extension commands
 * shadow same-named custom FILE commands by design; builtins always
 * win.) The qualified form additionally always resolves in
 * `findExtensionCommand`, so panel buttons and docs have a stable
 * address either way.
 */
export function commandsFromExtensions(
  extensions: readonly ExtensionDescriptor[],
  provider: ProviderId,
): CommandInfo[] {
  const builtinNames = new Set(BUILTIN_COMMANDS[provider].map((c) => c.name));
  const counts = new Map<string, number>();
  for (const extension of extensions.filter(isActive)) {
    for (const command of extension.commands) {
      const bare = `/${command.name}`;
      counts.set(bare, (counts.get(bare) ?? 0) + 1);
    }
  }
  const result: CommandInfo[] = [];
  for (const extension of extensions.filter(isActive)) {
    for (const command of extension.commands) {
      const bare = `/${command.name}`;
      const contested = builtinNames.has(bare) || (counts.get(bare) ?? 0) > 1;
      result.push({
        name: contested ? qualifiedCommandName(extension.id, command.name) : bare,
        description: command.description || `From ${extension.displayName}`,
        source: "extension",
        extensionId: extension.id,
      });
    }
  }
  return result;
}

export interface ExtensionCommandHit {
  readonly extension: ExtensionDescriptor;
  readonly command: ExtensionCommandContribution;
}

/**
 * The extension command a leading token names, or null. Accepts both the
 * qualified `/<ext>.<name>` and — under the same collision rules as
 * `commandsFromExtensions`, so typing and the palette agree — the bare
 * `/name`.
 */
export function findExtensionCommand(
  extensions: readonly ExtensionDescriptor[],
  provider: ProviderId,
  token: string,
): ExtensionCommandHit | null {
  if (!token.startsWith("/")) return null;
  const active = extensions.filter(isActive);

  const dot = token.indexOf(".");
  if (dot > 1) {
    const extensionId = token.slice(1, dot);
    const name = token.slice(dot + 1);
    const extension = active.find((e) => e.id === extensionId);
    const command = extension?.commands.find((c) => c.name === name);
    return extension && command ? { extension, command } : null;
  }

  if (BUILTIN_COMMANDS[provider].some((c) => c.name === token)) return null;
  const bare = token.slice(1);
  const hits: ExtensionCommandHit[] = [];
  for (const extension of active) {
    const command = extension.commands.find((c) => c.name === bare);
    if (command) hits.push({ extension, command });
  }
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * The MCP servers active extensions contribute, as derived rows for the
 * EXISTING mcpServer plumbing — never persisted, namespaced so uninstall
 * is a filter. Enabled for every provider; the per-project overrides
 * users already have apply to these ids like any other.
 */
export function extensionMcpServers(
  extensions: readonly ExtensionDescriptor[],
): McpServerConfig[] {
  const allProviders = PROVIDERS.map((p) => p.id);
  return extensions.filter(isActive).flatMap((extension) =>
    extension.mcpServers.map((server) => ({
      id: `ext:${extension.id}:${server.name}`,
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      enabledFor: allProviders,
    })),
  );
}
