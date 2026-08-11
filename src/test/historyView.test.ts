import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';

/**
 * The history provider's race and filtering rules under `node --test`, with a narrow vscode
 * stand-in. The provider itself stays the code under test; only the tree API it subclasses is
 * replaced, just as the monitor test does for its stateful editor seam.
 */
class StubEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      },
    };
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
  resourceUri?: unknown;

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
  Uri: { file: (value: string) => ({ fsPath: value }) },
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
const sessions = require('../sessions') as typeof import('../sessions');
const { HistoryViewProvider } = require('../historyView') as typeof import('../historyView');
/* eslint-enable @typescript-eslint/no-require-imports */

type SessionRecord = import('../sessions').SessionRecord;
type SessionGroup = import('../sessions').SessionGroup;

const originalDiscover = sessions.discoverSessions;
const originalIndex = sessions.indexCheckouts;
const originalGroup = sessions.groupSessionsByProject;
const originalMeasure = sessions.measureStore;

function session(id: string, preview: string, cwd = 'C:\\repo'): SessionRecord {
  return {
    id,
    timestamp: '2026-08-10T12:00:00.000Z',
    cwd,
    filePath: `${cwd}\\${id}.jsonl`,
    preview,
    sizeBytes: 10,
    modifiedAt: Date.now(),
  };
}

function patchSessions(overrides: {
  discoverSessions: typeof sessions.discoverSessions;
  indexCheckouts?: typeof sessions.indexCheckouts;
  groupSessionsByProject?: typeof sessions.groupSessionsByProject;
}): void {
  sessions.discoverSessions = overrides.discoverSessions;
  sessions.indexCheckouts = overrides.indexCheckouts ?? originalIndex;
  sessions.groupSessionsByProject = overrides.groupSessionsByProject ?? originalGroup;
  sessions.measureStore = async () => ({ fileCount: 1, totalBytes: 10 });
}

function restoreSessions(): void {
  sessions.discoverSessions = originalDiscover;
  sessions.indexCheckouts = originalIndex;
  sessions.groupSessionsByProject = originalGroup;
  sessions.measureStore = originalMeasure;
}

test('a refresh during the first scan re-renders after loading finishes', async () => {
  let resolveScan!: (value: SessionRecord[]) => void;
  const scan = new Promise<SessionRecord[]>((resolve) => {
    resolveScan = resolve;
  });
  patchSessions({
    discoverSessions: async () => scan,
    indexCheckouts: async () => new Map(),
  });

  try {
    const provider = new HistoryViewProvider(() => 20, () => 'C:\\codex');
    let changes = 0;
    provider.onDidChangeTreeData(() => {
      changes += 1;
    });

    const firstScan = provider.getChildren();
    const loading = await provider.getChildren();
    assert.deepEqual(loading, [{ kind: 'message', text: 'Reading Codex sessions…' }]);

    provider.refresh();
    resolveScan([session('a', 'alpha work')]);
    const firstResult = await firstScan;

    assert.equal(changes, 2, 'the refresh and the completed scan must both reach the tree');
    assert.equal(firstResult.some((node) => node.kind === 'project'), true);

    const followingResult = await provider.getChildren();
    assert.equal(followingResult.some((node) => node.kind === 'message'), false);
    assert.equal(followingResult.some((node) => node.kind === 'project'), true);
  } finally {
    restoreSessions();
  }
});

test('history filtering also filters sessions under repository checkouts', async () => {
  const alpha = session('a', 'alpha work', 'C:\\repo');
  const beta = session('b', 'beta work', 'C:\\repo-wt');
  const group: SessionGroup = {
    project: 'repo',
    cwd: 'C:\\repo',
    sessions: [alpha, beta],
    checkouts: [
      { cwd: 'C:\\repo', sessions: [alpha] },
      { cwd: 'C:\\repo-wt', worktree: 'feature', sessions: [beta] },
    ],
  };
  patchSessions({
    discoverSessions: async () => [alpha, beta],
    indexCheckouts: async () => new Map(),
    groupSessionsByProject: () => [group],
  });

  try {
    const provider = new HistoryViewProvider(() => 20, () => 'C:\\codex');
    provider.setFilter('alpha');

    const roots = await provider.getChildren();
    const project = roots.find((node) => node.kind === 'project');
    assert.ok(project && project.kind === 'project');
    assert.equal(project.group.sessions.length, 1);
    assert.equal(project.group.sessions[0]?.id, 'a');
    assert.equal(project.group.checkouts, undefined, 'one surviving checkout needs no extra level');

    const children = await provider.getChildren(project);
    assert.deepEqual(children.map((node) => node.kind), ['session']);
    assert.equal(children[0]?.kind === 'session' ? children[0].session.id : undefined, 'a');
  } finally {
    restoreSessions();
  }
});
