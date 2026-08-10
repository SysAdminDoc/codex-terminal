import { open, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { parseRolloutFileName } from './binder';
import {
  isInjectedContext,
  parseSessionMeta,
  parseTranscriptLine,
  renderTranscriptEntry,
  renderTranscriptHeader,
  summarise,
  type TranscriptMeta,
  type TranscriptRenderOptions,
} from './transcript';

export interface SessionRecord {
  id: string;
  timestamp: string;
  cwd: string;
  filePath: string;
  /** First prompt the operator actually typed, once the injected scaffolding is skipped. */
  preview?: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface SessionDiscoveryOptions {
  homeDirectory?: string;
  maxResults?: number;
}

/**
 * How much of a rollout is read to build a list entry. A rollout averages ~11 MB here and
 * the first real prompt lands around 42 KB (line 7) — everything before it is the session
 * header, AGENTS.md replay and skill catalogue. 192 KB clears that with margin while
 * keeping a full refresh of ~80 sessions in the tens of megabytes rather than gigabytes.
 */
const HEAD_BYTES = 192 * 1024;
const READ_CONCURRENCY = 8;

/** Resolve Codex's state directory (`$CODEX_HOME` or the default `~/.codex`). */
export function codexHomeDirectory(
  homeDirectory?: string,
  environmentValue: string | undefined = process.env.CODEX_HOME,
): string {
  const explicit = homeDirectory?.trim();
  if (explicit) {
    return explicit;
  }
  const configured = environmentValue?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

export function codexSessionsDirectory(homeDirectory: string = codexHomeDirectory()): string {
  return path.join(homeDirectory, 'sessions');
}

/** Project label for a rollout: the working directory's leaf. */
export function sessionProject(session: Pick<SessionRecord, 'cwd'>): string {
  const cwd = session.cwd.replace(/[\\/]+$/, '');
  if (!cwd) {
    return '';
  }
  const leaf = cwd.split(/[\\/]/).pop() ?? '';
  return leaf || cwd;
}

async function readHead(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

interface RolloutFile {
  filePath: string;
  /** From the filename, so it costs no I/O. Undefined for an unrecognised name. */
  sessionId?: string;
  /** Epoch ms from the filename; 0 when it could not be parsed, sorting such files last. */
  startedAt: number;
}

async function sessionFiles(directory: string): Promise<RolloutFile[]> {
  const files: RolloutFile[] = [];
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
      const parsed = parseRolloutFileName(entry.name);
      files.push({
        filePath: entryPath,
        ...(parsed ? { sessionId: parsed.sessionId } : {}),
        startedAt: parsed?.startedAt ?? 0,
      });
    }
  }
  return files;
}

/**
 * Narrow to the newest `limit` rollouts using only their filenames.
 *
 * A rollout's name carries both its session id and its start time, so the newest N can be
 * chosen without opening anything. That matters: the store here reached 2.01 GB across 121
 * files in two days, and reading every head to then discard all but 200 made the cost of a
 * refresh grow with the store rather than with what is displayed.
 */
export function selectNewestRollouts(files: readonly RolloutFile[], limit: number): RolloutFile[] {
  const newestById = new Map<string, RolloutFile>();
  const unidentified: RolloutFile[] = [];
  for (const file of files) {
    if (!file.sessionId) {
      unidentified.push(file);
      continue;
    }
    const previous = newestById.get(file.sessionId);
    if (!previous || file.startedAt > previous.startedAt) {
      newestById.set(file.sessionId, file);
    }
  }
  return [...newestById.values(), ...unidentified]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, Math.max(0, limit));
}

interface CacheEntry {
  modifiedAt: number;
  sizeBytes: number;
  record: SessionRecord | null;
}

const headCache = new Map<string, CacheEntry>();

/** Drop cached previews, e.g. when the history view is refreshed by hand. */
export function clearSessionCache(): void {
  headCache.clear();
}

async function readSession(filePath: string): Promise<SessionRecord | undefined> {
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return undefined;
  }
  const cached = headCache.get(filePath);
  if (cached && cached.modifiedAt === stats.mtimeMs && cached.sizeBytes === stats.size) {
    return cached.record ?? undefined;
  }

  let record: SessionRecord | undefined;
  try {
    const head = await readHead(filePath);
    // A truncated final line is expected — the head stops mid-file — so it is skipped.
    const lines = head.split(/\r?\n/);
    const meta = parseSessionMeta(lines[0] ?? '');
    if (meta) {
      record = {
        id: meta.id,
        timestamp: meta.timestamp,
        cwd: meta.cwd,
        filePath,
        preview: firstPromptFromLines(lines.slice(1)),
        sizeBytes: stats.size,
        modifiedAt: stats.mtimeMs,
      };
    }
  } catch {
    record = undefined;
  }

  headCache.set(filePath, {
    modifiedAt: stats.mtimeMs,
    sizeBytes: stats.size,
    record: record ?? null,
  });
  return record;
}

