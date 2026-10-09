import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingLedger, localDay } from '../lib/billing-core.mjs';

// Synthetic fixtures. Production rates come from the independently verified
// provider documentation/time-window resolver, never from this test module.
const cny = {
  provider: 'deepseek', model: 'fixture-model', aliases: ['fixture-alias'], currency: 'CNY',
  inputPerMillion: '2', cacheHitPerMillion: '0.04', outputPerMillion: '8',
  sourceUrl: 'https://pricing.example/verified-fixture', asOf: '2026-10-09',
};
const usd = { ...cny, currency: 'USD', inputPerMillion: '0.3', cacheHitPerMillion: '0.006', outputPerMillion: '1.2' };
const at = new Date(2026, 9, 9, 12, 0, 0).getTime();
const request = (extra = {}) => ({
  sessionId: 'session-a', eventSeq: 0, turnId: 1, at,
  provider: 'deepseek', model: 'fixture-model',
  usage: { inputTokens: 500, cacheHitTokens: 200, outputTokens: 100, totalTokens: 600 },
  ...extra,
});
const cost = (summary, currency = 'CNY') => summary.costs.find(value => value.currency === currency);
const reopened = (ledger, extra = {}) => new BillingLedger({ state: JSON.parse(JSON.stringify(ledger.exportState())), now: () => at, ...extra });

test('cache-inclusive input is counted once and exact decimal estimates use its cache partition', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  const result = ledger.recordUsage(request());
  assert.equal(result.added, true);
  assert.deepEqual(result.record.usage, {
    inputTokens: 500, cacheHitTokens: 200, cacheMissTokens: 300, outputTokens: 100, totalTokens: 600, issues: [],
  });
  const summary = ledger.snapshot().today;
  assert.equal(summary.tokens.inputTokens, 500);
  assert.equal(summary.tokens.totalTokens, 600);
  assert.equal(cost(summary).amountDecimal, '0.001408');
  assert.equal(cost(summary).source, 'estimated');
  assert.equal(cost(summary).estimatedRequests, 1);
  assert.equal(ledger.snapshot().scope, 'dsh-observed');
});

test('missing cache details, unknown models and inconsistent partitions remain unpriced rather than zero', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  const missing = ledger.recordUsage(request({ usage: { inputTokens: 500, outputTokens: 100 } }));
  assert.equal(missing.record.costs[0].amount, null);
  assert.equal(missing.record.costs[0].reason, 'incomplete-cache-partition');
  const inconsistent = ledger.recordUsage(request({ eventSeq: 1, usage: { inputTokens: 500, cacheHitTokens: 501, outputTokens: 100 } }));
  assert.equal(inconsistent.record.costs[0].amount, null);
  assert.equal(inconsistent.record.costs[0].reason, 'inconsistent-cache-partition');
  const unknown = ledger.recordUsage(request({ eventSeq: 2, model: 'unknown-model' }));
  assert.equal(unknown.record.costs[0].currency, null);
  assert.equal(unknown.record.costs[0].amount, null);
  assert.equal(ledger.snapshot().today.unknownCostRequests, 3);
  assert.equal(ledger.snapshot().today.tokens.totalTokens, 1800);
  const incompleteRate = new BillingLedger({ rates: [{ ...cny, cacheHitPerMillion: undefined }] });
  assert.equal(incompleteRate.recordUsage(request()).record.costs[0].reason, 'incomplete-cache-rate');
  assert.equal(incompleteRate.recordUsage(request({ eventSeq: 1, usage: { inputTokens: 500, cacheHitTokens: 0, outputTokens: 100 } })).record.costs[0].amountDecimal, '0.0018');
});

