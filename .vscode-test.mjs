import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const testUserData = path.join(root, '.vscode-test', 'hostile-user-data');
const testExtensions = path.join(root, '.vscode-test', 'hostile-extensions');



export default defineConfig([
  {
    label: 'hostile',
    files: 'out/test/integration/extension.test.js',
    version: 'stable',
    extensionDevelopmentPath: root,
    workspaceFolder: path.join(root, 'src', 'test', 'integration', 'fixture'),
    launchArgs: [
      '--disable-gpu',
      `--user-data-dir=${testUserData}`,
      `--extensions-dir=${testExtensions}`,
    ],
    mocha: {
      timeout: 20000,
    },
  },
  {
    // A separate editor, because the display language is resolved once at startup.
    label: 'spanish',
    files: 'out/test/integration/locale.test.js',
    version: 'stable',
    extensionDevelopmentPath: root,
    // `--locale=es` on its own is not enough: with no language pack installed the editor
    // resolves the display language back to English, `vscode.env.language` reports `en`, and
    // every assertion in the suite would compare English against English and pass.
    installExtensions: ['MS-CEINTL.vscode-language-pack-es'],
    workspaceFolder: path.join(root, 'src', 'test', 'integration', 'fixture'),
    // No --extensions-dir/--user-data-dir override here on purpose: the runner installs that
    // language pack into its own default pair, so overriding them hides the pack from the very
    // editor that has to load it, and the run silently falls back to English.
    launchArgs: ['--disable-gpu', '--locale=es'],
    mocha: {
      timeout: 20000,
    },
  },
]);
