import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  HostedAppServer,
  appServerListenArgs,
  decodeMessages,
  encodeMessage,
  findFreePort,
  remoteArgs,
  waitForReady,
} from '../appServer';

interface Recorder {
  warn: string[];
  log: { info(message: string): void; warn(message: string): void };
}

function recorder(): Recorder {
  const warn: string[] = [];
  return { warn, log: { info: () => undefined, warn: (message) => warn.push(message) } };
}

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


/**
 * The regression: `spawn` reports `ENOENT`, `EACCES` and `EPERM` by emitting `'error'`, and an
 * unlistened `'error'` on an EventEmitter is *thrown* — out of a callback, past the `try`
 * around this call, and into the extension host as an unhandled exception. This asserts it
 * comes back as a rejection, which is the only form the caller can turn into a log line.
 */
test('a server that cannot be spawned rejects instead of throwing at the host', async () => {
  const { log } = recorder();
  await assert.rejects(
    HostedAppServer.start({ command: 'codex-terminal-no-such-executable', log }),
    (error: unknown) => error instanceof Error,
  );
});

/**
 * A server that dies used to leave its handle installed, so every later launch was handed
 * `--remote` pointing at a port nobody was listening on, with nothing anywhere to say so.
 */
test('a server that exits says so, stops being alive, and tells its owner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-appserver-'));
  try {
    // Stands in for `codex app-server`: it is handed the real `--listen ws://127.0.0.1:<port>`
    // argument, answers `/readyz` until it is found ready, then exits on its own.
    const script = path.join(directory, 'fake-app-server.js');
    await writeFile(
      script,
      [
        'const http = require("node:http");',
        'const listen = process.argv.find((a) => a.startsWith("ws://"));',
        'const port = Number(new URL(listen.replace("ws://", "http://")).port);',
        'const server = http.createServer((_req, res) => { res.statusCode = 200; res.end("ok"); });',
        'server.listen(port, "127.0.0.1");',
        'setTimeout(() => { server.close(); process.exit(3); }, 400);',
      ].join('\n'),
      'utf8',
    );

    const { log, warn } = recorder();
    const exits: string[] = [];
    const hosted = await HostedAppServer.start({
      command: script,
      nodeExecutable: process.execPath,
      log,
      onExit: (detail) => exits.push(detail),
    });
    assert.ok(hosted.isAlive());

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    assert.equal(hosted.isAlive(), false);
    assert.equal(exits.length, 1, `expected one exit callback, got ${exits.length}`);
    assert.match(exits[0], /exit code 3/);
    assert.ok(
      warn.some((line) => line.includes(String(hosted.port)) && line.includes('stopped')),
      warn.join(' | '),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('disposing a server on purpose is not reported as an unexpected exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-appserver-'));
  try {
    const script = path.join(directory, 'fake-app-server.js');
    await writeFile(
      script,
      [
        'const http = require("node:http");',
        'const listen = process.argv.find((a) => a.startsWith("ws://"));',
        'const port = Number(new URL(listen.replace("ws://", "http://")).port);',
        'http.createServer((_req, res) => { res.statusCode = 200; res.end("ok"); })',
        '  .listen(port, "127.0.0.1");',
        'setInterval(() => undefined, 1000);',
      ].join('\n'),
      'utf8',
    );

    const { log, warn } = recorder();
    const exits: string[] = [];
    const hosted = await HostedAppServer.start({
      command: script,
      nodeExecutable: process.execPath,
      log,
      onExit: (detail) => exits.push(detail),
    });
    hosted.dispose();
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(hosted.isAlive(), false);
    assert.deepEqual(exits, []);
    assert.deepEqual(warn, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