test('host reported amounts remain estimates unless explicitly established as provider bills', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  const host = ledger.recordUsage(request({ reportedCost: { amount: '0.1', currency: 'cny' } }));
  assert.equal(host.record.costs[0].amountDecimal, '0.1');
  assert.equal(host.record.costs[0].source, 'estimated');
  assert.equal(host.record.costs[0].provenance, 'host-reported');
  const provider = ledger.recordUsage(request({ eventSeq: 1, reportedCost: { amount: '0.2', currency: 'CNY', providerBilled: true } }));
  assert.equal(provider.record.costs[0].source, 'reported');
  const summary = ledger.snapshot().today;
  assert.equal(cost(summary).amountDecimal, '0.3');
  assert.equal(cost(summary).amount, 0.3);
  assert.equal(cost(summary).source, 'mixed');
  const free = ledger.recordUsage(request({ eventSeq: 2, usage: {}, reportedCost: { amount: 0, currency: 'CNY', providerBilled: true } }));
  assert.equal(free.record.costs[0].amount, 0);
  assert.equal(free.record.costs[0].source, 'reported');
  const noCurrency = new BillingLedger().recordUsage(request({ reportedCost: { amount: 99 } }));
  assert.equal(noCurrency.record.costs[0].amount, null);
});

test('dedup identities and alternate aliases persist across restart without mixing sessions', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  ledger.recordUsage(request({ requestId: 'request-1' }));
  assert.equal(ledger.recordUsage(request({ requestId: 'request-1' })).changed, false);
  const alias = ledger.recordUsage(request({ eventSeq: 8, requestId: 'request-1' }));
  assert.equal(alias.added, false);
  assert.equal(alias.changed, true);
  ledger.recordUsage(request({ sessionId: 'session-b', requestId: 'request-1' }));
  const restored = reopened(ledger);
  assert.equal(restored.recordUsage(request({ eventSeq: 8, requestId: null })).added, false);
  assert.equal(restored.recordUsage(request({ eventSeq: undefined, requestId: 'request-1' })).added, false);
  assert.equal(restored.snapshot().today.requests, 2);
  assert.equal(restored.snapshot().today.tokens.totalTokens, 1200);
  assert.equal(cost(restored.snapshot().today).amountDecimal, '0.002816');
  assert.throws(() => ledger.recordUsage(request({ eventSeq: undefined })), /persistent deduplication/);
});

test('conflicting aliases fail rather than combining two distinct API requests', () => {
  const ledger = new BillingLedger({ now: () => at });
  ledger.recordUsage(request({ eventSeq: 1, requestId: 'first' }));
  ledger.recordUsage(request({ eventSeq: 2, requestId: 'second' }));
  assert.throws(() => ledger.recordUsage(request({ eventSeq: 1, requestId: 'second' })), /different existing requests/);
  assert.equal(ledger.snapshot().today.requests, 2);
});

test('local midnight splits daily usage while an entire task retains both days of costs', () => {
  const before = new Date(2026, 9, 8, 23, 59, 30).getTime();
  const after = new Date(2026, 9, 9, 0, 0, 30).getTime();
  const ledger = new BillingLedger({ rates: [cny], now: () => after });
  ledger.recordUsage(request({ at: before, usage: { inputTokens: 1_000_000, cacheHitTokens: 0, outputTokens: 0 } }));
  ledger.recordUsage(request({ eventSeq: 1, at: after, usage: { inputTokens: 0, outputTokens: 1_000_000 } }));
  const completion = ledger.completeTask({ sessionId: 'session-a', turnId: 1, at: after });
  assert.equal(completion.completed, true);
  assert.equal(cost(completion.task).amountDecimal, '10');
  assert.equal(completion.task.tokens.totalTokens, 2_000_000);
  assert.equal(completion.task.day, '2026-10-09');
  assert.equal(cost(ledger.snapshot({ day: '2026-10-08' }).today).amountDecimal, '2');
  assert.equal(cost(ledger.snapshot({ day: '2026-10-09' }).today).amountDecimal, '8');
  const restored = reopened(ledger, { now: () => new Date(2026, 9, 10, 12).getTime() });
  const duplicate = restored.completeTask({ sessionId: 'session-a', turnId: 1, at: after + 86400_000 });
  assert.equal(duplicate.completed, false);
  assert.equal(duplicate.task.completedAt, after);
  assert.equal(restored.snapshot().today.requests, 0);
  assert.equal(restored.snapshot({ day: '2026-10-09' }).today.completedTasks, 1);
  assert.equal(cost(restored.snapshot().lastTask).amountDecimal, '10');
  assert.equal(localDay(before), '2026-10-08');
  assert.equal(localDay(after), '2026-10-09');
});

