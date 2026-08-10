import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INITIAL_ACTIVITY, type SessionActivity } from '../activity';
import { estimateCost, formatCost, rateFor, type RateTable } from '../cost';

const RATES: RateTable = {
  'gpt-5.6': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5.6-sol': { input: 2, output: 20 },
};

function activity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return { ...INITIAL_ACTIVITY, ...overrides };
}

test('a family rate prices every alias under it, and a specific rate wins', () => {
  // Codex names release aliases, not the model on any price page: `gpt-5.6-luna` and
  // `gpt-5.6-sol` were the only two across the 60 most recent rollouts on this machine.
  assert.equal(rateFor(RATES, 'gpt-5.6-luna')?.input, 1.25);
  assert.equal(rateFor(RATES, 'gpt-5.6-sol')?.input, 2);
  assert.equal(rateFor(RATES, 'GPT-5.6-Luna')?.input, 1.25);
  assert.equal(rateFor(RATES, 'claude-4'), undefined);
  assert.equal(rateFor(undefined, 'gpt-5.6'), undefined);
});

test('a malformed rate is ignored rather than producing NaN money', () => {
  const table = { 'gpt-5.6': { input: 'free', output: 10 } } as unknown as RateTable;
  assert.equal(rateFor(table, 'gpt-5.6-luna'), undefined);
});

test('cached input is the discounted part of the input total, not an extra charge', () => {
  // The rollout reports `input_tokens` as the whole prompt with `cached_input_tokens` inside
  // it. Reading them as two separate charges bills every cached token twice.
  const estimate = estimateCost(
    activity({
      model: 'gpt-5.6-luna',
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 10_000,
    }),
    RATES,
  );
  // 20k uncached at 1.25, 80k cached at 0.125, 10k output at 10, per million.
  assert.equal(estimate?.usd, 0.025 + 0.01 + 0.1);
});

test('a missing cached rate bills cache hits at the full input price', () => {
  const estimate = estimateCost(
    activity({ model: 'gpt-5.6-sol', inputTokens: 1_000_000, cachedInputTokens: 500_000 }),
    RATES,
  );
  assert.equal(estimate?.usd, 2);
});

test('a model with no rate is unpriced and named, never zero', () => {
  const estimate = estimateCost(
    activity({ model: 'gpt-7-unknown', inputTokens: 500_000, outputTokens: 100_000 }),
    RATES,
  );
  assert.equal(estimate?.usd, undefined);
  // Naming it is the point: it is the key the operator has to add.
  assert.equal(estimate?.model, 'gpt-7-unknown');
});

test('a session whose model is not recorded yet says nothing at all', () => {
  assert.equal(estimateCost(activity({ inputTokens: 10_000 }), RATES), undefined);
});

test('a subscription session carries its plan so the figure is never presented as a charge', () => {
  // Every one of the 60 rollouts measured reported `plan_type: pro`, which means the tokens
  // were not billed per token at all. A cost with no such caveat would be an invented bill.
  const estimate = estimateCost(
    activity({ model: 'gpt-5.6-luna', plan: 'pro', inputTokens: 1_000_000 }),
    RATES,
  );
  assert.equal(estimate?.plan, 'pro');
  assert.equal(estimate?.usd, 1.25);
});

test('money never rounds down to free', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.0004), '<$0.01');
  assert.equal(formatCost(0.009), '<$0.01');
  assert.equal(formatCost(0.01), '$0.01');
  assert.equal(formatCost(12.3456), '$12.35');
});
