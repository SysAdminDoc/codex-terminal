import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * The l10n path, end to end, in an editor actually running in Spanish.
 *
 * Everything else about localization is checkable on disk — key parity, placeholder parity —
 * and none of it proves the bundle is ever *loaded*. A misplaced file, a locale VS Code does
 * not resolve, or a bundle the packager excluded all leave `vscode.l10n.t` quietly returning
 * English, which is indistinguishable from a working extension in every unit test.
 */
suite('Spanish display language', () => {
  test('the editor is actually running in Spanish', () => {
    // If this fails, nothing below means anything: the assertions would pass on an English
    // host by comparing English to English.
    assert.equal(vscode.env.language, 'es');
  });

  test('extension-host strings come back translated', async () => {
    const extension = vscode.extensions.getExtension('sysadmindoc.codex-terminal');
    assert.ok(extension);
    await extension.activate();

    const bundle = JSON.parse(
      await readFile(path.join(extension.extensionPath, 'l10n', 'bundle.l10n.es.json'), 'utf8'),
    ) as Record<string, string>;

    // The Launch panel's own rows, which is what the operator sees first.
    assert.equal(vscode.l10n.t('New Session'), bundle['New Session']);
    assert.equal(vscode.l10n.t('Resume Last Session'), bundle['Resume Last Session']);
    assert.notEqual(vscode.l10n.t('New Session'), 'New Session');

    // A placeholder string, because losing an argument in translation is the failure that
    // still renders and still reads like prose.
    assert.equal(vscode.l10n.t('{0} sessions', 3), '3 sesiones');
  });

  test('what a screen reader hears is translated, not just what is drawn', async () => {
    const extension = vscode.extensions.getExtension('sysadmindoc.codex-terminal');
    assert.ok(extension);
    await extension.activate();

    // `announceActivity` builds the accessible name of a running-session row out of these,
    // and they were inline English literals until they were not — a Spanish editor drew
    // Spanish and spoke English, which no unit test and no screenshot would show.
    assert.equal(vscode.l10n.t('Working'), 'Trabajando');
    assert.equal(vscode.l10n.t('no recent output'), 'sin salida reciente');
    assert.equal(vscode.l10n.t('{0} turns completed', 3), '3 turnos completados');
    assert.equal(vscode.l10n.t('weekly limit'), 'límite semanal');
    assert.equal(vscode.l10n.t('resets in {0}', '3d 4h'), 'se reinicia en 3d 4h');
  });

  test('the manifest is translated too, not just the runtime strings', () => {
    const extension = vscode.extensions.getExtension('sysadmindoc.codex-terminal');
    assert.ok(extension);
    // A resolved `%placeholder%` is not a string: VS Code replaces it with
    // `{ value, original }`, keeping the English it came from. Asserting against a plain
    // string here fails whether the translation worked or not, which reads like a broken
    // language pack and is not one.
    const commands = (
      extension.packageJSON as {
        contributes?: { commands?: Array<{ command: string; title: string | { value: string; original: string } }> };
      }
    ).contributes?.commands;
    const title = commands?.find((entry) => entry.command === 'codexTerminal.new')?.title;
    assert.equal(typeof title, 'object', 'an untranslated title stays a plain string');
    assert.deepEqual(title, { value: 'Nueva sesión', original: 'New Session' });
  });
});