test('simultaneous tasks in separate sessions aggregate independently even with the same turn number', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  ledger.recordUsage(request());
  ledger.recordUsage(request({ sessionId: 'session-b', usage: { inputTokens: 0, outputTokens: 1_000_000 } }));
  const a = ledger.completeTask({ sessionId: 'session-a', turnId: 1 }).task;
  const b = ledger.completeTask({ sessionId: 'session-b', turnId: 1 }).task;
  assert.notEqual(a.key, b.key);
  assert.equal(cost(a).amountDecimal, '0.001408');
  assert.equal(cost(b).amountDecimal, '8');
  ledger.recordUsage(request({ eventSeq: 1, turnId: undefined, taskId: 'explicit-task' }));
  assert.equal(ledger.getTask({ sessionId: 'session-a', taskId: 'explicit-task' }).requests, 1);
  assert.equal(ledger.getTask({ sessionId: 'session-a', turnId: 1 }).requests, 1);
});

test('different currencies are separate totals and an unpriced request makes each total explicitly incomplete', () => {
  const ledger = new BillingLedger({ rates: [cny, usd], now: () => at });
  ledger.recordUsage(request());
  const summary = ledger.snapshot().today;
  assert.equal(summary.costs.length, 2);
  assert.equal(cost(summary, 'CNY').amountDecimal, '0.001408');
  assert.equal(cost(summary, 'USD').amountDecimal, '0.0002112');
  assert.equal(Object.hasOwn(summary, 'amount'), false);
  ledger.recordUsage(request({ eventSeq: 1, model: 'not-priced' }));
  const incomplete = ledger.snapshot().today;
  assert.equal(cost(incomplete, 'CNY').amount, null);
  assert.equal(cost(incomplete, 'CNY').knownAmountDecimal, '0.001408');
  assert.equal(cost(incomplete, 'USD').amount, null);
  assert.equal(cost(incomplete, 'USD').knownAmountDecimal, '0.0002112');
  assert.equal(incomplete.unknownCostRequests, 1);
});

test('separate provider bill currencies are never added or converted implicitly', () => {
  const ledger = new BillingLedger({ now: () => at });
  ledger.recordUsage(request({ reportedCost: { amount: '.1', currency: 'CNY', providerBilled: true } }));
  ledger.recordUsage(request({ eventSeq: 1, reportedCost: { amount: '0.2', currency: 'USD', providerBilled: true } }));
  assert.equal(cost(ledger.snapshot().today, 'CNY').amountDecimal, '0.1');
  assert.equal(cost(ledger.snapshot().today, 'USD').amountDecimal, '0.2');
});

test('rate resolver uses the recorded request time and saved pricing is not recalculated after restart', () => {
  const seen = [];
  const ledger = new BillingLedger({ now: () => at + 1000, rates(context) {
    seen.push(context);
    return context.model === cny.model ? cny : null;
  } });
  ledger.recordUsage(request());
  assert.equal(seen[0].at, at);
  const restored = reopened(ledger, { rates: () => ({ ...cny, inputPerMillion: '9999', outputPerMillion: '9999' }) });
  assert.equal(cost(restored.snapshot().today).amountDecimal, '0.001408');
  assert.equal(restored.exportState().records[0].costs[0].sourceUrl, cny.sourceUrl);
  assert.equal(ledger.recordUsage(request({ eventSeq: 1, model: 'unknown-model' })).record.costs[0].amount, null);
});

