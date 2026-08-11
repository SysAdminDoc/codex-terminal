import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toMcpServerSpecs } from '../mcp';
import type { CodexMcpServerDefinition } from '../inventory';

const definitions: CodexMcpServerDefinition[] = [
  {
    name: 'stdio',
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MODE: 'test' },
      envVars: ['MCP_TOKEN'],
      cwd: 'C:/workspace',
    },
  },
  {
    name: 'http',
    enabled: true,
    transport: {
      type: 'streamable_http',
      url: 'https://example.test/mcp',
      bearerTokenEnvVar: 'MCP_TOKEN',
      httpHeaders: { 'X-Client': 'codex' },
      envHttpHeaders: { 'X-From-Env': 'MCP_HEADER' },
    },
  },
  {
    name: 'off',
    enabled: false,
    transport: {
      type: 'stdio',
      command: 'off',
      args: [],
      env: {},
      envVars: [],
    },
  },
];

test('MCP specs omit disabled servers and resolve referenced environment values', () => {
  const specs = toMcpServerSpecs(definitions, {
    MCP_TOKEN: 'token-value',
    MCP_HEADER: 'header-value',
  });
  assert.deepEqual(specs, [
    {
      kind: 'stdio',
      label: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { MODE: 'test', MCP_TOKEN: 'token-value' },
      cwd: 'C:/workspace',
    },
    {
      kind: 'streamable_http',
      label: 'http',
      url: 'https://example.test/mcp',
      headers: {
        'X-Client': 'codex',
        'X-From-Env': 'header-value',
        Authorization: 'Bearer token-value',
      },
    },
  ]);
});

test('an explicit authorization header wins over a bearer-token environment reference', () => {
  const [spec] = toMcpServerSpecs(
    [
      {
        name: 'http',
        enabled: true,
        transport: {
          type: 'streamable_http',
          url: 'https://example.test/mcp',
          bearerTokenEnvVar: 'MCP_TOKEN',
          httpHeaders: { authorization: 'Basic configured' },
          envHttpHeaders: {},
        },
      },
    ],
    { MCP_TOKEN: 'ignored' },
  );
  assert.equal(spec.kind, 'streamable_http');
  assert.deepEqual(spec.headers, { authorization: 'Basic configured' });
});
