import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Flat config, required from ESLint 9 onward. ESLint 8 reached end of life on 2024-10-05 and
 * 9 on 2026-08-06, so 10 is the only supported line.
 *
 * `no-console` matters more here than in most projects: an extension has no console a user
 * will ever read, and anything it wants to say has to reach the `Codex Terminal` log channel
 * instead.
 */
export default [
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '**/*.mjs', '.vscode-test/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
        __dirname: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // TypeScript already reports undefined identifiers, and the base rule cannot see
      // type-only names, so it produces false positives on a typed codebase.
      'no-undef': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      curly: 'error',
    },
  },
  {
    // The integration suite is a test harness, not extension code: it never ships (see
    // `.vscodeignore`) and stdout *is* its report channel. The measured activation cost is
    // only useful if it prints on a pass too, so a creeping number is visible before it
    // becomes a failure.
    files: ['src/test/integration/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
