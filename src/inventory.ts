/**
 * What Codex has plugged into it: marketplace plugins and MCP servers.
 *
 * Both come from Codex's own CLI (`codex plugin list --json`, `codex mcp list --json`) rather
 * than from `app-server`. The app server would answer the same questions, but it is off by
 * default and its protocol carries no compatibility guarantee, so the panel would be empty for
 * almost everyone. Both CLI calls return in ~200 ms and are read-only by construction.
 *
 * Pure — parsing only, no `vscode` and no child process — so the shapes are exercised against
 * captured output under `node --test`.
 */

export interface CodexPlugin {
  id: string;
  name: string;
  marketplace?: string;
  version?: string;
  installed: boolean;
  enabled: boolean;
}

export interface CodexMcpServer {
  name: string;
  enabled: boolean;
  /** Why Codex has it switched off, when it says. */
  disabledReason?: string;
  /** `stdio`, `http`, … — how Codex reaches it. */
  transport?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function plugin(entry: Record<string, unknown>): CodexPlugin | undefined {
  const name = text(entry.name) ?? text(entry.pluginId);
  if (!name) {
    return undefined;
  }
  return {
    id: text(entry.pluginId) ?? name,
    name,
    ...(text(entry.marketplaceName) ? { marketplace: text(entry.marketplaceName) } : {}),
    ...(text(entry.version) ? { version: text(entry.version) } : {}),
    installed: entry.installed === true,
    enabled: entry.enabled === true,
  };
}

/**
 * Parse `codex plugin list --json`.
 *
 * The payload is `{ installed: [...], available: [...] }`. Only `installed` is read: what is
 * merely offered by a marketplace is a shopping list, and this panel reports what a Codex run
 * will actually have. Returns undefined when the output is not the expected JSON at all —
 * which is also what a missing `codex` on PATH looks like, since the runner folds errors into
 * the text it resolves.
 */
export function parsePluginList(output: string): CodexPlugin[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const installed = root?.installed;
  if (!Array.isArray(installed)) {
    return undefined;
  }
  return installed
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map(plugin)
    .filter((entry): entry is CodexPlugin => entry !== undefined);
}

/**
 * Parse `codex mcp list --json`, whose payload is a bare array.
 *
 * `enabled` is reported per server together with a `disabled_reason`, which is the field worth
 * surfacing: a server configured but switched off looks identical to one that is missing
 * unless the reason is shown. Everything else in the entry — the command, its arguments and
 * its environment — is deliberately dropped, because that environment carries API tokens.
 */
export function parseMcpList(output: string): CodexMcpServer[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => {
      const name = text(entry.name);
      if (!name) {
        return undefined;
      }
      const transport = record(entry.transport);
      return {
        name,
        // Absent means enabled: Codex writes the flag only when it has an opinion, and
        // defaulting the other way would report a working server as switched off.
        enabled: entry.enabled !== false,
        ...(text(entry.disabled_reason) ? { disabledReason: text(entry.disabled_reason) } : {}),
        ...(text(transport?.type) ? { transport: text(transport?.type) } : {}),
      } satisfies CodexMcpServer;
    })
    .filter((entry): entry is CodexMcpServer => entry !== undefined);
}

/** One-line summary for a plugin row. */
export function describePlugin(entry: CodexPlugin): string {
  const parts: string[] = [];
  if (entry.version) {
    parts.push(entry.version);
  }
  if (!entry.enabled) {
    parts.push('disabled');
  }
  if (entry.marketplace) {
    parts.push(entry.marketplace);
  }
  return parts.join(' · ');
}

/** One-line summary for an MCP server row. */
export function describeMcpServer(entry: CodexMcpServer): string {
  const parts: string[] = [];
  if (entry.transport) {
    parts.push(entry.transport);
  }
  if (!entry.enabled) {
    parts.push(entry.disabledReason ? `disabled: ${entry.disabledReason}` : 'disabled');
  }
  return parts.join(' · ');
}
