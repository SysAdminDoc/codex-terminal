import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

/**
 * `SessionMonitor` under `node --test`, with no editor.
 *
 * It is the only stateful module that touches `vscode`, and the four things it uses —
 * `EventEmitter`, `Disposable`, `Terminal`, `LogOutputChannel` — are narrow enough to stand
 * in for. Rather than restructure the class around an injected port, the module loader is
 * given a stub for `vscode`: the production code under test is then byte-for-byte the code
 * that ships, which is the point of testing it at all.
 *
 * This has to run before `../monitor` is required, so the require is deliberately lazy.
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

const vscodeStub = { EventEmitter: StubEmitter };

interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as LoaderInternals;
const originalLoad = loader._load;
loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { SessionMonitor } = require('../monitor') as typeof import('../monitor');
const { JournalStore } = require('../journal') as typeof import('../journal');
/* eslint-enable @typescript-eslint/no-require-imports */

const messages: string[] = [];
const log = {
  info: (message: string) => messages.push(message),
  warn: (message: string) => messages.push(message),
} as never;

/** Enough of a terminal for identity comparison, which is all the monitor does with one. */
function fakeTerminal(): never {
  return { exitStatus: undefined } as never;
}

/**
 * A rollout whose events are `ageSeconds` old.
 *
 * The age matters: `poll` also gives up on turns that have gone quiet for too long, so a
 * fixture with a fixed past timestamp is demoted to `silent` the moment it is read and every
 * "is it working" assertion fails for a reason that has nothing to do with what is under test.
 */
function rollout(ageSeconds = 0): string {
  const at = Date.now() - ageSeconds * 1000;
  return [
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 't1', started_at: Math.floor(at / 1000) },
    }),
    JSON.stringify({
      timestamp: new Date(at).toISOString(),
      ordinal: 2,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: 'e', command: ['git', 'status'] },
      },
    }),
    // Trailing newline required: the tailer holds back a final unterminated line, because in
    // a live rollout that is a record still being written.
    '',
  ].join('\n');
}

async function withMonitor(
  body: (context: {
    monitor: InstanceType<typeof SessionMonitor>;
    store: InstanceType<typeof JournalStore>;
    directory: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-monitor-'));
  const store = new JournalStore(path.join(directory, 'journal'), 'window-under-test');
  const monitor = new SessionMonitor({
    store,
    windowId: 'window-under-test',
    codexHome: () => path.join(directory, 'codex'),
    log,
    stallSeconds: () => 45,
  });
  try {
    await body({ monitor, store, directory });
  } finally {
    monitor.dispose();
    // maxRetries: a journal write can still be settling when the directory goes away.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

test('launch keys are unique, because a reload matches terminals by them', async () => {
  await withMonitor(async ({ monitor }) => {
    const keys = new Set([
      monitor.nextLaunchKey(),
      monitor.nextLaunchKey(),
      monitor.nextLaunchKey(),
    ]);
    assert.equal(keys.size, 3);
  });
});

test('a restored session tails its rollout from the start without any scan', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    await writeFile(rolloutPath, rollout(), 'utf8');

    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture — Codex',
      mode: 'adopted',
      key: 'window-under-test-1',
      sessionId: 'session-abc',
      rolloutPath,
    });

    // The whole file is folded, not just what arrives next: a session rebound after a reload
    // is already mid-conversation, and reading only the tail would report it as idle.
    await (monitor as unknown as { poll(): Promise<void> }).poll();

    const [session] = monitor.live();
    assert.equal(session.sessionId, 'session-abc');
    assert.equal(session.activity.status, 'working');
    assert.equal(session.activity.lastItem?.subject, 'git status');
    assert.equal(monitor.workingCount(), 1);
  });
});

test('closing a terminal stops it counting as working', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    await writeFile(rolloutPath, rollout(), 'utf8');
    const terminal = fakeTerminal();
    monitor.track(terminal, {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'new',
      key: 'k',
      sessionId: 'session-abc',
      rolloutPath,
    });
    await (monitor as unknown as { poll(): Promise<void> }).poll();
    assert.equal(monitor.workingCount(), 1);

    monitor.close(terminal);
    assert.equal(monitor.workingCount(), 0);
    assert.deepEqual(monitor.live(), []);
  });
});

