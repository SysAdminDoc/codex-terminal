import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync, rmSync, unlinkSync, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';

export interface NotifyEvent {
  workspace: string;
  timestamp: string;
  eventType: string;
}

export interface NotifyBridgeOptions {
  directory: string;
  executable: string;
  workspaceName: string;
  onTurnEnded: (event: NotifyEvent) => void;
}

/**
 * A TOML string that survives every shell this extension launches through.
 *
 * Literal (single-quoted) rather than basic, for the same reason `titleItems` is: cmd.exe has
 * no escape for `"` inside a quoted argument, so a double-quoted TOML string is unquotable
 * there. A literal string has no escapes at all, so a path containing an apostrophe needs the
 * multi-line form — `C:\Users\O'Brien\…` is an ordinary Windows home directory, and it used to
 * throw on every single launch with notifications on.
 */
function tomlLiteral(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (value.includes("'''") || value.startsWith("'") || value.endsWith("'")) {
    throw new Error(`Path cannot be represented as a TOML literal string: ${value}`);
  }
  return `'''${value}'''`;
}

export interface NodeProbe {
  execPath: string;
  /** `PATH`, unsplit. */
  pathValue: string | undefined;
  isWindows: boolean;
  exists: (candidate: string) => boolean;
}

/** Notification files are a hand-off queue, not a history. */
export const NOTIFY_EVENT_MAX_AGE_MS = 5 * 60 * 1000;

const NOTIFY_EVENT_TYPE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Extract only Codex's bounded event type; never carry the JSON payload into extension storage. */
export function notifyEventType(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first !== 'string') {
    return 'unknown';
  }
  try {
    const parsed: unknown = JSON.parse(first);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      typeof parsed.type === 'string' &&
      NOTIFY_EVENT_TYPE.test(parsed.type)
    ) {
      return parsed.type;
    }
  } catch {
    // Codex's payload is JSON; malformed or legacy arguments are deliberately discarded.
  }
  return 'unknown';
}

/**
 * Find a Node that will actually run the hook script.
 *
 * `process.execPath` is not it. In the extension host that is the editor's own Electron
 * binary, which behaves as Node only because the host sets `ELECTRON_RUN_AS_NODE=1` — and the
 * editor deletes that variable when it builds the environment a terminal runs in. Codex spawns
 * the notify program from the terminal's environment, so the hook was being handed to an
 * editor binary with a `.cjs` file as its argument: it opens a window, it does not write the
 * event, and nothing anywhere says so.
 *
 * Returns undefined rather than guessing when no Node can be found, so the bridge can decline
 * to register a hook that would misfire.
 */
