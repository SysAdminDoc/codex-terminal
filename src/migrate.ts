export type MigrationTarget = 'global' | 'workspace' | 'workspaceFolder';

export interface SettingInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface MigrationConfiguration {
  inspect: (key: string) => SettingInspection | undefined;
  update: (key: string, value: unknown, target: MigrationTarget) => PromiseLike<void> | void;
}

export interface MigrationState {
  get: <T>(key: string, defaultValue: T) => T;
  update: (key: string, value: unknown) => PromiseLike<void> | void;
}

export interface MigrationEvent {
  from: string;
  to: string;
  target: MigrationTarget;
  result: 'migrated' | 'skipped';
}

export const SETTING_MIGRATIONS = [
  { from: 'showStatusBarItem', to: 'showStatusBarButton' },
] as const;

const TARGET_FIELDS: Array<[MigrationTarget, keyof SettingInspection]> = [
  ['global', 'globalValue'],
  ['workspace', 'workspaceValue'],
  ['workspaceFolder', 'workspaceFolderValue'],
];

/** Run settings migrations once for the installed extension version. */
export async function migrateSettings(
  version: string,
  state: MigrationState,
  configuration: MigrationConfiguration,
): Promise<MigrationEvent[]> {
  const stateKey = `codexTerminal.settingsMigration.${version}`;
  if (state.get<boolean>(stateKey, false)) {
    return [];
  }

  const events: MigrationEvent[] = [];
  for (const migration of SETTING_MIGRATIONS) {
    const oldInspection = configuration.inspect(migration.from);
    const newInspection = configuration.inspect(migration.to);
    for (const [target, field] of TARGET_FIELDS) {
      const oldValue = oldInspection?.[field];
      if (oldValue === undefined) {
        continue;
      }
      if (newInspection?.[field] !== undefined) {
        events.push({ ...migration, target, result: 'skipped' });
        continue;
      }
      await configuration.update(migration.to, oldValue, target);
      await configuration.update(migration.from, undefined, target);
      events.push({ ...migration, target, result: 'migrated' });
    }
  }
  await state.update(stateKey, true);
  return events;
}
