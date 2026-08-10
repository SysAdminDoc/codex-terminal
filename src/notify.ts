import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';

export interface NotifyEvent {
  workspace: string;
  timestamp: string;
  args: string[];
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
const event = {
  workspace,
  timestamp: new Date().toISOString(),
  args: process.argv.slice(2),
};
fs.writeFileSync(temporary, JSON.stringify(event), 'utf8');
fs.renameSync(temporary, target);
`;
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
    await writeFile(
      this.hookPath,
      buildNotifyHookScript(this.inboxDirectory, this.options.workspaceName),
      'utf8',
    );
    this.watcher = watch(this.inboxDirectory, (_eventType, filename) => {
      const name = filename?.toString();
      if (name?.endsWith('.json')) {
        void this.consume(name);
      }
    });
    this.watcher.on('error', () => {
      // The extension will recreate the bridge on the next launch if the watcher fails.
      this.dispose();
    });
  }

  launchArgs(): string[] {
    return ['-c', buildNotifyConfigValue(this.options.executable, this.hookPath)];
  }

  private async consume(filename: string): Promise<void> {
    const eventPath = path.join(this.inboxDirectory, filename);
    try {
      const event = JSON.parse(await readFile(eventPath, 'utf8')) as NotifyEvent;
      await unlink(eventPath);
      if (
        typeof event.workspace === 'string' &&
        typeof event.timestamp === 'string' &&
        Array.isArray(event.args)
      ) {
        this.options.onTurnEnded({
          workspace: event.workspace,
          timestamp: event.timestamp,
          args: event.args.map(String),
        });
      }
    } catch {
      // A rename can race the watcher callback; the next callback can consume it.
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}

export interface Disposable {
  dispose(): void;
}