function firstPromptFromLines(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const entry = parseTranscriptLine(line);
    if (entry?.role === 'user' && !isInjectedContext(entry.text)) {
      return summarise(entry.text);
    }
  }
  return undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Read only session metadata and the opening prompt, newest first, without loading
 * conversation bodies.
 */
export async function discoverSessions(
  options: SessionDiscoveryOptions = {},
): Promise<SessionRecord[]> {
  const directory = codexSessionsDirectory(options.homeDirectory);
  const limit = options.maxResults ?? 30;
  // Choose from filenames first; only the survivors are ever opened.
  const files = selectNewestRollouts(await sessionFiles(directory), limit);
  const sessions = (
    await mapWithConcurrency(files, READ_CONCURRENCY, (file) => readSession(file.filePath))
  ).filter((session): session is SessionRecord => session !== undefined);
  const unique = new Map<string, SessionRecord>();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    if (!previous || session.timestamp > previous.timestamp) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);
}

export interface StoreUsage {
  fileCount: number;
  totalBytes: number;
}

/**
 * Size of the rollout store.
 *
 * Worth surfacing because it grows without bound and nothing in the editor says so: this
 * machine reached 2.01 GB across 121 files in two days, and Codex's own doctor warns about
 * it. `stat` only — no file is opened.
 */
export async function measureStore(homeDirectory?: string): Promise<StoreUsage> {
  const files = await sessionFiles(codexSessionsDirectory(homeDirectory));
  const sizes = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
    try {
      return (await stat(file.filePath)).size;
    } catch {
      return 0;
    }
  });
  return {
    fileCount: files.length,
    totalBytes: sizes.reduce((total, size) => total + size, 0),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface SessionGroup {
  project: string;
  cwd: string;
  sessions: SessionRecord[];
}

/** Group by working directory, most recently used project first. */
export function groupSessionsByProject(sessions: readonly SessionRecord[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const key = session.cwd.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
    } else {
      groups.set(key, {
        project: sessionProject(session) || session.cwd,
        cwd: session.cwd,
        sessions: [session],
      });
    }
  }
  return [...groups.values()];
}

export interface TranscriptExportResult {
  markdown: string;
  entryCount: number;
  truncated: boolean;
}

/**
 * Stream a whole rollout into Markdown. Rollouts reach hundreds of megabytes, so the file
 * is read line by line and the output is capped rather than materialised twice.
 */
export async function exportTranscript(
  filePath: string,
  project: string,
  options: TranscriptRenderOptions & { maxBytes?: number } = {},
): Promise<TranscriptExportResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  const parts: string[] = [];
  let meta: TranscriptMeta | undefined;
  let bytes = 0;
  let entryCount = 0;
  let truncated = false;

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      if (!meta) {
        meta = parseSessionMeta(line);
        if (meta) {
          const header = renderTranscriptHeader(meta, project);
          parts.push(header);
          bytes += header.length;
          continue;
        }
      }
      const entry = parseTranscriptLine(line);
      if (!entry) {
        continue;
      }
      const rendered = renderTranscriptEntry(entry, options);
      if (!rendered) {
        continue;
      }
      if (bytes + rendered.length > maxBytes) {
        truncated = true;
        break;
      }
      parts.push(rendered);
      bytes += rendered.length;
      entryCount += 1;
    }
  } finally {
    reader.close();
    stream.close();
  }

  if (truncated) {
    parts.push('\n---\n\n> Transcript truncated. Open the rollout file for the remainder.\n');
  }
  return { markdown: parts.join('\n'), entryCount, truncated };
}
