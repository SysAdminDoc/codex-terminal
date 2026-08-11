import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

import type {
  ClientNotification,
  ClientRequest,
  ClientInfo,
  InitializeParams,
  InitializeResponse,
  RequestId,
} from './generated/appServer';
import { APP_SERVER_CLI_VERSION } from './generated/appServer/metadata';
import { resolveHostNodeExecutable, type NodeProbe } from './notify';

/**
 * A client for `codex app-server`, Codex's own control plane.
 *
 * Everything this extension knows about a session today is reverse-engineered from rollout
 * files: which conversation a tab holds, whether a turn is running, how many tokens it has
 * spent. `app-server` reports all of that directly, as typed notifications. Adopting it would
 * replace three inferred modules with one supported integration — which is why it is worth
 * having, and why it is off by default until it has earned the trust.
 *
 * Two things about the wire format were established by probing the installed binary
 * (0.147.0, 2026-08-10) rather than assumed, and both would break a textbook client:
 *
 * 1. **Responses omit `jsonrpc`.** `initialize` answers with `{"id":1,"result":{…}}` — no
 *    version field. A client that validates `jsonrpc === "2.0"` on the way in rejects every
 *    message the server ever sends.
 * 2. **`initialize` advertises no capabilities.** The result carries `userAgent`, `codexHome`,
 *    `platformFamily` and `platformOs`, and nothing describing what the server supports. So a
 *    capability probe has to be "call it and see", not "read the handshake" — which is the
 *    honest reason experimental calls are attempted individually rather than declared safe up
 *    front.
 */

export type AppServerHandshake = InitializeResponse;

/** The request and notification unions are generated from the Codex app-server schema. */
export type AppServerRequest = ClientRequest;
export type AppServerNotification = ClientNotification;

export interface JsonRpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const VERSION_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

/** Extract the CLI version from the `initialize` user-agent when the server provides one. */
export function codexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  return userAgent?.match(VERSION_PATTERN)?.[0];
}

/**
 * Report a generated-type/runtime mismatch without making the optional app-server unusable.
 *
 * Codex does not promise that its protocol is stable yet, so a warning is more useful than
 * either silently trusting stale unions or refusing a connection whose basic handshake still
 * works. A missing/unrecognisable user-agent is left alone because it is not evidence of drift.
 */
export function warnIfAppServerVersionMismatch(
  userAgent: string | undefined,
  log: { warn(message: string): void },
): boolean {
  const runningVersion = codexVersionFromUserAgent(userAgent);
  if (!runningVersion || runningVersion === APP_SERVER_CLI_VERSION) {
    return false;
  }
  log.warn(
    `app-server protocol types were generated from Codex CLI ${APP_SERVER_CLI_VERSION}, ` +
      `but the running server reports ${runningVersion}; regenerate with ` +
      '`npm run app-server:generate`.',
  );
  return true;
}

/** One JSON object per line, which is the framing `app-server` uses in both directions. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a stream chunk into whole messages, returning the unfinished tail.
 *
 * Kept separate and pure because the failure it prevents is invisible: a partial line folded
 * as if it were complete produces a JSON error for a message that was never malformed.
 */
export function decodeMessages(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline === -1) {
      break;
    }
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as JsonRpcMessage;
      // Deliberately not checked against `jsonrpc: "2.0"`: the server does not send it.
      if (typeof parsed === 'object' && parsed !== null) {
        messages.push(parsed);
      }
    } catch {
      // A line that is not JSON is not a protocol message. Dropping it keeps one bad line
      // from taking down a connection that is otherwise healthy.
    }
  }
  return { messages, rest };
}

export interface AppServerOptions {
  /** Absolute path to the Codex executable, or to its JS entry point on Windows. */
  command: string;
  /**
   * Set when `command` is a `.js` file that has to run under this Node.
   *
   * Node refuses to spawn a `.cmd` without a shell (BatBadBut, CVE-2024-27980) and fails with
   * a bare `EINVAL`, and the npm-installed `codex` on Windows *is* a `.cmd` shim. Resolving
   * past it to the JS entry is the same trick `scripts/package.mjs` uses for `vsce`.
   */
  nodeExecutable?: string;
  log: { info(message: string): void; warn(message: string): void };
  onNotification?: (method: string, params: unknown) => void;
}

/** How long the handshake may take before the connection is judged unusable. */
export const HANDSHAKE_TIMEOUT_MS = 20_000;

