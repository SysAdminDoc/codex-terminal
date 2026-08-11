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

/** The launchable parts of one server from `codex mcp list --json`. */
export interface CodexMcpServerDefinition {
  name: string;
  enabled: boolean;
  disabledReason?: string;
  transport:
    | {
        type: 'stdio';
        command: string;
        args: string[];
        env: Record<string, string>;
        envVars: string[];
        cwd?: string;
      }
    | {
        type: 'streamable_http';
        url: string;
        bearerTokenEnvVar?: string;
        httpHeaders: Record<string, string>;
        envHttpHeaders: Record<string, string>;
      };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function stringMap(value: unknown): Record<string, string> {
  const object = record(value);
  if (!object) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function transportType(entry: Record<string, unknown>): string | undefined {
  const transport = record(entry.transport);
  return text(transport?.type) ?? text(entry.transport);
}

function entries(output: string): Record<string, unknown>[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    return parsed
      .map((entry) => record(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  }

  const root = record(parsed);
  // Codex 0.147 emits a single object when one server is configured. Keep accepting that
  // shape alongside the array emitted by older versions and by multi-server configurations.
  return root && text(root.name) ? [root] : undefined;
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

export const REDACTED = '«redacted»';

/** Key names whose values are never worth seeing and frequently worth hiding. */
const SENSITIVE_KEY = /(token|secret|key|password|passwd|auth|credential|cookie)/i;

/**
 * Blank out anything secret-shaped before text from the Codex CLI is shown or logged.
 *
 * The UI drops an MCP server's `env` precisely because it carries API tokens — and then the
 * failure path wrote the raw output to the log file, which is the same payload with none of
 * the care. A parse failure is exactly when that happens: the CLI succeeded, printed the
 * environment, and only the *shape* was unexpected.
 *
 * Regex rather than a JSON walk, deliberately: this runs on output that failed to parse, so
 * there is no object to walk. It is not a general-purpose scrubber and does not need to be —
 * it needs to keep a token out of a log file while leaving the surrounding error legible.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // Every value inside an `env` object, which is the block the UI already refuses to show.
      .replace(/("env"\s*:\s*)\{[^{}]*\}/gi, `$1{${JSON.stringify(REDACTED)}}`)
      // `"anything_token": "value"`, whatever the surrounding structure turned out to be.
      .replace(
        /("[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
        (match, prefix: string) =>
          SENSITIVE_KEY.test(prefix) ? `${prefix}${JSON.stringify(REDACTED)}` : match,
      )
      // Bare credentials that never had a key: bearer tokens and provider-prefixed keys.
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
      .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp)[-_][A-Za-z0-9_-]{12,}/g, REDACTED)
  );
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
  const parsed = entries(output);
  if (!parsed) {
    return undefined;
  }
  return parsed
    .map((entry) => {
      const name = text(entry.name);
      if (!name) {
        return undefined;
      }
      return {
        name,
        // Absent means enabled: Codex writes the flag only when it has an opinion, and
        // defaulting the other way would report a working server as switched off.
        enabled: entry.enabled !== false,
        ...(text(entry.disabled_reason) ? { disabledReason: text(entry.disabled_reason) } : {}),
        ...(transportType(entry) ? { transport: transportType(entry) } : {}),
      } satisfies CodexMcpServer;
    })
    .filter((entry): entry is CodexMcpServer => entry !== undefined);
}

/**
 * Parse the launch configuration needed by VS Code's MCP client.
 *
 * This deliberately lives beside the safe display parser but is a separate result: the MCP
 * client needs the configured environment and headers to start a server, while the sidebar and
 * logs must never retain those values. Callers must pass the result straight to the client and
 * must not render or log it.
 */
export function parseMcpDefinitions(output: string): CodexMcpServerDefinition[] | undefined {
  const parsed = entries(output);
  if (!parsed) {
    return undefined;
  }
  return parsed
    .map((entry): CodexMcpServerDefinition | undefined => {
      const name = text(entry.name);
      const transport = record(entry.transport);
      const type = transportType(entry);
      if (!name || !transport || !type) {
        return undefined;
      }

      const common = {
        name,
        enabled: entry.enabled !== false,
        ...(text(entry.disabled_reason) ? { disabledReason: text(entry.disabled_reason) } : {}),
      };
      if (type === 'stdio') {
        const command = text(transport.command);
        if (!command) {
          return undefined;
        }
        return {
          ...common,
          transport: {
            type: 'stdio',
            command,
            args: strings(transport.args),
            env: stringMap(transport.env),
            envVars: strings(transport.env_vars),
            ...(text(transport.cwd) ? { cwd: text(transport.cwd) } : {}),
          },
        };
      }

      if (type === 'streamable_http') {
        const url = text(transport.url);
        if (!url) {
          return undefined;
        }
        return {
          ...common,
          transport: {
            type: 'streamable_http',
            url,
            ...(text(transport.bearer_token_env_var)
              ? { bearerTokenEnvVar: text(transport.bearer_token_env_var) }
              : {}),
            httpHeaders: stringMap(transport.http_headers),
            envHttpHeaders: stringMap(transport.env_http_headers),
          },
        };
      }

      return undefined;
    })
    .filter((entry): entry is CodexMcpServerDefinition => entry !== undefined);
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
