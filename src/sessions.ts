import { open, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionRecord {
  id: string;
  timestamp: string;
  cwd: string;
  filePath: string;
}

export interface SessionDiscoveryOptions {
  homeDirectory?: string;
  maxResults?: number;
}

export function codexSessionsDirectory(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, '.codex', 'sessions');
}

async function jsonlHeader(filePath: string): Promise<unknown> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    return JSON.parse(firstLine);
  } finally {
    await handle.close();
  }
}

async function sessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sessionFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readSession(filePath: string): Promise<SessionRecord | undefined> {
  try {
    const header = (await jsonlHeader(filePath)) as {
      type?: unknown;
      payload?: { id?: unknown; session_id?: unknown; timestamp?: unknown; cwd?: unknown };
    };
    if (header.type !== 'session_meta' || !header.payload) {
      return undefined;
    }
    const id = header.payload.id ?? header.payload.session_id;
    const { timestamp, cwd } = header.payload;
    if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof cwd !== 'string') {
      return undefined;
    }
    return { id, timestamp, cwd, filePath };
  } catch {
    return undefined;
  }
}

/** Read only session metadata, newest first, without loading conversation bodies. */
export async function discoverSessions(
  options: SessionDiscoveryOptions = {},
): Promise<SessionRecord[]> {
  const directory = codexSessionsDirectory(options.homeDirectory);
  const files = await sessionFiles(directory);
  const sessions = (await Promise.all(files.map((filePath) => readSession(filePath)))).filter(
    (session): session is SessionRecord => session !== undefined,
  );
  const unique = new Map<string, SessionRecord>();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    if (!previous || session.timestamp > previous.timestamp) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, options.maxResults ?? 30);
}
