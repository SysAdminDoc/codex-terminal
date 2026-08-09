import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateSettings, type MigrationTarget, type SettingInspection } from '../migrate';

function fakeState(initial: Record<string, boolean> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get<T>(key: string, defaultValue: T): T {
      return (values.get(key) ?? defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, Boolean(value));
    },
  };
}

test('settings migration preserves target, rewrites the key, and runs once', async () => {
  const state = fakeState();
  const settings: Record<string, SettingInspection> = {
    showStatusBarItem: { globalValue: false },
    showStatusBarButton: {},
  };
  const updates: Array<[string, unknown, MigrationTarget]> = [];
  const events = await migrateSettings('0.3.0', state, {
    inspect: (key) => settings[key],
    update: async (key, value, target) => {
      updates.push([key, value, target]);
      if (key === 'showStatusBarButton') {
        settings[key] = { globalValue: value };
      } else {
        settings[key] = {};
      }
    },
  });

  assert.deepEqual(events, [
    {
      from: 'showStatusBarItem',
      to: 'showStatusBarButton',
      target: 'global',
      result: 'migrated',
    },
  ]);
  assert.deepEqual(updates, [
    ['showStatusBarButton', false, 'global'],
    ['showStatusBarItem', undefined, 'global'],
  ]);
  assert.deepEqual(await migrateSettings('0.3.0', state, {
    inspect: (key) => settings[key],
    update: async () => undefined,
  }), []);
});

test('settings migration does not overwrite an explicitly configured new key', async () => {
  const state = fakeState();
  const events = await migrateSettings('0.3.0', state, {
    inspect: (key) =>
      key === 'showStatusBarItem'
        ? { workspaceValue: false }
        : { workspaceValue: true },
    update: async () => {
      throw new Error('should not update an explicit new value');
    },
  });
  assert.deepEqual(events, [
    {
      from: 'showStatusBarItem',
      to: 'showStatusBarButton',
      target: 'workspace',
      result: 'skipped',
    },
  ]);
});