export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly options: AppServerOptions) {}

  /**
   * Start the server and complete the handshake.
   *
   * Rejects rather than degrading quietly: the caller's whole reason to enable this is to use
   * it, and a client that silently never connects is worse than one that says so.
   */
  async start(clientVersion: string): Promise<AppServerHandshake> {
    const { command, nodeExecutable } = this.options;
    const executable = nodeExecutable ?? command;
    const args = nodeExecutable ? [command, 'app-server'] : ['app-server'];
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.options.log.warn(`app-server: ${text.slice(0, 500)}`);
      }
    });
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code) =>
      this.failAll(new Error(`codex app-server exited with code ${code ?? 'unknown'}`)),
    );

    const initialize: InitializeParams = {
      clientInfo: {
        name: 'codex-terminal',
        title: 'Codex Terminal',
        version: clientVersion,
      } satisfies ClientInfo,
      capabilities: null,
    };
    const handshake = (await this.request('initialize', initialize)) as AppServerHandshake;
    warnIfAppServerVersionMismatch(handshake.userAgent, this.options.log);
    // A notification, not a request: nothing answers it, so awaiting one would hang.
    this.notify('initialized');
    return handshake;
  }

  request(method: string, params: unknown, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(encodeMessage(message));
    });
  }

  notify(method: string, params?: unknown): void {
    const message =
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params };
    this.child?.stdin.write(encodeMessage(message));
  }

  private receive(chunk: Buffer): void {
    // `StringDecoder` rather than `toString`: a multi-byte character split across two chunks
    // would otherwise be corrupted, and the resulting line is unparseable JSON.
    this.buffer += this.decoder.write(chunk);
    const { messages, rest } = decodeMessages(this.buffer);
    this.buffer = rest;
    for (const message of messages) {
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!waiting) {
          continue;
        }
        if (message.error) {
          waiting.reject(new Error(message.error.message ?? 'app-server returned an error'));
        } else {
          waiting.resolve(message.result);
        }
      } else if (message.method) {
        this.options.onNotification?.(message.method, message.params);
      }
    }
  }

  private failAll(error: Error): void {
    for (const waiting of this.pending.values()) {
      waiting.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.failAll(new Error('codex app-server client disposed'));
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * A `codex app-server` this extension runs, listening on a local WebSocket.
 *
 * The transport is not a free choice. `app-server --listen` offers `stdio://`, `unix://` and
 * `ws://IP:PORT`, and `codex --remote` accepts `unix://` or `ws://` — but a TUI can only
 * attach to a server that is listening on a *socket*, which rules stdio out, and the unix
 * transport produced no listener at all on Windows (probed 0.147, 2026-08-10: the banner that
 * `ws://` prints immediately never appeared). `app-server proxy`, the other stdio route, takes
 * `--sock <SOCKET_PATH>` and is therefore unix-only too.
 *
 * So `ws://127.0.0.1:<port>` is the one transport that works on this project's primary
 * platform. Codex binds it to localhost only and says so in its own banner, and the port is
 * chosen per run rather than fixed, so two windows do not fight over one.
 */

/** Codex prints its banner on stderr and serves this once it is accepting connections. */
export const READY_PATH = '/readyz';
export const READY_TIMEOUT_MS = 20_000;

export function appServerListenArgs(port: number): string[] {
  return ['app-server', '--listen', `ws://127.0.0.1:${port}`];
}

/** What a launched TUI is given so it attaches to the server above instead of running alone. */
export function remoteArgs(port: number): string[] {
  return ['--remote', `ws://127.0.0.1:${port}`];
}

/** An ephemeral port the OS has just confirmed is free. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    // Port 0 asks the OS for any free port; reading it back before closing is the standard
    // way to reserve one without a fixed number two windows could collide on.
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function readyOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpGet(`http://127.0.0.1:${port}${READY_PATH}`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1_000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait until the server answers `/readyz`.
 *
 * Polled rather than parsed out of the banner: the banner goes to stderr and its wording is
 * not a contract, whereas the readiness endpoint is one. It answered within 250ms locally.
 */
export async function waitForReady(
  port: number,
  timeoutMs = READY_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await readyOnce(port)) {
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface HostedAppServerOptions {
  command: string;
  nodeExecutable?: string;
  log: { info(message: string): void; warn(message: string): void };
  /**
   * Called when the server exits on its own. Without it a dead server stays installed and
   * every later launch is handed `--remote` pointing at a port nobody is listening on.
   */
  onExit?: (detail: string) => void;
}

/** The server process plus the port a TUI should be pointed at. */
export class HostedAppServer {
  private child: ChildProcess | undefined;
  private disposed = false;

  private constructor(
    readonly port: number,
    child: ChildProcess,
    options: HostedAppServerOptions,
  ) {
    this.child = child;
    // A server that dies takes the port with it, and the extension has no other way to learn
    // that: `spawn` reports failure through events, and an unlistened `'exit'` is silent.
    child.once('exit', (code, signal) => {
      this.child = undefined;
      if (this.disposed) {
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      options.log.warn(`app-server on port ${this.port} stopped (${detail})`);
      options.onExit?.(detail);
    });
  }

  /** False once the process has gone, so a stale handle is never handed to a launch. */
  isAlive(): boolean {
    return this.child !== undefined;
  }

  static async start(options: HostedAppServerOptions): Promise<HostedAppServer> {
    const port = await findFreePort();
    const executable = options.nodeExecutable ?? options.command;
    const args = options.nodeExecutable
      ? [options.command, ...appServerListenArgs(port)]
      : appServerListenArgs(port);
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // `spawn` reports an `ENOENT`, `EACCES` or `EPERM` by emitting `'error'`, and an
    // unlistened `'error'` on an EventEmitter is thrown — out of a callback, past the `try`
    // around this call, and into the extension host as an unhandled exception. Listening is
    // what turns it back into a rejection the caller can report.
    const failure = new Promise<never>((_resolve, reject) => {
      child.once('error', (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
    // If readiness wins the race the rejection still has to go somewhere.
    failure.catch(() => undefined);

    // The banner lands on stderr, so this is the normal channel rather than a fault channel.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        options.log.info(`app-server: ${text.slice(0, 500)}`);
      }
    });

    const ready = await Promise.race([waitForReady(port), failure]);
    if (!ready) {
      child.kill();
      throw new Error(`codex app-server did not become ready on port ${port}`);
    }
    options.log.info(`app-server listening on ws://127.0.0.1:${port}`);
    return new HostedAppServer(port, child, options);
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * Whether this host can open a WebSocket at all.
 *
 * `WebSocket` became a Node global in 22, which is the runtime bundled by the declared 1.101
 * engine floor. Probing still beats assuming: downstream hosts can bypass a manifest floor, and
 * the experimental app-server setting should fall back cleanly on those editors.
 */
export function webSocketAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';
}

/**
 * The JS entry behind an npm `codex.cmd` shim, if that is what was resolved.
 *
 * Returns undefined for a real executable, which is the normal case everywhere but Windows.
 */
export function nodeEntryFor(resolved: string): string | undefined {
  if (!/\.cmd$/i.test(resolved)) {
    return undefined;
  }
  const entry = path.join(
    path.dirname(resolved),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  return existsSync(entry) ? entry : undefined;
}

/** Build one safe command shape for every app-server client and hosted-server caller. */
export function appServerCommandFor(
  resolved: string,
  probe?: NodeProbe,
): { command: string; nodeExecutable?: string } | undefined {
  const entry = nodeEntryFor(resolved);
  if (!entry) {
    return { command: resolved };
  }
  const nodeExecutable = resolveHostNodeExecutable(probe);
  return nodeExecutable ? { command: entry, nodeExecutable } : undefined;
}

/**
 * Tell Codex what a session is called.
 *
 * Codex accepts a session name wherever it accepts an id — `resume`, `archive`, `delete`,
 * `unarchive` all document "session id or session name" — but its CLI has no way to set one:
 * 0.147 has no rename subcommand and no flag. `thread/name/set` on the app-server is the only
 * writer, which is why naming a session used to stop at this extension's own store.
 *
 * The thread id is the session id. `thread/list` returns entries whose `id` and `sessionId`
 * are the same value (verified against 0.147, 2026-08-10), so no lookup is needed — and if
 * that ever stops being true the failure is self-explaining, because the server answers an
 * unknown id with "no rollout found for thread id …".
 *
 * Runs over stdio rather than the WebSocket transport: this is a client-only call with no TUI
 * to attach, so it needs neither a listening socket nor a `WebSocket` global, and therefore
 * works on every editor this extension supports rather than only the experimental path.
 */
export async function setThreadName(
  options: Omit<AppServerOptions, 'onNotification'>,
  clientVersion: string,
  sessionId: string,
  name: string,
): Promise<void> {
  const client = new AppServerClient(options);
  try {
    await client.start(clientVersion);
    await client.request('thread/name/set', { threadId: sessionId, name });
  } finally {
    client.dispose();
  }
}
