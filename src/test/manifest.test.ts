import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

interface Manifest {
  contributes?: {
    configuration?: {
      properties?: Record<string, { scope?: string }>;
    };
  };
}

test('command-bearing settings stay machine-overridable', () => {
  const manifestPath = path.resolve(__dirname, '../../package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const properties = manifest.contributes?.configuration?.properties ?? {};

  for (const key of [
    'codexTerminal.command',
    'codexTerminal.customShellPath',
    'codexTerminal.args',
    'codexTerminal.env',
  ]) {
    assert.equal(
      properties[key]?.scope,
      'machine-overridable',
      `${key} must remain machine-overridable so workspace settings cannot inject commands`,
    );
  }
});