test('known zero input does not need cache detail, while incomplete token counts remain explicit', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  assert.equal(ledger.recordUsage(request({ usage: { inputTokens: 0, outputTokens: 100 } })).record.costs[0].amountDecimal, '0.0008');
  ledger.recordUsage(request({ eventSeq: 1, usage: { totalTokens: 15 } }));
  const summary = ledger.snapshot().today;
  assert.equal(summary.tokens.inputTokens, null);
  assert.equal(summary.tokens.outputTokens, null);
  assert.equal(summary.tokens.knownInputTokens, 0);
  assert.equal(summary.tokens.knownOutputTokens, 100);
  assert.equal(summary.tokens.totalTokens, 115);
  assert.equal(summary.tokens.unknownRequests, 1);
  assert.equal(cost(summary).amount, null);
});

test('a completed task without observed model usage is not claimed to be free', () => {
  const ledger = new BillingLedger({ now: () => at });
  const task = ledger.completeTask({ sessionId: 'no-model-call', turnId: 1 }).task;
  assert.equal(task.requests, 0);
  assert.equal(task.costs[0].amount, null);
  assert.equal(task.costs[0].reason, 'no-usage-observed');
  assert.equal(ledger.snapshot().today.completedTasks, 1);
  assert.equal(ledger.snapshot().today.tokens.totalTokens, 0);
});

test('reasoning tokens are not added again and inconsistent reported totals do not override components', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  const result = ledger.recordUsage(request({ usage: { inputTokens: 500, cacheHitTokens: 200, outputTokens: 100, reasoningTokens: 90, totalTokens: 999 } }));
  assert.equal(result.record.usage.totalTokens, 600);
  assert.deepEqual(result.record.usage.issues, ['inconsistent-reported-total']);
  assert.equal(cost(ledger.snapshot().today).amountDecimal, '0.001408');
});

test('compaction-like usage without a task id remains part of daily observed usage', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  ledger.recordUsage(request({ turnId: undefined, model: 'fixture-alias' }));
  assert.equal(ledger.snapshot().today.requests, 1);
  assert.equal(ledger.snapshot().tasks.length, 0);
  assert.equal(cost(ledger.snapshot().today).amountDecimal, '0.001408');
});

test('exported state and returned summaries cannot mutate the live ledger', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  const result = ledger.recordUsage(request());
  result.record.costs[0].amountDecimal = '999';
  const exported = ledger.exportState();
  exported.records[0].usage.inputTokens = 999;
  const snapshot = ledger.snapshot();
  snapshot.tasks[0].tokens.totalTokens = 999;
  assert.equal(ledger.snapshot().today.tokens.inputTokens, 500);
  assert.equal(cost(ledger.snapshot().today).amountDecimal, '0.001408');
});

test('invalid counts, ambiguous currency rates and corrupted persisted identities fail explicitly', () => {
  const ledger = new BillingLedger({ rates: [cny], now: () => at });
  assert.throws(() => ledger.recordUsage(request({ usage: { inputTokens: -1, outputTokens: 1 } })), /non-negative safe integers/);
  assert.throws(() => ledger.recordUsage(request({ usage: { inputTokens: 0.5, outputTokens: 1 } })), /non-negative safe integers/);
  assert.throws(() => new BillingLedger({ state: { version: 99 } }), /Unsupported/);
  assert.throws(() => new BillingLedger({ rates: [cny, cny] }).recordUsage(request()), /Duplicate currency/);
  assert.throws(() => new BillingLedger({ rates: () => Promise.resolve(cny) }).recordUsage(request()), /synchronous/);
  assert.throws(() => ledger.snapshot({ day: '2026-02-30' }), /Invalid calendar day/);
  ledger.recordUsage(request());
  const state = ledger.exportState();
  state.records.push(structuredClone(state.records[0]));
  assert.throws(() => new BillingLedger({ state }), /Duplicate request/);
  const wrongSessionAlias = ledger.exportState();
  wrongSessionAlias.records[0].aliases.push(JSON.stringify(['event', 'another-session', 20]));
  assert.throws(() => new BillingLedger({ state: wrongSessionAlias }), /Invalid persisted usage aliases/);
});