test('the shutdown stamp survives a journal write queued behind it', async () => {
  await withMonitor(async ({ monitor, store, directory }) => {
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    await writeFile(rolloutPath, rollout(), 'utf8');
    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'new',
      key: 'k',
      sessionId: 'session-abc',
      rolloutPath,
    });

    // A poll in flight is exactly the case that used to erase the stamp: `deactivate` runs,
    // writes synchronously, and the pending async write lands a moment later.
    const inFlight = (monitor as unknown as { poll(): Promise<void> }).poll();
    monitor.shutdown();
    await inFlight;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [journal] = await store.readAll();
    assert.ok(journal, 'the journal must exist after shutdown');
    assert.ok(journal.cleanShutdownAt, 'the clean-shutdown stamp must not be overwritten');
    assert.ok(
      journal.sessions.every((session) => session.closedAt !== undefined),
      'every session is closed by the stamp',
    );
  });
});

test('a session with no rollout to bind to is left alone rather than mislabelled', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'adopted',
      bindable: false,
    });
    await (monitor as unknown as { poll(): Promise<void> }).poll();

    const [session] = monitor.live();
    assert.equal(session.sessionId, undefined);
    assert.equal(session.activity.status, 'unknown');
    assert.equal(monitor.workingCount(), 0);
  });
});

test('a session whose rollout has gone quiet stops counting as working', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    // Started an hour ago and silent ever since: far past anything a real turn does, so the
    // monitor should stop asserting it is busy rather than spin forever.
    await writeFile(rolloutPath, rollout(3600), 'utf8');
    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'new',
      key: 'k',
      sessionId: 'session-abc',
      rolloutPath,
    });
    await (monitor as unknown as { poll(): Promise<void> }).poll();

    assert.equal(monitor.live()[0].activity.status, 'silent');
    assert.equal(monitor.workingCount(), 0);
    assert.ok(
      messages.some((message) => message.includes('no longer counting it as working')),
      'the demotion is logged, not silent',
    );
  });
});

test('an append reaches the session through the watcher, with no poll', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    await writeFile(rolloutPath, rollout(), 'utf8');
    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'new',
      key: 'k',
      sessionId: 'session-abc',
      rolloutPath,
    });

    let fired = 0;
    monitor.onDidChange(() => {
      fired += 1;
    });

    await appendFile(
      rolloutPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ordinal: 3,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'FileChange', changes: { '/repo/appended.ts': { type: 'add' } } },
        },
      })}\n`,
      'utf8',
    );

    // No `poll()` here on purpose: if this only worked because of the interval, the feature
    // would not exist. The wait is generous enough to absorb the debounce.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && monitor.live()[0].activity.lastItem?.kind !== 'fileChange') {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    assert.equal(monitor.live()[0].activity.lastItem?.kind, 'fileChange');
    assert.equal(monitor.live()[0].activity.lastItem?.subject, 'appended.ts');
    assert.ok(fired > 0, 'the view is told to redraw');
  });
});

test('a rollout that cannot be watched still binds and falls back to polling', async () => {
  await withMonitor(async ({ monitor, directory }) => {
    // A path that does not exist cannot be watched; the session must still tail once the
    // file appears rather than being dropped.
    const rolloutPath = path.join(directory, 'not-yet.jsonl');
    monitor.track(fakeTerminal(), {
      cwd: directory,
      project: 'fixture',
      label: 'fixture',
      mode: 'new',
      key: 'k',
      sessionId: 'session-abc',
      rolloutPath,
    });
    assert.ok(
      messages.some((message) => message.includes('polling this session instead')),
      'the fallback is logged rather than silently going blind',
    );

    await writeFile(rolloutPath, rollout(), 'utf8');
    await (monitor as unknown as { poll(): Promise<void> }).poll();
    assert.equal(monitor.live()[0].activity.status, 'working');
  });
});
