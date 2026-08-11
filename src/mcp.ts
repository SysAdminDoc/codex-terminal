import type { CodexMcpServerDefinition } from './inventory';

export interface McpStdioServerSpec {
  kind: 'stdio';
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerSpec {
  kind: 'streamable_http';
  label: string;
  url: string;
  headers: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

function addEnvironment(
  target: Record<string, string>,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined) {
      target[name] = value;
    }
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Convert Codex's configured servers into definitions the VS Code MCP client can consume.
 * Disabled entries are intentionally removed here, before they can reach the editor.
 * Environment values are passed through to the child process or HTTP client but are never
 * returned as text by this module.
 */
export function toMcpServerSpecs(
  definitions: readonly CodexMcpServerDefinition[],
  environment: NodeJS.ProcessEnv = process.env,
): McpServerSpec[] {
  return definitions
    .filter((definition) => definition.enabled)
    .map((definition): McpServerSpec => {
      if (definition.transport.type === 'stdio') {
        const env = { ...definition.transport.env };
        addEnvironment(env, definition.transport.envVars, environment);
        return {
          kind: 'stdio',
          label: definition.name,
          command: definition.transport.command,
          args: [...definition.transport.args],
          env,
          ...(definition.transport.cwd ? { cwd: definition.transport.cwd } : {}),
        };
      }

      const headers = { ...definition.transport.httpHeaders };
      for (const [header, environmentName] of Object.entries(definition.transport.envHttpHeaders)) {
        const value = environment[environmentName];
        if (value !== undefined) {
          headers[header] = value;
        }
      }
      const bearerTokenEnvironmentName = definition.transport.bearerTokenEnvVar;
      const bearerToken = bearerTokenEnvironmentName
        ? environment[bearerTokenEnvironmentName]
        : undefined;
      if (bearerToken !== undefined && !hasHeader(headers, 'authorization')) {
        headers.Authorization = `Bearer ${bearerToken}`;
      }
      return {
        kind: 'streamable_http',
        label: definition.name,
        url: definition.transport.url,
        headers,
      };
    });
}
