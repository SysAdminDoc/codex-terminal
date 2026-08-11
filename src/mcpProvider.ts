import * as vscode from 'vscode';

import { parseMcpDefinitions } from './inventory';
import { toMcpServerSpecs } from './mcp';

const PROVIDER_ID = 'codexTerminal.mcp';
const CACHE_MS = 5_000;

type ReadMcpConfiguration = () => Promise<string>;

interface LanguageModelApi {
  registerMcpServerDefinitionProvider?: (
    id: string,
    provider: vscode.McpServerDefinitionProvider,
  ) => vscode.Disposable;
}

export interface McpProviderRegistration extends vscode.Disposable {
  refresh(): void;
}

function definitions(
  specs: ReturnType<typeof toMcpServerSpecs>,
): vscode.McpServerDefinition[] {
  const result: vscode.McpServerDefinition[] = [];
  for (const spec of specs) {
    try {
      if (spec.kind === 'stdio') {
        const definition = new vscode.McpStdioServerDefinition(
          spec.label,
          spec.command,
          spec.args,
          spec.env,
        );
        if (spec.cwd) {
          definition.cwd = vscode.Uri.file(spec.cwd);
        }
        result.push(definition);
      } else {
        result.push(
          new vscode.McpHttpServerDefinition(spec.label, vscode.Uri.parse(spec.url), spec.headers),
        );
      }
    } catch {
      // A malformed configured URL or path should not make the whole provider unavailable.
    }
  }
  return result;
}

/**
 * Register Codex's configured MCP servers when the host has the stable provider API.
 *
 * The extension still supports hosts older than the 1.101 API. On those hosts this returns
 * undefined and the existing Launch-panel inventory remains the only MCP surface.
 */
export function registerMcpServerProvider(
  read: ReadMcpConfiguration,
): McpProviderRegistration | undefined {
  const languageModels = (vscode as unknown as { lm?: LanguageModelApi }).lm;
  const register = languageModels?.registerMcpServerDefinitionProvider;
  if (typeof register !== 'function') {
    return undefined;
  }

  const changes = new vscode.EventEmitter<void>();
  let cache: { at: number; definitions: vscode.McpServerDefinition[] } | undefined;
  let pending: Promise<vscode.McpServerDefinition[]> | undefined;
  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: changes.event,
    provideMcpServerDefinitions: async (token) => {
      if (token.isCancellationRequested) {
        return [];
      }
      if (cache && Date.now() - cache.at < CACHE_MS) {
        return cache.definitions;
      }
      pending ??= read()
        .then((output) => {
          const parsed = parseMcpDefinitions(output);
          return parsed ? definitions(toMcpServerSpecs(parsed)) : [];
        })
        .catch(() => [])
        .then((result) => {
          cache = { at: Date.now(), definitions: result };
          return result;
        })
        .finally(() => {
          pending = undefined;
        });
      const result = await pending;
      return token.isCancellationRequested ? [] : result;
    },
  };

  let registration: vscode.Disposable;
  try {
    registration = register.call(languageModels, PROVIDER_ID, provider);
  } catch {
    changes.dispose();
    return undefined;
  }

  let disposed = false;
  return {
    refresh: () => {
      cache = undefined;
      changes.fire();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      registration.dispose();
      changes.dispose();
    },
  };
}
