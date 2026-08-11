import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * The Launch panel's inventory sections, with a stubbed `vscode`.
 *
 * Same technique as `monitor.test.ts`: the module loader hands the tree provider a stand-in for
 * `vscode`, so the class under test is the one that ships. What matters here is not the row
 * text but *when the CLI runs* — the tree refreshes several times a minute while a turn is in
 * flight, and a section that spawned a process per refresh would be a background process storm
 * nobody would ever attribute to a collapsed panel.
 */
class StubEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

class StubTreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  accessibilityInformation?: unknown;

  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

const vscodeStub = {
  EventEmitter: StubEmitter,
  TreeItem: StubTreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(
      readonly id: string,
      readonly color?: unknown,
    ) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  MarkdownString: class {
    constructor(readonly value: string) {}
  },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
  },
};

interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as LoaderInternals;
const originalLoad = loader._load;
loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { ActionsViewProvider } = require('../actionsView') as typeof import('../actionsView');
type InventoryGroup = import('../actionsView').InventoryGroup;
/* eslint-enable @typescript-eslint/no-require-imports */

const PLUGIN_JSON = JSON.stringify({
  installed: [
    {
      pluginId: 'documents@openai-primary-runtime',
      name: 'documents',
      marketplaceName: 'openai-primary-runtime',
      version: '26.805.11740',
      installed: true,
      enabled: true,
    },
    { pluginId: 'pdf@openai-primary-runtime', name: 'pdf', installed: true, enabled: false },
  ],
  available: [],
});

const MCP_JSON = JSON.stringify([
  { name: 'node_repl', enabled: true, disabled_reason: null, transport: { type: 'stdio' } },
]);

function provider(run: (args: readonly string[]) => Promise<string>): {
  view: InstanceType<typeof ActionsViewProvider>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const monitor = {
    live: () => [],
    workingCount: () => 0,
    stalledCount: () => 0,
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const view = new ActionsViewProvider(
    monitor as never,
    () => 45,
    () => true,
    () => ({}),
    () => undefined,
    (args) => {
      calls.push([...args]);
      return run(args);
    },
  );
  return { view, calls };
}

test('the launch panel offers the plugin and MCP sections, collapsed', async () => {
  const { view, calls } = provider(() => Promise.resolve(PLUGIN_JSON));
  const roots = await view.getChildren();
  const groups = roots.filter(
    (node): node is InventoryGroup =>
      typeof node === 'object' && (node as { kind?: string }).kind === 'inventory-group',
  );
  assert.deepEqual(
    groups.map((group) => group.of),
    ['plugins', 'mcp'],
  );
  // Collapsed, and nothing has run: an unopened section must not cost a process.
  assert.equal(view.getTreeItem(groups[0]).collapsibleState, 1);
  assert.ok(view.getTreeItem(groups[0]).accessibilityInformation);
  assert.equal(calls.length, 0);
});

test('expanding a section runs its command once and reuses the answer', async () => {
  const { view, calls } = provider((args) =>
    Promise.resolve(args[0] === 'plugin' ? PLUGIN_JSON : MCP_JSON),
  );
  const group = { kind: 'inventory-group' as const, of: 'plugins' as const };

  const first = await view.getChildren(group);
  assert.equal(first.length, 2);
  await view.getChildren(group);
  await view.getChildren(group);
  assert.deepEqual(calls, [['plugin', 'list', '--json']]);

  const rows = first.map((node) => view.getTreeItem(node));
  assert.equal(rows[0].label, 'documents');
  assert.match(String(rows[0].description), /26\.805\.11740/);
  // A disabled plugin has to read as disabled; "installed" alone would be a lie about what a
  // Codex run will have.
  assert.match(String(rows[1].description), /disabled/);
});

test('each section reads its own command', async () => {
  const { view, calls } = provider((args) =>
    Promise.resolve(args[0] === 'plugin' ? PLUGIN_JSON : MCP_JSON),
  );
  const servers = await view.getChildren({ kind: 'inventory-group', of: 'mcp' });
  assert.deepEqual(calls, [['mcp', 'list', '--json']]);
  const row = view.getTreeItem(servers[0]);
  assert.equal(row.label, 'node_repl');
  assert.match(String(row.description), /stdio/);
});

test('an unreadable list says so in the row instead of showing an empty section', async () => {
  // A missing `codex` on PATH arrives here as prose, not JSON. Rendering that as "no plugins
  // installed" would be a confident wrong answer.
  const { view } = provider(() => Promise.resolve('Codex CLI command "codex" was not found.'));
  const rows = await view.getChildren({ kind: 'inventory-group', of: 'plugins' });
  assert.equal(rows.length, 1);
  const item = view.getTreeItem(rows[0]);
  assert.match(String(item.label), /Could not read the plugin list/);
  assert.match(String(item.label), /was not found/);
});

test('an empty inventory is stated, not left blank', async () => {
  const { view } = provider((args) =>
    Promise.resolve(args[0] === 'plugin' ? '{"installed":[],"available":[]}' : '[]'),
  );
  const plugins = await view.getChildren({ kind: 'inventory-group', of: 'plugins' });
  assert.match(String(view.getTreeItem(plugins[0]).label), /No plugins installed/);
  const servers = await view.getChildren({ kind: 'inventory-group', of: 'mcp' });
  assert.match(String(view.getTreeItem(servers[0]).label), /No MCP servers configured/);
});
