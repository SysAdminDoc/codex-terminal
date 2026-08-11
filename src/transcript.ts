/**
 * Rollout (`~/.codex/sessions/**\/*.jsonl`) → readable transcript.
 *
 * Pure line-at-a-time functions with no `vscode` and no filesystem, so the whole format
 * can be exercised by `node --test` and so a caller can stream a 100 MB rollout without
 * ever holding it in memory.
 */

export type TranscriptRole =
  | 'user'
  | 'assistant'
  | 'developer'
  | 'reasoning'
  | 'tool'
  | 'output'
  | 'compaction';

/**
 * Rollout record types Codex 0.147 writes that carry no transcript content.
 *
 * Naming them is deliberate. An unrecognised type is indistinguishable from a type we chose
 * to skip, so a future format addition would be silently dropped exactly like these are.
 * `inter_agent_communication*` is subagent traffic; its payload shape is not documented and
 * was not present in any sampled rollout, so it is skipped rather than guessed at.
 */
export const SKIPPED_RECORD_TYPES = [
  'turn_context',
  'world_state',
  // Thread settings affect Codex configuration, not conversation content or live activity;
  // the state database and the next event carry the values that matter to this extension.
  'thread_settings_applied',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
] as const;

/** Top-level rollout records known to the supported legacy and modern schemas. */
export const KNOWN_ROLLOUT_RECORD_TYPES = [
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'world_state',
  'compacted',
  'thread_settings_applied',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
] as const;

export type RolloutSchemaGeneration = 'legacy' | 'modern' | 'unknown';

/**
 * The rollout trace has two formats worth supporting: the pre-0.44 Aug-2025 format and the
 * ordinal-bearing format introduced at 0.44. A missing or future version is not guessed at.
 * Callers can still render records they recognise, but they have a truthful compatibility signal
 * for diagnostics and fixtures instead of silently treating a new format as the current one.
 */
export function rolloutSchemaGeneration(
  meta: Pick<TranscriptMeta, 'cliVersion' | 'historyMode'>,
): RolloutSchemaGeneration {
  if (meta.historyMode?.toLowerCase().includes('legacy')) {
    return 'legacy';
  }
  const version = meta.cliVersion?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!version) {
    return 'unknown';
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  if (major === 0 && minor < 44) {
    return 'legacy';
  }
  return major === 0 ? 'modern' : 'unknown';
}

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for `tool`/`output` entries. */
  name?: string;
  timestamp?: string;
}

export interface SecretRedactionResult {
  text: string;
  /** Number of secret-shaped values replaced, including repeated occurrences. */
  count: number;
}

/** Token forms that Codex and the services it commonly calls expose in raw rollouts. */
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}(?=$|[^A-Za-z0-9._~+/=-])/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}(?=$|[^A-Za-z0-9_])/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}(?=$|[^A-Za-z0-9])/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}(?=$|[^A-Za-z0-9-])/g,
  /\b(?:sk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{7,}(?=$|[^A-Za-z0-9_-])/g,
  /\bAIza[0-9A-Za-z_-]{30,}(?=$|[^0-9A-Za-z_-])/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
] as const;

