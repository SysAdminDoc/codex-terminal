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

function tomlLiteral(value: string): string {
  if (value.includes("'")) {
    throw new Error('Notify hook paths containing apostrophes are not supported.');
  }
  return `'${value}'`;
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
