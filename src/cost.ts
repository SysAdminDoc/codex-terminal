/**
 * Turning a session's token counts into money, and refusing to when that would be a guess.
 *
 * Every number here comes from the operator's own rate table. Nothing is shipped: the models
 * Codex actually names in its rollouts are internal aliases — `gpt-5.6-luna`, `gpt-5.6-sol`
 * across the 60 most recent sessions on the machine this was built on — and no public price
 * list covers them. A bundled table would be stale the week it shipped and wrong in a way the
 * operator could not see, which is worse than an empty column.
 *
 * Pure and `vscode`-free, so the arithmetic is unit tested.
 */

import type { SessionActivity } from './activity';

/**
 * Prices in USD per million tokens, which is the unit every provider publishes, so a rate can
 * be copied off a pricing page without arithmetic in between.
 */
export interface ModelRate {
  input: number;
  /** Discounted rate for a cache hit. Absent means cache hits are billed at `input`. */
  cachedInput?: number;
  output: number;
}

export type RateTable = Record<string, ModelRate>;

export interface CostEstimate {
  model: string;
  /** Undefined when the model is not in the table: unpriced, which is not the same as free. */
  usd?: number;
  /** Subscription the session reported, if any. Its presence means this is not a bill. */
  plan?: string;
}

const PER_MILLION = 1_000_000;

function isRate(value: unknown): value is ModelRate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.input === 'number' &&
    Number.isFinite(record.input) &&
    typeof record.output === 'number' &&
    Number.isFinite(record.output)
  );
}

/**
 * Look a model up, tolerating the difference between what the operator types and what Codex
 * records. Matching is case-insensitive, and a table key that is a prefix of the recorded
 * model matches too — `gpt-5.6` prices `gpt-5.6-luna` — because Codex's suffixes are release
 * aliases of one priced model. The longest matching key wins, so a specific entry always
 * beats a family one.
 */
export function rateFor(table: RateTable | undefined, model: string | undefined): ModelRate | undefined {
  if (!table || !model) {
    return undefined;
  }
  const wanted = model.toLowerCase();
  let best: { key: string; rate: ModelRate } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (!isRate(value)) {
      continue;
    }
    const candidate = key.toLowerCase();
    if (candidate !== wanted && !wanted.startsWith(candidate)) {
      continue;
    }
    if (!best || candidate.length > best.key.length) {
      best = { key: candidate, rate: value };
    }
  }
  return best?.rate;
}

/**
 * What this session would cost at the operator's rates.
 *
 * Returns undefined only when there is nothing to say — no model recorded yet, or no usage.
 * A model with no rate still comes back, without a figure, so the caller can name it: knowing
 * *which* key to add to the table is the whole difference between an unpriced session and a
 * mystery.
 */
export function estimateCost(
  activity: SessionActivity,
  table: RateTable | undefined,
): CostEstimate | undefined {
  const model = activity.model;
  if (!model) {
    return undefined;
  }
  const base: CostEstimate = { model, ...(activity.plan ? { plan: activity.plan } : {}) };
  const rate = rateFor(table, model);
  if (!rate) {
    return base;
  }
  const input = activity.inputTokens;
  const output = activity.outputTokens;
  if (input === undefined && output === undefined) {
    return base;
  }
  // `input_tokens` in the rollout is the whole prompt, cache hits included, so the uncached
  // remainder is the subtraction. Reading it as "uncached" double-charges every cached token.
  const cached = Math.min(activity.cachedInputTokens ?? 0, input ?? 0);
  const uncached = Math.max(0, (input ?? 0) - cached);
  const cachedRate = rate.cachedInput ?? rate.input;
  const usd =
    (uncached * rate.input + cached * cachedRate + (output ?? 0) * rate.output) / PER_MILLION;
  return { ...base, usd };
}

/**
 * Money, at a precision that does not lie in either direction. Anything that would round to
 * `$0.00` says so as a bound instead, because a session that cost a fraction of a cent did not
 * cost nothing.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) {
    return '';
  }
  if (usd === 0) {
    return '$0.00';
  }
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
