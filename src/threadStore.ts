import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

/** The current SQLite generations Codex writes. An unknown generation is never guessed at. */
export const STATE_DATABASE_NAME = 'state_5.sqlite';
export const HISTORY_DATABASE_NAME = 'thread_history_1.sqlite';
export const STATE_MIGRATION_VERSION = 46;
export const HISTORY_MIGRATION_VERSION = 4;

export interface ThreadTurnSummary {
  status: string;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  /** Human-readable reset time extracted only for a usage-limit failure. */
  usageResetText?: string;
}

/** Read-only fields from Codex's `threads` projection. */
export interface ThreadStoreRecord {
  id: string;
  rolloutPath: string;
  cwd: string;
  archived: boolean;
  name?: string;
  pinned: boolean;
  model?: string;
  reasoningEffort?: string;
  tokensUsed: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  preview?: string;
  lastTurn?: ThreadTurnSummary;
}

export interface ThreadStoreSnapshot {
  byId: ReadonlyMap<string, ThreadStoreRecord>;
  byRolloutPath: ReadonlyMap<string, ThreadStoreRecord>;
  /** One combined warning for the caller to log once, when the layer was not safe to use. */
  warning?: string;
}

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
}

interface ReadOnlyDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (filename: string, options: { readOnly: true }): ReadOnlyDatabase;
}

interface SqliteRow {
  [key: string]: unknown;
}

interface DatabaseLocation {
  filePath?: string;
  warning?: string;
}

const requireFromExtension = createRequire(__filename);
let databaseConstructor: DatabaseSyncConstructor | null | undefined;

