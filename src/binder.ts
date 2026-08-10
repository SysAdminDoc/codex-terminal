import { open, readdir } from 'node:fs/promises';
import * as path from 'node:path';

import { parseSessionMeta } from './transcript';

/**
 * Matching a terminal we launched to the rollout Codex started for it.
 *
 * Codex chooses its own rollout path and tells no one, so the link has to be inferred.
 * Two facts make that reliable: the filename carries both the session id and the start
 * time, and `session_meta` carries the working directory. A launch is therefore bound to
 * the earliest rollout that started at-or-after it, in the same directory, that no other
 * live session has already claimed.
 *
 * `vscode`-free so the filename grammar and the matching rules are unit tested.
 */

export interface RolloutCandidate {
  filePath: string;
  sessionId: string;
  /** Epoch ms, from the filename, which Codex writes in local time. */
  startedAt: number;
}

export interface LaunchToBind {
  cwd: string;
  launchedAt: number;
}

/**
 * Codex may stamp the filename a moment before the launch timestamp we recorded, and the
 * two clocks are read at slightly different points, so the comparison is given slack.
 */
export const BIND_SKEW_MS = 10_000;

const ROLLOUT_NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f-]{36})\.jsonl$/i;

/**
 * Pull the session id and start time out of a rollout filename.
 *
 * The timestamp is local time, not UTC — the file for a `session_meta` stamped
 * `16:26:58Z` is named `T12-26-58` on a UTC-4 machine — so it is reconstructed with the
 * local-time `Date` constructor rather than parsed as ISO.
 */
export function parseRolloutFileName(fileName: string): Omit<RolloutCandidate, 'filePath'> | undefined {
  const match = ROLLOUT_NAME.exec(fileName);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, sessionId] = match;
  const startedAt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isNaN(startedAt) ? undefined : { sessionId, startedAt };
}

/** Compare paths the way the host filesystem does. */
export function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalise = (value: string): string => {
    const trimmed = value.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalise(left) === normalise(right);
}

/**
 * Choose the rollout belonging to a launch, or nothing when none qualifies yet.
 *
 * Candidates must already have had their `cwd` checked by the caller — reading it costs a
 * file open, so it is done once during the scan rather than repeatedly here.
 */
export function bindRollout(
  candidates: readonly RolloutCandidate[],
  launch: LaunchToBind,
  claimed: ReadonlySet<string>,
  skewMs = BIND_SKEW_MS,
): RolloutCandidate | undefined {
  return [...candidates]
    .filter(
      (candidate) =>
        !claimed.has(candidate.filePath) && candidate.startedAt >= launch.launchedAt - skewMs,
    )
    .sort((left, right) => left.startedAt - right.startedAt)[0];
}

/** Date-sharded directories (`YYYY/MM/DD`) a session started at `since` could live in. */
export function candidateDirectories(sessionsRoot: string, since: number, now: number): string[] {
  const directories: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  for (let stamp = since; ; stamp += day) {
    const date = new Date(Math.min(stamp, now));
    directories.push(
      path.join(
        sessionsRoot,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ),
    );
    if (stamp >= now) {
      break;
    }
  }
  return [...new Set(directories)];
}

/** First line of a rollout, which is always `session_meta`. */
async function readFirstLine(filePath: string, maxBytes = 64 * 1024): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    await handle.close();
  }
}

/**
 * Rollouts started at or after `since` whose working directory matches, cheapest checks
 * first: the filename yields the id and the start time with no I/O at all, so only the
 * few files that survive that filter are ever opened.
 */
export async function scanRollouts(
  sessionsRoot: string,
  cwd: string,
  since: number,
  now: number,
  platform: NodeJS.Platform = process.platform,
  skewMs = BIND_SKEW_MS,
): Promise<RolloutCandidate[]> {
  const found: RolloutCandidate[] = [];
  for (const directory of candidateDirectories(sessionsRoot, since, now)) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const parsed = parseRolloutFileName(entry);
      if (!parsed || parsed.startedAt < since - skewMs) {
        continue;
      }
      const filePath = path.join(directory, entry);
      try {
        const meta = parseSessionMeta(await readFirstLine(filePath));
        if (meta && samePath(meta.cwd, cwd, platform)) {
          found.push({ ...parsed, filePath });
        }
      } catch {
        // A rollout mid-creation has no readable first line yet; the next poll retries.
      }
    }
  }
  return found;
}
