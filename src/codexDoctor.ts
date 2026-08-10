/**
 * Parser for `codex doctor --json`.
 *
 * The extension hands Codex configuration through invocation-scoped `-c` overrides, and
 * those are **not validated**: `--strict-config` inspects `config.toml` only, so a wrong
 * key is accepted, silently ignored, and leaves no symptom to notice. `codex doctor --json`
 * is the one place Codex will say what it actually resolved, so it is the only way to
 * confirm an override landed rather than assuming it did.
 *
 * Pure — no `vscode`, no child process — so the shapes below are exercised against real
 * captured output under `node --test`.
 */

export type CodexCheckStatus = 'ok' | 'warning' | 'error' | 'skipped' | string;

export interface CodexIssue {
  severity: string;
  cause?: string;
  measured?: string;
  expected?: string;
  remedy?: string;
}

export interface CodexCheck {
  id: string;
  category?: string;
  status: CodexCheckStatus;
  summary?: string;
  details: Record<string, string>;
  issues: CodexIssue[];
}

export interface CodexDoctorReport {
  codexVersion?: string;
  overallStatus?: string;
  checks: CodexCheck[];
}

/** Resolved state of `[tui].terminal_title`, as Codex itself reports it. */
export interface TitleDiagnosis {
  /** Items Codex accepted, in the order it will render them. */
  items: string[];
  /** Items Codex refused — the silent-failure this whole module exists to surface. */
  invalidItems: string[];
  /** Whether the animated activity indicator is among the accepted items. */
  activity: boolean;
  /** `configured` when our override landed, `default` when it did not reach Codex. */
  source?: string;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

function issues(value: unknown): CodexIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      severity: typeof entry.severity === 'string' ? entry.severity : 'warning',
      ...(typeof entry.cause === 'string' ? { cause: entry.cause } : {}),
      ...(typeof entry.measured === 'string' ? { measured: entry.measured } : {}),
      ...(typeof entry.expected === 'string' ? { expected: entry.expected } : {}),
      ...(typeof entry.remedy === 'string' ? { remedy: entry.remedy } : {}),
    }));
}

/**
 * Parse a doctor payload. `checks` is a map keyed by check id, not an array, and an older
 * or newer Codex may omit fields entirely — anything unreadable yields `undefined` so the
 * caller falls back to the extension's own diagnostics rather than rendering blanks.
 */
export function parseCodexDoctor(text: string): CodexDoctorReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.checks !== 'object' || root.checks === null) {
    return undefined;
  }

  const checks: CodexCheck[] = Object.entries(root.checks as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === 'object' && entry[1] !== null,
    )
    .map(([id, check]) => ({
      id: typeof check.id === 'string' ? check.id : id,
      ...(typeof check.category === 'string' ? { category: check.category } : {}),
      status: typeof check.status === 'string' ? check.status : 'ok',
      ...(typeof check.summary === 'string' ? { summary: check.summary } : {}),
      details: stringRecord(check.details),
      issues: issues(check.issues),
    }));

  return {
    ...(typeof root.codexVersion === 'string' ? { codexVersion: root.codexVersion } : {}),
    ...(typeof root.overallStatus === 'string' ? { overallStatus: root.overallStatus } : {}),
    checks,
  };
}

export function findCheck(report: CodexDoctorReport, id: string): CodexCheck | undefined {
  return report.checks.find((check) => check.id === id);
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Read the `terminal.title` check into the facts the extension needs. */
export function diagnoseTitle(report: CodexDoctorReport): TitleDiagnosis | undefined {
  const check = findCheck(report, 'terminal.title');
  if (!check) {
    return undefined;
  }
  return {
    items: splitList(check.details['terminal title items']),
    invalidItems: splitList(check.details['terminal title invalid items']),
    activity: check.details['terminal title activity'] === 'true',
    ...(check.details['terminal title source']
      ? { source: check.details['terminal title source'] }
      : {}),
  };
}

/** Checks worth showing: anything Codex itself is unhappy about. */
export function notableChecks(report: CodexDoctorReport): CodexCheck[] {
  return report.checks.filter(
    (check) => check.status !== 'ok' && check.status !== 'skipped',
  );
}
