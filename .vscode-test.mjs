import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const testUserData = path.join(root, '.vscode-test', 'hostile-user-data');
const testExtensions = path.join(root, '.vscode-test', 'hostile-extensions');

export default defineConfig({
  label: 'hostile',
  files: 'out/test/integration/**/*.test.js',
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
});
