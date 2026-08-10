import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appServerListenArgs,
  decodeMessages,
  encodeMessage,
  findFreePort,
  remoteArgs,
  waitForReady,
} from '../appServer';

test('a request is framed as one line of JSON', () => {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(encoded.endsWith('\n'));
  assert.equal(encoded.split('\n').filter(Boolean).length, 1);
});

test('a response without a jsonrpc field is still accepted', () => {
  // Probed against Codex 0.147: `initialize` answers `{"id":1,"result":{…}}` with no version
  // field at all. A client that validates `jsonrpc === "2.0"` on the way in would discard
  // every message the server ever sends, and present as a handshake that silently times out.
  const { messages } = decodeMessages('{"id":1,"result":{"codexHome":"C:/Users/me/.codex"}}\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.deepEqual(messages[0].result, { codexHome: 'C:/Users/me/.codex' });
});

test('a partial line is held back until the rest arrives', () => {
  const first = decodeMessages('{"id":1,"result":{"a":1}}\n{"method":"partial');
  assert.equal(first.messages.length, 1);
  assert.equal(first.rest, '{"method":"partial');

  const second = decodeMessages(`${first.rest}/notification","params":{}}\n`);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].method, 'partial/notification');
  assert.equal(second.rest, '');
});

test('several messages in one chunk are all decoded', () => {
  const { messages, rest } = decodeMessages(
    '{"id":1,"result":{}}\n{"method":"remoteControl/status/changed","params":{"status":"disabled"}}\n',
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[1].method, 'remoteControl/status/changed');
  assert.equal(rest, '');
});

test('a line that is not JSON is dropped without taking the connection with it', () => {
  const { messages } = decodeMessages('not json\n{"id":2,"result":{"ok":true}}\n\n');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 2);
});

test('the listen and remote endpoints agree on host and port', () => {
  // A mismatch here is invisible in every other test: the server binds, the TUI dials
  // somewhere else, and the only symptom is a session that never reports anything.
  const [, flag, listen] = appServerListenArgs(8412);
  const [remoteFlag, remote] = remoteArgs(8412);
  assert.equal(flag, '--listen');
  assert.equal(remoteFlag, '--remote');
  assert.equal(listen, remote);
  // Localhost only, and Codex says the same in its own banner.
  assert.equal(listen, 'ws://127.0.0.1:8412');
});

test('a free port is a real one the OS just handed back', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, `implausible port ${port}`);
  // Per run, not fixed: two windows hosting a server must not collide on one number.
  assert.notEqual(port, await findFreePort());
});

test('readiness gives up rather than waiting forever on a port nothing is serving', async () => {
  const port = await findFreePort();
  let clock = 0;
  const ready = await waitForReady(port, 500, () => (clock += 400));
  assert.equal(ready, false);
});