export function resolveNodeExecutable(probe: NodeProbe): string | undefined {
  const executableName = probe.isWindows ? 'node.exe' : 'node';
  // The common case outside an editor — and the case the unit tests run in.
  if (path.basename(probe.execPath).toLowerCase() === executableName) {
    return probe.execPath;
  }
  const separator = probe.isWindows ? ';' : ':';
  // Only `.exe` on Windows, deliberately, even though `PATHEXT` would also offer `.cmd`.
  // Codex spawns the notify program directly, and `CreateProcess` cannot run a batch file
  // without a shell — a `node.cmd` shim would resolve here and then fail to launch there.
  const extensions = probe.isWindows ? ['.exe'] : [''];
  for (const directory of (probe.pathValue ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `node${extension}`);
      if (probe.exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Resolve the runtime available to every extension-host app-server call site. */
export function resolveHostNodeExecutable(probe: NodeProbe = {
  execPath: process.execPath,
  pathValue: process.env.PATH,
  isWindows: process.platform === 'win32',
  exists: existsSync,
}): string | undefined {
  return resolveNodeExecutable(probe);
}

/** Build the invocation-scoped Codex config override without touching config.toml. */
export function buildNotifyConfigValue(executable: string, hookPath: string): string {
  return `notify=[${tomlLiteral(executable)},${tomlLiteral(hookPath)}]`;
}

export function buildNotifyHookScript(inboxDirectory: string, workspaceName: string): string {
  const inbox = JSON.stringify(inboxDirectory);
  const workspace = JSON.stringify(workspaceName);
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inbox = ${inbox};
const workspace = ${workspace};
fs.mkdirSync(inbox, { recursive: true });
const token = String(Date.now()) + '-' + String(process.pid) + '-' + Math.random().toString(16).slice(2);
const temporary = path.join(inbox, '.' + token + '.tmp');
const target = path.join(inbox, token + '.json');
let eventType = 'unknown';
try {
  const payload = JSON.parse(process.argv[2] || '');
  if (
    payload &&
    typeof payload === 'object' &&
    typeof payload.type === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(payload.type)
  ) {
    eventType = payload.type;
  }
} catch {
  // The payload is intentionally never copied when it cannot be parsed safely.
}
const event = {
  workspace,
  timestamp: new Date().toISOString(),
  eventType,
};
fs.writeFileSync(temporary, JSON.stringify(event), 'utf8');
fs.renameSync(temporary, target);
`;
}

async function clearInbox(inboxDirectory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(inboxDirectory);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await unlink(path.join(inboxDirectory, entry));
      } catch {
        // A concurrent hook or an unexpected directory is harmless; the next sweep retries it.
      }
    }),
  );
}

/** Filesystem-only bridge used by the extension; it has no vscode or network dependency. */
export class NotifyBridge implements Disposable {
  private readonly inboxDirectory: string;
  private readonly hookPath: string;
  private watcher: FSWatcher | undefined;

  constructor(private readonly options: NotifyBridgeOptions) {
    this.inboxDirectory = path.join(options.directory, 'events');
    this.hookPath = path.join(options.directory, 'notify-hook.cjs');
  }

  async start(): Promise<void> {
    await mkdir(this.inboxDirectory, { recursive: true });
    await this.pruneInbox(Date.now());
    await writeFile(
      this.hookPath,
      buildNotifyHookScript(this.inboxDirectory, this.options.workspaceName),
      'utf8',
    );
    this.watcher = watch(this.inboxDirectory, { persistent: false }, (_eventType, filename) => {
      const name = filename?.toString();
      if (name && path.basename(name) === name && name.endsWith('.json')) {
        void this.consume(name);
      }
    });
    this.watcher.on('error', () => {
      // The extension will recreate the bridge on the next launch if the watcher fails.
      this.dispose();
    });
    // A terminal can finish while the window is closed. Consume recent hand-offs now so they
    // do not wait for another filesystem event; older ones were removed by pruneInbox above.
    await this.consumeExistingEvents();
  }

  launchArgs(): string[] {
    return ['-c', buildNotifyConfigValue(this.options.executable, this.hookPath)];
  }

  /** Remove pending notification hand-offs without disabling a live bridge. */
  async clearPendingEvents(): Promise<void> {
    await clearInbox(this.inboxDirectory);
  }

  private async pruneInbox(now: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.inboxDirectory);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json') || entry.endsWith('.tmp'))
        .map(async (entry) => {
          const target = path.join(this.inboxDirectory, entry);
          try {
            const details = await stat(target);
            if (details.isFile() && now - details.mtimeMs >= NOTIFY_EVENT_MAX_AGE_MS) {
              await unlink(target);
            }
          } catch {
            // Best effort housekeeping; consume or the next startup will try again.
          }
        }),
    );
  }

  private async consumeExistingEvents(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.inboxDirectory);
    } catch {
      return;
    }
    for (const entry of entries.filter((candidate) => candidate.endsWith('.json'))) {
      await this.consume(entry);
    }
  }

  private async consume(filename: string): Promise<void> {
    const eventPath = path.join(this.inboxDirectory, filename);
    let parsed: unknown;
    let contents: string;
    try {
      contents = await readFile(eventPath, 'utf8');
    } catch {
      // A rename can race the watcher callback; another callback can consume it.
      return;
    }
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      // Invalid JSON is not worth retaining. This also removes a malformed file that could
      // contain a payload from an interrupted legacy hook.
      await unlink(eventPath).catch(() => undefined);
      return;
    }
    try {
      await unlink(eventPath);
    } catch {
      // Do not deliver an event that remains on disk and could be delivered twice.
      return;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'workspace' in parsed &&
      typeof parsed.workspace === 'string' &&
      'timestamp' in parsed &&
      typeof parsed.timestamp === 'string' &&
      'eventType' in parsed &&
      typeof parsed.eventType === 'string'
    ) {
      this.options.onTurnEnded({
        workspace: parsed.workspace,
        timestamp: parsed.timestamp,
        eventType: parsed.eventType,
      });
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    // `deactivate` cannot await a promise, and terminals launched before the setting changed
    // may still call the hook. Remove both the queue and executable synchronously so neither
    // can retain or receive a later payload after notifications are disabled.
    try {
      rmSync(this.inboxDirectory, { recursive: true, force: true });
    } catch {
      // Best effort teardown; startup's sweep remains a second line of defence.
    }
    try {
      unlinkSync(this.hookPath);
    } catch {
      // The hook may never have been written, or another teardown already removed it.
    }
  }
}

/** Clear notification payload hand-offs when the journal's message-storage switch is off. */
export async function clearNotifyEvents(directory: string): Promise<void> {
  await clearInbox(path.join(directory, 'events'));
}

export interface Disposable {
  dispose(): void;
}
