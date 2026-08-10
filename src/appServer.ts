import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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

export interface AppServerHandshake {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
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

    const handshake = (await this.request('initialize', {
      clientInfo: { name: 'codex-terminal', title: 'Codex Terminal', version: clientVersion },
    })) as AppServerHandshake;
    // A notification, not a request: nothing answers it, so awaiting one would hang.
    this.notify('initialized', {});
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

  notify(method: string, params: unknown): void {
    this.child?.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }));
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