/** Replace recognised credential shapes before rollout text leaves the extension. */
export function redactSecrets(text: string): SecretRedactionResult {
  let count = 0;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      count += 1;
      if (/^Bearer\s/i.test(match)) {
        return `${match.slice(0, match.search(/\s/))} [REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return { text: redacted, count };
}

export interface TranscriptMeta {
  id: string;
  timestamp: string;
  cwd: string;
  cliVersion?: string;
  historyMode?: string;
  schemaGeneration: RolloutSchemaGeneration;
  originator?: string;
}

interface ContentPart {
  type?: unknown;
  text?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return (content as ContentPart[])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export type FileChangeKind = 'add' | 'update' | 'delete';

export interface FileChange {
  path: string;
  kind: FileChangeKind;
}

/**
 * Cheap pre-filter for the file-change scan.
 *
 * A `FileChange` record embeds the *entire new contents* of every file it touches, so
 * rollouts reach 128 MB here and a single line can be megabytes. Parsing every line to find
 * the few that matter costs far more than a substring test that rejects almost all of them,
 * and the test is safe: the marker is the record's own discriminator, so a line without it
 * cannot be a file change.
 */
export function mayContainFileChange(line: string): boolean {
  return line.includes('"FileChange"');
}

/**
 * Paths a single rollout line reports as changed, with the content thrown away.
 *
 * Only the keys and each entry's `type` are kept. Holding the contents would defeat the
 * point of streaming the file.
 */
export function parseFileChanges(line: string): FileChange[] | undefined {
  if (!mayContainFileChange(line)) {
    return undefined;
  }
  let record: { type?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  const payload = record.payload;
  if (record.type !== 'event_msg' || !payload || payload.type !== 'item_completed') {
    return undefined;
  }
  const item = payload.item;
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const changes = (item as Record<string, unknown>).type === 'FileChange'
    ? (item as Record<string, unknown>).changes
    : undefined;
  if (typeof changes !== 'object' || changes === null) {
    return undefined;
  }

  const found: FileChange[] = [];
  for (const [filePath, detail] of Object.entries(changes as Record<string, unknown>)) {
    if (!filePath) {
      continue;
    }
    const kind =
      typeof detail === 'object' && detail !== null
        ? (detail as Record<string, unknown>).type
        : undefined;
    found.push({
      path: filePath,
      kind: kind === 'add' || kind === 'delete' ? kind : 'update',
    });
  }
  return found.length > 0 ? found : undefined;
}

/**
 * Collapse repeated changes to one verdict per file.
 *
 * A session typically creates a file and then edits it several times. Listing that three
 * times says nothing; what the operator wants is the net effect, so a file this session
 * created reads as added however many times it was subsequently touched, and one it removed
 * reads as deleted whatever came before.
 */
export function netFileChanges(changes: Iterable<FileChange>): FileChange[] {
  const seen = new Map<string, { first: FileChangeKind; last: FileChangeKind }>();
  for (const change of changes) {
    const previous = seen.get(change.path);
    if (previous) {
      previous.last = change.kind;
    } else {
      seen.set(change.path, { first: change.kind, last: change.kind });
    }
  }
  return [...seen.entries()].map(([path, { first, last }]) => ({
    path,
    kind: last === 'delete' ? 'delete' : first === 'add' ? 'add' : 'update',
  }));
}

export function parseSessionMeta(line: string): TranscriptMeta | undefined {
  let record: { type?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (record.type !== 'session_meta' || !record.payload) {
    return undefined;
  }
  const payload = record.payload;
  const id = payload.id ?? payload.session_id;
  if (typeof id !== 'string' || typeof payload.timestamp !== 'string') {
    return undefined;
  }
  const meta: Omit<TranscriptMeta, 'schemaGeneration'> = {
    id,
    timestamp: payload.timestamp,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    ...(typeof payload.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
    ...(typeof payload.history_mode === 'string' ? { historyMode: payload.history_mode } : {}),
    ...(typeof payload.originator === 'string' ? { originator: payload.originator } : {}),
  };
  return { ...meta, schemaGeneration: rolloutSchemaGeneration(meta) };
}

/**
 * Codex replays the whole prompt scaffolding as `user` messages: AGENTS.md files, the
 * environment context, skill catalogues. They are indistinguishable from a real prompt by
 * role alone, so they are recognised by shape — a leading XML-ish tag or an instructions
 * heading — and dropped from previews and from the transcript's conversation view.
 */
export function isInjectedContext(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith('<') ||
    /^#+\s*AGENTS\.md instructions/i.test(head) ||
    /^#+\s*(Global )?Codex Agent Instructions/i.test(head)
  );
}

export function parseTranscriptLine(line: string): TranscriptEntry | undefined {
  let record: { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  const payload = record.payload;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;

  /**
   * Compaction replaces the conversation history with a summary. Dropping the record leaves
   * a transcript that jumps between unrelated turns with nothing to explain the gap, which
   * reads as lost content rather than as compaction.
   */
  if (record.type === 'compacted') {
    const message =
      payload && typeof payload.message === 'string' ? payload.message.trim() : '';
    const replaced = Array.isArray(payload?.replacement_history)
      ? (payload.replacement_history as unknown[]).length
      : 0;
    const entry: TranscriptEntry = {
      role: 'compaction',
      text:
        message ||
        (replaced > 0
          ? `Earlier history was replaced with ${replaced} summarised item(s).`
          : 'Earlier history was compacted.'),
    };
    return timestamp ? { ...entry, timestamp } : entry;
  }

  if (record.type !== 'response_item' || !payload) {
    return undefined;
  }
  const withTimestamp = <T extends Omit<TranscriptEntry, 'timestamp'>>(
    entry: T,
  ): TranscriptEntry => (timestamp ? { ...entry, timestamp } : entry);

  switch (payload.type) {
    case 'message': {
      const role = payload.role;
      const text = textOf(payload.content);
      if (!text.trim()) {
        return undefined;
      }
      if (role === 'assistant') {
        return withTimestamp({ role: 'assistant', text });
      }
      if (role === 'developer') {
        return withTimestamp({ role: 'developer', text });
      }
      return withTimestamp({ role: 'user', text });
    }
    case 'reasoning': {
      const summary = textOf(payload.summary);
      return summary.trim() ? withTimestamp({ role: 'reasoning', text: summary }) : undefined;
    }
    case 'custom_tool_call':
      return withTimestamp({
        role: 'tool',
        name: typeof payload.name === 'string' ? payload.name : 'tool',
        text: typeof payload.input === 'string' ? payload.input : '',
      });
    case 'function_call':
      return withTimestamp({
        role: 'tool',
        name: typeof payload.name === 'string' ? payload.name : 'function',
        text: typeof payload.arguments === 'string' ? payload.arguments : '',
      });
    case 'custom_tool_call_output':
    case 'function_call_output':
      return withTimestamp({
        role: 'output',
        name: typeof payload.name === 'string' ? payload.name : undefined,
        text: typeof payload.output === 'string' ? payload.output : textOf(payload.output),
      });
    default:
      return undefined;
  }
}

/** One-line preview for the history tree: the first prompt the operator actually typed. */
export function summarise(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

export interface TranscriptRenderOptions {
  /**
   * Include the tool *invocations* — the commands run and the patches applied.
   *
   * Separate from their output because the two differ in volume by an order of magnitude.
   * On a real 128 MB rollout the prose alone is 35 KB; adding calls and output together
   * produced 3.9 MB, which is not a document anyone reads.
   */
  includeToolCalls?: boolean;
  /** Include what the tools printed back. Defaults to whatever `includeToolCalls` is. */
  includeToolOutput?: boolean;
  /** Replace recognised credential shapes. Defaults to true; disabling it may expose secrets. */
  redactSecrets?: boolean;
  /** Include the injected prompt scaffolding. */
  includeContext?: boolean;
  /** Truncate any single block to this many characters. */
  maxBlockLength?: number;
  /**
   * Separate, much tighter cap for tool blocks.
   *
   * A tool call is worth reading for *what was run*, not for its payload: an `apply_patch`
   * invocation carries the entire new contents of every file it writes, which is why a
   * transcript with tool calls at the prose cap came to 3.8 MB against 35 KB without them.
   * A few hundred characters shows the command and the files; the rest is already on disk.
   */
  maxToolBlockLength?: number;
}

const ROLE_HEADINGS: Record<TranscriptRole, string> = {
  user: '## You',
  assistant: '## Codex',
  developer: '## Developer',
  reasoning: '## Reasoning',
  tool: '### Tool call',
  output: '### Tool output',
  compaction: '---\n\n### Context compacted',
};

function fence(text: string): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce(
    (widest, match) => Math.max(widest, match[0].length),
    2,
  );
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

export interface TranscriptHeaderOptions {
  /** Whether the export applied its default secret redaction pass. */
  redactionEnabled?: boolean;
  /** Number of credential-shaped values replaced in the export. */
  redactionCount?: number;
}

export function renderTranscriptHeader(
  meta: TranscriptMeta,
  project: string,
  options: TranscriptHeaderOptions = {},
): string {
  const redactionLine = options.redactionEnabled === false
    ? '- **Secret redaction:** disabled — this export may contain credentials.'
    : `- **Secret redactions:** ${options.redactionCount ?? 0}`;
  return [
    `# Codex session — ${project || meta.cwd || meta.id}`,
    '',
    `- **Session id:** \`${meta.id}\``,
    `- **Started:** ${meta.timestamp}`,
    `- **Working directory:** \`${meta.cwd}\``,
    ...(meta.cliVersion ? [`- **Codex CLI:** ${meta.cliVersion}`] : []),
    `- **Rollout schema:** ${meta.schemaGeneration}`,
    redactionLine,
    ...(meta.originator ? [`- **Originator:** ${meta.originator}`] : []),
    '',
    `Resume it with \`codex resume ${meta.id}\`.`,
    '',
    '---',
    '',
  ].join('\n');
}

