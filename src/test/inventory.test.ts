import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REDACTED,
  describeMcpServer,
  describePlugin,
  parseMcpList,
  parsePluginList,
  redactSecrets,
} from '../inventory';

/** Verbatim shape from `codex mcp list --json` on 0.147, environment included. */
const MCP_LIST = JSON.stringify([
  {
    name: 'node_repl',
    enabled: true,
    disabled_reason: null,
    transport: 'stdio',
    command: 'node',
    args: ['repl.js'],
    env: { API_KEY: 'sk-live-0123456789abcdef', HOME: '/home/me' },
  },
  {
    name: 'offline',
    enabled: false,
    disabled_reason: 'command not found',
    transport: 'stdio',
  },
]);

test('an MCP list is parsed down to what is safe to show', () => {
  const parsed = parseMcpList(MCP_LIST);
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0].name, 'node_repl');
  assert.equal(parsed?.[0].enabled, true);
  assert.equal(parsed?.[1].disabledReason, 'command not found');
  // The environment carries API tokens and is deliberately not carried through.
  assert.ok(!JSON.stringify(parsed).includes('sk-live-0123456789abcdef'));
});

test('output that is not the expected shape is rejected rather than half-read', () => {
  assert.equal(parseMcpList('not json'), undefined);
  assert.equal(parseMcpList('{"servers":[]}'), undefined);
  assert.equal(parsePluginList('[]'), undefined);
  assert.equal(parsePluginList('nonsense'), undefined);
});

test('a plugin list is parsed, enabled state included', () => {
  const parsed = parsePluginList(
    JSON.stringify({
      installed: [
        { pluginId: 'documents@openai-primary-runtime', name: 'documents', enabled: true },
        { pluginId: 'off@vendor', name: 'off', enabled: false, disabled_reason: 'unsupported' },
      ],
    }),
  );
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0].id, 'documents@openai-primary-runtime');
  assert.ok(describePlugin(parsed![0]) !== undefined);
  assert.ok(describeMcpServer({ name: 'x', enabled: false }) !== undefined);
});

test('marketplace-only plugins are not presented as installed', () => {
  const parsed = parsePluginList(
    JSON.stringify({
      installed: [{ pluginId: 'installed@vendor', name: 'installed', enabled: true }],
      available: [{ pluginId: 'marketplace@vendor', name: 'marketplace', enabled: true }],
    }),
  );
  assert.deepEqual(parsed?.map((entry) => entry.id), ['installed@vendor']);
});

/**
 * The failure path used to write the CLI's raw output to the log file, and the usual reason
 * that path runs is that the CLI *succeeded* and printed a payload of an unexpected shape —
 * for `codex mcp list` that payload is every server's environment. The UI drops it on purpose;
 * the log wrote it out verbatim.
 */
test('an environment block never survives into a log line', () => {
  const safe = redactSecrets(MCP_LIST);
  assert.ok(!safe.includes('sk-live-0123456789abcdef'), safe);
  assert.ok(safe.includes(REDACTED));
  // The surrounding error stays legible; redaction is not truncation.
  assert.ok(safe.includes('node_repl'));
  assert.ok(safe.includes('command not found'));
});

test('secret-shaped values are redacted whatever the surrounding structure', () => {
  const cases: Array<[string, string]> = [
    ['{"api_token": "abcdefghijklmnop"}', 'abcdefghijklmnop'],
    ['{"Authorization": "Bearer abcdefghijklmnop"}', 'abcdefghijklmnop'],
    ['{"password":"hunter2hunter2"}', 'hunter2hunter2'],
    ['failed calling api with sk-proj-AAAABBBBCCCCDDDD', 'sk-proj-AAAABBBBCCCCDDDD'],
    ['ghp_ABCDEFGHIJKLMNOPQRST leaked', 'ghp_ABCDEFGHIJKLMNOPQRST'],
    ['header: Bearer eyJhbGciOiJIUzI1NiJ9.body', 'eyJhbGciOiJIUzI1NiJ9.body'],
  ];
  for (const [input, secret] of cases) {
    assert.ok(!redactSecrets(input).includes(secret), `${input} -> ${redactSecrets(input)}`);
  }
});

test('ordinary diagnostics are left alone, so the log still explains the failure', () => {
  const message = "Could not read the plugin list (node:internal/modules/cjs/loader:1520)\nError: Cannot find module 'plugin'";
  assert.equal(redactSecrets(message), message);
});
