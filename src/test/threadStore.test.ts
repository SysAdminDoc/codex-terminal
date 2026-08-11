import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  HISTORY_MIGRATION_VERSION,
  STATE_MIGRATION_VERSION,
  normalizeThreadStorePath,
  readThreadStore,
  sqliteAvailable,
  threadForSession,
} from '../threadStore';

interface FixtureStatement {
  run(...parameters: unknown[]): void;
}

interface FixtureDatabase {
  exec(sql: string): void;
  prepare(sql: string): FixtureStatement;
  close(): void;
}

interface FixtureDatabaseConstructor {
  new (filename: string, options?: { readOnly?: boolean }): FixtureDatabase;
}

const requireFromTest = createRequire(__filename);
const DatabaseSync = (() => {
  try {
    return (
      requireFromTest('node:sqlite') as { DatabaseSync?: FixtureDatabaseConstructor }
    ).DatabaseSync;
  } catch {
    return undefined;
  }
})();

function migrations(count: number): string {
  return Array.from({ length: count }, (_, index) => `(${index + 1}, 1)`).join(',');
}

function createFixtureDatabase(
  filePath: string,
  schema: string,
  migrationCount: number,
): void {
  if (!DatabaseSync) {
    return;
  }
  const database = new DatabaseSync(filePath);
  database.exec(`
    create table _sqlx_migrations (version integer primary key, success integer not null);
    insert into _sqlx_migrations(version, success) values ${migrations(migrationCount)};
    ${schema}
  `);
  database.close();
}

const stateSchema = `
  create table threads (
    id text primary key,
    rollout_path text not null,
    cwd text not null,
    archived integer not null,
    is_pinned integer not null,
    tokens_used integer not null,
    name text,
    model text,
    reasoning_effort text,
    created_at_ms integer,
    updated_at_ms integer,
    preview text not null
  );
`;

const historySchema = `
  create table thread_turns (
    thread_id text not null,
    rollout_ordinal integer not null,
    status text not null,
    error_json text,
    started_at integer,
    completed_at integer,
    duration_ms integer
  );
`;

test('SQLite enrichment is read-only, joins the latest turn, and normalizes rollout paths', async (t) => {
  if (!sqliteAvailable() || !DatabaseSync) {
    t.skip('node:sqlite is not available on this Node runtime');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-thread-store-'));
  try {
    const statePath = path.join(directory, 'state_5.sqlite');
    const historyPath = path.join(directory, 'thread_history_1.sqlite');
    createFixtureDatabase(statePath, stateSchema, STATE_MIGRATION_VERSION);
    createFixtureDatabase(historyPath, historySchema, HISTORY_MIGRATION_VERSION);

    const state = new DatabaseSync(statePath);
    const rolloutPath = String.raw`\\?\C:\workspace\rollout.jsonl`;
    state
      .prepare(
        `insert into threads(
          id, rollout_path, cwd, archived, is_pinned, tokens_used, name, model,
          reasoning_effort, created_at_ms, updated_at_ms, preview
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-1',
        rolloutPath,
        String.raw`C:\workspace`,
        0,
        1,
        4200,
        'named',
        'gpt-test',
        'high',
        1000,
        2000,
        'preview',
      );
    state.close();

    const history = new DatabaseSync(historyPath);
    history
      .prepare(
        `insert into thread_turns(
          thread_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('thread-1', 1, 'completed', null, 100, 101, 1000);
    history
      .prepare(
        `insert into thread_turns(
          thread_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-1',
        2,
        'failed',
        JSON.stringify({
          codexErrorInfo: 'usageLimitExceeded',
          message: "You've hit your usage limit; try again at Aug 15th, 2026 4:29 PM.",
        }),
        200,
        null,
        null,
      );
    history.close();

    const snapshot = readThreadStore(directory);
    const record = threadForSession(snapshot, 'thread-1', String.raw`C:\workspace\rollout.jsonl`);
    assert.ok(record);
    assert.equal(record.name, 'named');
    assert.equal(record.pinned, true);
    assert.equal(record.lastTurn?.status, 'failed');
    assert.equal(record.lastTurn?.usageResetText, 'Aug 15th, 2026 4:29 PM');
    assert.equal(record.lastTurn?.startedAtMs, 200_000);
    assert.equal(snapshot.warning, undefined);
    assert.equal(normalizeThreadStorePath(rolloutPath), 'c:/workspace/rollout.jsonl');

    const readOnlyProbe = new DatabaseSync(statePath, { readOnly: true });
    assert.throws(() => readOnlyProbe.exec('create table should_not_exist(value text)'));
    readOnlyProbe.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unknown SQLite filename generation is rejected with a fallback warning', async (t) => {
  if (!sqliteAvailable()) {
    t.skip('node:sqlite is not available on this Node runtime');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-thread-store-generation-'));
  try {
    await writeFile(path.join(directory, 'state_6.sqlite'), 'not a database', 'utf8');
    const snapshot = readThreadStore(directory);
    assert.equal(snapshot.byId.size, 0);
    assert.match(snapshot.warning ?? '', /filename generation is unsupported/);
    assert.match(snapshot.warning ?? '', /state_6\.sqlite/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unknown migration set is rejected before any projection query', async (t) => {
  if (!sqliteAvailable() || !DatabaseSync) {
    t.skip('node:sqlite is not available on this Node runtime');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-thread-store-migration-'));
  try {
    createFixtureDatabase(path.join(directory, 'state_5.sqlite'), stateSchema, 1);
    const snapshot = readThreadStore(directory);
    assert.equal(snapshot.byId.size, 0);
    assert.match(snapshot.warning ?? '', /migration version is unsupported/);
    assert.match(snapshot.warning ?? '', /46 successful migrations/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
