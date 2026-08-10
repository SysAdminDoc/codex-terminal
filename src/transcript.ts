/**
 * Rollout (`~/.codex/sessions/**\/*.jsonl`) → readable transcript.
 *
 * Pure line-at-a-time functions with no `vscode` and no filesystem, so the whole format
 * can be exercised by `node --test` and so a caller can stream a 100 MB rollout without
 * ever holding it in memory.
 */

export type TranscriptRole = 'user' | 'assistant' | 'developer' | 'reasoning' | 'tool' | 'output';

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for `tool`/`output` entries. */
  name?: string;
  timestamp?: string;
}

export interface TranscriptMeta {
  id: string;
  timestamp: string;
  cwd: string;
  cliVersion?: string;
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
  return {
    id,
    timestamp: payload.timestamp,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    ...(typeof payload.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
    ...(typeof payload.originator === 'string' ? { originator: payload.originator } : {}),
  };
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
  if (record.type !== 'response_item' || !payload) {
    return undefined;
  }
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined;
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
  /** Include tool calls and their output. Off by default: they dominate a rollout. */
  includeToolCalls?: boolean;
  /** Include the injected prompt scaffolding. */
  includeContext?: boolean;
  /** Truncate any single block to this many characters. */
  maxBlockLength?: number;
}

const ROLE_HEADINGS: Record<TranscriptRole, string> = {
  user: '## You',
  assistant: '## Codex',
  developer: '## Developer',
  reasoning: '## Reasoning',
  tool: '### Tool call',
  output: '### Tool output',
};

function fence(text: string): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce(
    (widest, match) => Math.max(widest, match[0].length),
    2,
  );
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text}\n${ticks}`;
}

export function renderTranscriptHeader(meta: TranscriptMeta, project: string): string {
  return [
    `# Codex session — ${project || meta.cwd || meta.id}`,
    '',
    `- **Session id:** \`${meta.id}\``,
    `- **Started:** ${meta.timestamp}`,
    `- **Working directory:** \`${meta.cwd}\``,
    ...(meta.cliVersion ? [`- **Codex CLI:** ${meta.cliVersion}`] : []),
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
  const { includeToolCalls = false, includeContext = false, maxBlockLength = 20000 } = options;

  if (entry.role === 'developer' && !includeContext) {
    return undefined;
  }
  if ((entry.role === 'tool' || entry.role === 'output') && !includeToolCalls) {
    return undefined;
  }
  if (entry.role === 'user' && !includeContext && isInjectedContext(entry.text)) {
    return undefined;
  }

  const truncated =
    entry.text.length > maxBlockLength
      ? `${entry.text.slice(0, maxBlockLength)}\n\n… truncated (${
          entry.text.length - maxBlockLength
        } more characters)`
      : entry.text;

  const heading =
    entry.name && (entry.role === 'tool' || entry.role === 'output')
      ? `${ROLE_HEADINGS[entry.role]} — \`${entry.name}\``
      : ROLE_HEADINGS[entry.role];
  const body =
    entry.role === 'tool' || entry.role === 'output' ? fence(truncated) : truncated;
  return `${heading}\n\n${body}\n`;
}
