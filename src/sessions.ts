import { open, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { parseRolloutFileName } from './binder';
import { findCheckout, type Checkout } from './worktree';
import {
  isInjectedContext,
  netFileChanges,
  parseFileChanges,
  parseSessionMeta,
  parseTranscriptLine,
  renderTranscriptEntry,
  renderTranscriptHeader,
  summarise,
  type FileChange,
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
  /** Told why a scan found nothing, so the caller can say something better than "none". */
  onScan?: (scan: StoreScan) => void;
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

/**
 * Why a scan of the session store came back with nothing.
 *
 * A missing store, an empty one and one the process may not read all produced an identical
 * empty list and an identical "No Codex sessions recorded yet" row, with nothing logged — so
 * the most common "it does nothing" report was undiagnosable from either the UI or the log.
 */
export type StoreProblem = 'missing' | 'unreadable';

export interface StoreScan {
  files: RolloutFile[];
  problem?: StoreProblem;
  /** The error the filesystem actually gave, for the log. */
  detail?: string;
}

async function sessionFiles(directory: string, scan: StoreScan): Promise<RolloutFile[]> {
  const files: RolloutFile[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only the root of the scan decides the verdict; a directory that vanished mid-walk is
    // ordinary and must not be reported as a store the operator cannot read.
    if (scan.problem === undefined) {
      scan.problem = code === 'ENOENT' ? 'missing' : 'unreadable';
      scan.detail = error instanceof Error ? error.message : String(error);
    }
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sessionFiles(entryPath, scan)));
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

/**
 * Bounded because it is never otherwise emptied: entries for files that dropped out of the
 * top-N long ago were kept, with their preview text, for the life of the extension host.
 * A generous multiple of the largest list anyone can ask for.
 */
const HEAD_CACHE_LIMIT = 2_000;

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

  // Insertion order is iteration order for a Map, so the oldest key is the first one.
  if (headCache.size >= HEAD_CACHE_LIMIT && !headCache.has(filePath)) {
    const oldest = headCache.keys().next();
    if (!oldest.done) {
      headCache.delete(oldest.value);
    }
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
  const scan: StoreScan = { files: [] };
  // Choose from filenames first; only the survivors are ever opened.
  const files = selectNewestRollouts(await sessionFiles(directory, scan), limit);
  options.onScan?.({ ...scan, files });
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
  const files = await sessionFiles(codexSessionsDirectory(homeDirectory), { files: [] });
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

/** One checkout of a repository: the main one, or a linked worktree. */
export interface SessionCheckout {
  /** Worktree name, or undefined for the main checkout. */
  worktree?: string;
  cwd: string;
  sessions: SessionRecord[];
}

export interface SessionGroup {
  project: string;
  cwd: string;
  sessions: SessionRecord[];
  /**
   * Present only when this repository has sessions in more than one checkout. A repository
   * used from a single directory gains nothing from an extra level, so it does not get one.
   */
  checkouts?: SessionCheckout[];
}

/** Resolved repository for a working directory, keyed lowercase. Filled by the caller. */
export type CheckoutIndex = Map<string, Checkout | undefined>;

/**
 * Resolve each distinct working directory to its checkout, once.
 *
 * Sessions repeat directories heavily — a project with forty sessions has one cwd — so the
 * walk up to `.git` runs per directory rather than per session.
 */
export async function indexCheckouts(
  sessions: readonly SessionRecord[],
  previous?: CheckoutIndex,
): Promise<CheckoutIndex> {
  const index: CheckoutIndex = new Map();
  for (const session of sessions) {
    const key = session.cwd.toLowerCase();
    if (!session.cwd || index.has(key)) {
      continue;
    }
    // Reuse what a previous scan already resolved. This is a `.git` walk up the tree per
    // directory, and it used to run again on every debounced refresh — which is to say
    // twice a second for the whole length of a Codex turn, for an answer that only changes
    // when a repository is created, moved or converted to a worktree. An explicit refresh
    // drops the index, which is what makes that case recoverable.
    const reused = previous?.get(key);
    index.set(key, reused !== undefined ? reused : await findCheckout(session.cwd));
  }
  return index;
}

/**
 * Group by repository, falling back to working directory outside a checkout.
 *
 * Worktrees are the reason this is not simply "group by cwd": running several agents against
 * one repository, one worktree each, is exactly the case where directory grouping scatters
 * what belongs together.
 */
export function groupSessionsByProject(
  sessions: readonly SessionRecord[],
  checkouts?: CheckoutIndex,
): SessionGroup[] {
  const groups = new Map<string, SessionGroup & { byCheckout: Map<string, SessionCheckout> }>();
  for (const session of sessions) {
    const checkout = checkouts?.get(session.cwd.toLowerCase());
    const groupKey = (checkout?.repositoryRoot ?? session.cwd).toLowerCase();
    const checkoutKey = (checkout?.root ?? session.cwd).toLowerCase();

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        project: checkout
          ? sessionProject({ cwd: checkout.repositoryRoot }) || checkout.repositoryRoot
          : sessionProject(session) || session.cwd,
        cwd: checkout?.repositoryRoot ?? session.cwd,
        sessions: [],
        byCheckout: new Map(),
      };
      groups.set(groupKey, group);
    }
    group.sessions.push(session);

    const existing = group.byCheckout.get(checkoutKey);
    if (existing) {
      existing.sessions.push(session);
    } else {
      group.byCheckout.set(checkoutKey, {
        ...(checkout?.worktree ? { worktree: checkout.worktree } : {}),
        cwd: checkout?.root ?? session.cwd,
        sessions: [session],
      });
    }
  }

  return [...groups.values()].map(({ byCheckout, ...group }) => {
    const checkoutList = [...byCheckout.values()];
    // Main checkout first, then worktrees by name, so the list does not reorder itself as
    // sessions come and go.
    checkoutList.sort((left, right) =>
      (left.worktree ?? '').localeCompare(right.worktree ?? ''),
    );
    return checkoutList.length > 1 ? { ...group, checkouts: checkoutList } : group;
  });
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

export interface ChangedFilesResult {
  files: FileChange[];
  /** True when the scan stopped early; the list is then a prefix, not the whole story. */
  truncated: boolean;
}

/**
 * Every file a session changed, read straight out of its rollout.
 *
 * Streamed line by line and pre-filtered by substring before any JSON parsing: a rollout
 * embeds the full contents of each file it writes, so they reach 128 MB here and a single
 * line can be megabytes. Only paths and change kinds are kept.
 *
 * The caps exist because this runs when a session row is expanded, and an operator expanding
 * a row expects a list, not a stall. When either cap is hit the result says so, so a
 * shortened list is never mistaken for a complete one.
 */
export async function collectChangedFiles(
  filePath: string,
  options: { maxFiles?: number; maxBytes?: number } = {},
): Promise<ChangedFilesResult> {
  const maxFiles = options.maxFiles ?? 500;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  const changes: FileChange[] = [];
  const distinct = new Set<string>();
  let bytes = 0;
  let truncated = false;

  try {
    for await (const line of reader) {
      bytes += line.length;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      const found = parseFileChanges(line);
      if (!found) {
        continue;
      }
      for (const change of found) {
        distinct.add(change.path);
        changes.push(change);
      }
      if (distinct.size > maxFiles) {
        truncated = true;
        break;
      }
    }
  } catch {
    // A rollout being written right now can end mid-line; report what was read.
    truncated = true;
  } finally {
    reader.close();
    stream.destroy();
  }

  const files = netFileChanges(changes).sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated };
}