function threadStoreHome(homeDirectory?: string): string {
  const explicit = homeDirectory?.trim();
  if (explicit) {
    return explicit;
  }
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

/** Feature-detects Node 22's built-in SQLite, keeping forced older hosts on rollout scanning. */
export function sqliteAvailable(): boolean {
  if (databaseConstructor !== undefined) {
    return databaseConstructor !== null;
  }
  try {
    const sqlite = requireFromExtension('node:sqlite') as {
      DatabaseSync?: DatabaseSyncConstructor;
    };
    databaseConstructor = sqlite.DatabaseSync ?? null;
  } catch {
    databaseConstructor = null;
  }
  return databaseConstructor !== null;
}

/**
 * Make a Codex database path comparable to a rollout path.
 *
 * Codex stores Windows paths with an extended-length `\\?\` prefix in SQLite while rollout
 * metadata and Node's filesystem APIs usually expose the ordinary path. Separator and case
 * differences are normalized too, so this remains useful when a database was copied between
 * platforms for inspection.
 */
export function normalizeThreadStorePath(value: string): string {
  return value
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function stringValue(row: SqliteRow, key: string): string | undefined {
  return typeof row[key] === 'string' ? row[key] : undefined;
}

function numberValue(row: SqliteRow, key: string): number | undefined {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function boolValue(row: SqliteRow, key: string): boolean {
  return row[key] === 1 || row[key] === true;
}

function epochSecondsToMs(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

function databaseCandidates(homeDirectory: string, prefix: string): string[] {
  try {
    return readdirSync(homeDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && new RegExp(`^${prefix}_\\d+\\.sqlite$`).test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function locateDatabase(
  homeDirectory: string,
  prefix: string,
  expectedName: string,
  label: string,
): DatabaseLocation {
  const expectedPath = path.join(homeDirectory, expectedName);
  if (existsSync(expectedPath)) {
    return { filePath: expectedPath };
  }
  const candidates = databaseCandidates(homeDirectory, prefix);
  if (candidates.length === 0) {
    return {};
  }
  return {
    warning:
      `Codex ${label} SQLite filename generation is unsupported (${candidates.join(', ')}; ` +
      `expected ${expectedName}); using rollout data instead.`,
  };
}

function supportedMigrations(
  database: ReadOnlyDatabase,
  expectedVersion: number,
): boolean {
  const rows = database.prepare('select version, success from _sqlx_migrations').all() as SqliteRow[];
  if (rows.length !== expectedVersion) {
    return false;
  }
  const versions = new Set<number>();
  for (const row of rows) {
    const version = numberValue(row, 'version');
    if (version === undefined || row.success !== 1 || versions.has(version)) {
      return false;
    }
    versions.add(version);
  }
  return Array.from({ length: expectedVersion }, (_, index) => index + 1).every((version) =>
    versions.has(version),
  );
}

function hasColumns(
  database: ReadOnlyDatabase,
  table: string,
  columns: readonly string[],
): boolean {
  const found = new Set(
    (database.prepare(`pragma table_info(${table})`).all() as SqliteRow[])
      .map((row) => stringValue(row, 'name'))
      .filter((name): name is string => name !== undefined),
  );
  return columns.every((column) => found.has(column));
}

function openValidatedDatabase(
  location: DatabaseLocation,
  label: string,
  expectedMigration: number,
  requiredTable: string,
  requiredColumns: readonly string[],
): { database?: ReadOnlyDatabase; warning?: string } {
  if (!location.filePath) {
    return { warning: location.warning };
  }
  if (!sqliteAvailable() || !databaseConstructor) {
    return {
      warning:
        `Codex ${label} SQLite index is present, but this editor's Node runtime has no ` +
        '`node:sqlite`; using rollout data instead.',
    };
  }

  let database: ReadOnlyDatabase | undefined;
  try {
    database = new databaseConstructor(location.filePath, { readOnly: true });
    if (!supportedMigrations(database, expectedMigration)) {
      database.close();
      return {
        warning:
          `Codex ${label} SQLite migration version is unsupported; expected ${expectedMigration} ` +
          'successful migrations, using rollout data instead.',
      };
    }
    if (!hasColumns(database, requiredTable, requiredColumns)) {
      database.close();
      return {
        warning:
          `Codex ${label} SQLite schema is missing expected columns; using rollout data instead.`,
      };
    }
    return { database };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The original error explains why the read failed; a close failure adds no information.
    }
    return {
      warning:
        `Codex ${label} SQLite index could not be read (${error instanceof Error ? error.message : String(error)}); ` +
        'using rollout data instead.',
    };
  }
}

function usageLimitResetText(errorJson: string | undefined): string | undefined {
  if (!errorJson) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorJson);
  } catch {
    return undefined;
  }

  let errorCode: string | undefined;
  let message: string | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'codexErrorInfo' && typeof child === 'string') {
        errorCode = child;
      } else if (key === 'message' && typeof child === 'string') {
        message = child;
      } else {
        visit(child);
      }
    }
  };
  visit(parsed);
  if (errorCode !== 'usageLimitExceeded' || !message) {
    return undefined;
  }
  const match = message.match(/\btry again at\s+(.+?)[.!?]?$/i);
  return match?.[1]?.trim();
}

function readStateRecords(database: ReadOnlyDatabase): ThreadStoreRecord[] {
  const rows = database
    .prepare(
      `select id, rollout_path, cwd, archived, name, is_pinned, model, reasoning_effort,
        tokens_used, created_at_ms, updated_at_ms, preview from threads`,
    )
    .all() as SqliteRow[];
  return rows.flatMap((row) => {
    const id = stringValue(row, 'id');
    const rolloutPath = stringValue(row, 'rollout_path');
    const cwd = stringValue(row, 'cwd');
    if (!id || !rolloutPath || !cwd) {
      return [];
    }
    return [
      {
        id,
        rolloutPath,
        cwd,
        archived: boolValue(row, 'archived'),
        ...(stringValue(row, 'name') ? { name: stringValue(row, 'name') } : {}),
        pinned: boolValue(row, 'is_pinned'),
        ...(stringValue(row, 'model') ? { model: stringValue(row, 'model') } : {}),
        ...(stringValue(row, 'reasoning_effort')
          ? { reasoningEffort: stringValue(row, 'reasoning_effort') }
          : {}),
        tokensUsed: numberValue(row, 'tokens_used') ?? 0,
        ...(numberValue(row, 'created_at_ms') !== undefined
          ? { createdAtMs: numberValue(row, 'created_at_ms') }
          : {}),
        ...(numberValue(row, 'updated_at_ms') !== undefined
          ? { updatedAtMs: numberValue(row, 'updated_at_ms') }
          : {}),
        ...(stringValue(row, 'preview') ? { preview: stringValue(row, 'preview') } : {}),
      },
    ];
  });
}

function readLastTurns(database: ReadOnlyDatabase): Map<string, ThreadTurnSummary> {
  const rows = database
    .prepare(
      `select thread_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms
       from thread_turns order by thread_id, rollout_ordinal`,
    )
    .all() as SqliteRow[];
  const turns = new Map<string, { ordinal: number; summary: ThreadTurnSummary }>();
  for (const row of rows) {
    const threadId = stringValue(row, 'thread_id');
    const status = stringValue(row, 'status');
    const ordinal = numberValue(row, 'rollout_ordinal');
    if (!threadId || !status || ordinal === undefined) {
      continue;
    }
    const previous = turns.get(threadId);
    if (previous && previous.ordinal > ordinal) {
      continue;
    }
    turns.set(threadId, {
      ordinal,
      summary: {
        status,
        ...(epochSecondsToMs(numberValue(row, 'started_at')) !== undefined
          ? { startedAtMs: epochSecondsToMs(numberValue(row, 'started_at')) }
          : {}),
        ...(epochSecondsToMs(numberValue(row, 'completed_at')) !== undefined
          ? { completedAtMs: epochSecondsToMs(numberValue(row, 'completed_at')) }
          : {}),
        ...(numberValue(row, 'duration_ms') !== undefined
          ? { durationMs: numberValue(row, 'duration_ms') }
          : {}),
        ...(usageLimitResetText(stringValue(row, 'error_json'))
          ? { usageResetText: usageLimitResetText(stringValue(row, 'error_json')) }
          : {}),
      },
    });
  }
  return new Map(Array.from(turns, ([threadId, value]) => [threadId, value.summary]));
}

function warningText(warnings: readonly (string | undefined)[]): string | undefined {
  const usable = warnings.filter((warning): warning is string => warning !== undefined);
  return usable.length > 0 ? usable.join(' ') : undefined;
}

/**
 * Read Codex's projections without taking ownership of session discovery.
 *
 * Both files are opened with `readOnly: true`. A missing database is normal on a fresh install;
 * a present database whose filename, migrations or columns are unfamiliar is not, so that case
 * returns no enrichment and one warning for the caller to log.
 */
export function readThreadStore(homeDirectory?: string): ThreadStoreSnapshot {
  const home = threadStoreHome(homeDirectory);
  const state = locateDatabase(home, 'state', STATE_DATABASE_NAME, 'thread');
  const history = locateDatabase(home, 'thread_history', HISTORY_DATABASE_NAME, 'thread history');

  if (!state.filePath && !history.filePath) {
    return {
      byId: new Map(),
      byRolloutPath: new Map(),
      warning: warningText([state.warning, history.warning]),
    };
  }
  if (!sqliteAvailable()) {
    return {
      byId: new Map(),
      byRolloutPath: new Map(),
      warning:
        'Codex SQLite thread indexes are present, but this editor\'s Node runtime has no `node:sqlite`; ' +
        'using rollout data instead.',
    };
  }

  const stateResult = openValidatedDatabase(
    state,
    'thread',
    STATE_MIGRATION_VERSION,
    'threads',
    ['id', 'rollout_path', 'cwd', 'archived', 'is_pinned', 'tokens_used'],
  );
  if (!stateResult.database) {
    return { byId: new Map(), byRolloutPath: new Map(), warning: warningText([state.warning, stateResult.warning]) };
  }

  let records: ThreadStoreRecord[];
  try {
    records = readStateRecords(stateResult.database);
  } catch (error) {
    return {
      byId: new Map(),
      byRolloutPath: new Map(),
      warning:
        warningText([state.warning, stateResult.warning]) ??
        `Codex thread SQLite projection could not be read (${error instanceof Error ? error.message : String(error)}); ` +
          'using rollout data instead.',
    };
  } finally {
    stateResult.database.close();
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  const byRolloutPath = new Map(
    records.map((record) => [normalizeThreadStorePath(record.rolloutPath), record]),
  );
  const warnings: (string | undefined)[] = [state.warning, stateResult.warning];

  const historyResult = openValidatedDatabase(
    history,
    'thread history',
    HISTORY_MIGRATION_VERSION,
    'thread_turns',
    ['thread_id', 'rollout_ordinal', 'status'],
  );
  if (historyResult.database) {
    try {
      for (const [threadId, lastTurn] of readLastTurns(historyResult.database)) {
        const record = byId.get(threadId);
        if (record) {
          record.lastTurn = lastTurn;
        }
      }
    } catch (error) {
      warnings.push(
        `Codex thread history SQLite projection could not be read (${error instanceof Error ? error.message : String(error)}); ` +
          'using rollout data for turn state instead.',
      );
    } finally {
      historyResult.database.close();
    }
  }
  warnings.push(history.warning, historyResult.warning);
  return { byId, byRolloutPath, warning: warningText(warnings) };
}

/** Match by the stable thread id first, then by the rollout path when a projection is mid-sync. */
export function threadForSession(
  snapshot: ThreadStoreSnapshot,
  sessionId: string,
  rolloutPath: string,
): ThreadStoreRecord | undefined {
  return snapshot.byId.get(sessionId) ?? snapshot.byRolloutPath.get(normalizeThreadStorePath(rolloutPath));
}