/** Render one entry, or nothing when the options exclude it. */
export function renderTranscriptEntry(
  entry: TranscriptEntry,
  options: TranscriptRenderOptions = {},
): string | undefined {
  const {
    includeToolCalls = false,
    includeToolOutput = includeToolCalls,
    includeContext = false,
    maxBlockLength = 20000,
    maxToolBlockLength = 400,
  } = options;

  if (entry.role === 'developer' && !includeContext) {
    return undefined;
  }
  if (entry.role === 'tool' && !includeToolCalls) {
    return undefined;
  }
  if (entry.role === 'output' && !includeToolOutput) {
    return undefined;
  }
  if (entry.role === 'user' && !includeContext && isInjectedContext(entry.text)) {
    return undefined;
  }

  const isTool = entry.role === 'tool' || entry.role === 'output';
  const limit = isTool ? maxToolBlockLength : maxBlockLength;
  const truncated =
    entry.text.length > limit
      ? `${entry.text.slice(0, limit)}\n\n… truncated (${entry.text.length - limit} more characters)`
      : entry.text;

  const heading =
    entry.name && (entry.role === 'tool' || entry.role === 'output')
      ? `${ROLE_HEADINGS[entry.role]} — \`${entry.name}\``
      : ROLE_HEADINGS[entry.role];
  const body =
    entry.role === 'tool' || entry.role === 'output' ? fence(truncated) : truncated;
  return `${heading}\n\n${body}\n`;
}
