import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBillingHost, normalizeDSHUsage } from '../lib/billing-host.mjs';
import { BillingLedger } from '../lib/billing-core.mjs';

const FAKE_KEY = 'fixture-not-a-real-key';
const initialTime = new Date(2026, 9, 9, 12, 0, 0).getTime();
const session = id => ({ id, inheritedEventCount: 0, firstLiveSeq: 0 });
const event = (seq, type, data, time = initialTime) => ({ seq, type, data, time });
const start = (seq = 0, turn = 1, time) => event(seq, 'turn/start', { turn }, time);
const end = (seq, turn = 1, time, kind = 'completed') => event(seq, 'turn/end', { turn, reason: { kind } }, time);
const assistant = (seq, turn, step, usage, extra = {}) => event(seq, 'assistant/message', {
  turn, step, usage, stream: [],
  message: {
    id: `fixture-message-${seq}`, role: 'assistant',
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash', ...extra },
    content: [{ type: 'text', text: 'Synthetic fixture response' }],
  },
});
const usageA = { inputTokens: 100, cacheReadTokens: 20, outputTokens: 50, totalTokens: 170 };
const usageB = { inputTokens: 30, cacheReadTokens: 10, outputTokens: 10, totalTokens: 50 };
const attempt = (seq, turn, step, usages) => event(seq, 'assistant/attempt', {
  turn, step,
  stream: usages.map((usage, index) => ({ type: 'chunk', time: initialTime + index, chunk: { type: 'usage', usage } })),
});
const routedSession = id => ({
  ...session(id),
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
});

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'whale-billing-host-'));
  const hosts = [];
  const requests = [];
  const references = [];
  const clock = { value: initialTime };
  const account = { currency: 'USD', total: '10.00' };
  t.after(async () => {
    for (const host of hosts) await host.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function open({ configured = true, onChange, warn, billingFetch } = {}) {
    const ctx = {
      get(name) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };
        if (name === 'credentials') return {
          async resolve(reference) {
            references.push(reference);
            return configured ? { value: FAKE_KEY, source: 'fixture' } : undefined;
          },
        };
        return undefined;
      },
    };
    const host = await createBillingHost({
      ctx, dataDir, now: () => clock.value, onChange, warn,
      config: {
        apiKeyEnv: 'BILLING_TEST_FAKE_KEY',
        billingFetch: billingFetch ?? (async (url, options = {}) => {
          const address = new URL(url);
          assert.equal(address.origin, 'https://api.deepseek.com');
          assert.equal(address.pathname, '/user/balance');
          assert.equal((options.method ?? 'GET').toUpperCase(), 'GET');
          const headers = new Headers(options.headers);
          assert.equal(headers.get('Authorization'), `Bearer ${FAKE_KEY}`);
          requests.push({ url: address.href, method: options.method ?? 'GET' });
          return new Response(JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: account.currency, total_balance: account.total, granted_balance: '0.00', topped_up_balance: account.total }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }),
      },
    });
    hosts.push(host);
    return host;
  }
  return { dataDir, clock, account, requests, references, open };
}

test('host aggregates multiple steps, uses cache-disjoint DSH inputs once and ignores replayed requests', async t => {
  const f = await fixture(t);
  const host = await f.open();
  await host.refresh();
  assert.equal(host.snapshot().balance.status, 'ready');
  const s = session('multi-step');
  const events = [start(), assistant(1, 1, 1, usageA), assistant(2, 1, 2, usageB), end(3)];
  for (const value of events) await host.observe(s, value);
  for (const value of events) await host.observe(s, value);
  await host.flush();
  const state = host.snapshot();
  assert.equal(state.scope, 'dsh-observed');
  assert.equal(state.daily.requests, 2);
  assert.equal(state.daily.inputTokens, 160);
  assert.equal(state.daily.outputTokens, 60);
  assert.equal(state.daily.totalTokens, 220);
  assert.equal(state.summaries.length, 1);
  assert.equal(state.lastTask.requests, 2);
  assert.equal(state.lastTask.totalTokens, 220);
  assert.equal(state.lastTask.costs[0].currency, 'USD');
  assert.equal(state.lastTask.costs[0].estimated, true);
  assert.ok(Number(state.lastTask.costs[0].amount) > 0);
  assert.ok(f.requests.length >= 1);
  const disk = await readFile(join(f.dataDir, 'billing.json'), 'utf8');
  assert.equal(disk.includes(FAKE_KEY), false, 'Credentials must never be persisted with usage');
});

test('ledger and completion notifications remain idempotent after an actual disk restart', async t => {
  const f = await fixture(t);
  const first = await f.open();
  const s = session('restart');
  const events = [start(), assistant(1, 1, 1, usageA), end(2)];
  for (const value of events) await first.observe(s, value);
  await first.flush();
  const prior = first.snapshot();
  await first.dispose();
  const second = await f.open();
  for (const value of events) await second.observe(s, value);
  await second.flush();
  const state = second.snapshot();
  assert.equal(state.daily.requests, 1);
  assert.equal(state.daily.totalTokens, 170);
  assert.equal(state.summaries.length, 1);
  assert.equal(state.lastTask.seq, prior.lastTask.seq);
  assert.equal(state.lastTask.endedAt, prior.lastTask.endedAt);
});

test('concurrent sessions with equal turn numbers keep separate per-task receipts', async t => {
  const f = await fixture(t);
  const host = await f.open();
  await host.refresh();
  const a = session('concurrent-a');
  const b = session('concurrent-b');
  await Promise.all([host.observe(a, start()), host.observe(b, start())]);
  await Promise.all([host.observe(a, assistant(1, 1, 1, usageA)), host.observe(b, assistant(1, 1, 1, usageB))]);
  f.clock.value += 6_000;
  await Promise.all([host.observe(a, end(2)), host.observe(b, end(2))]);
  const state = host.snapshot();
  assert.equal(state.daily.totalTokens, 220);
  assert.equal(state.summaries.length, 2);
  assert.equal(new Set(state.summaries.map(value => value.seq)).size, 2);
  assert.equal(state.summaries.find(value => value.id.includes('concurrent-a')).totalTokens, 170);
  assert.equal(state.summaries.find(value => value.id.includes('concurrent-b')).totalTokens, 50);
  assert.equal(state.summaries.every(value => value.requests === 1), true);
});

test('compaction is separately billed and inherited fork history is not billed a second time', async t => {
  const f = await fixture(t);
  const host = await f.open();
  const s = { ...session('fork-child'), inheritedEventCount: 5, firstLiveSeq: 10 };
  await host.observe(s, assistant(4, 1, 1, usageA));
  assert.equal(host.snapshot().daily.requests, 0);
  await host.observe(s, start(5));
  await host.observe(s, assistant(6, 1, 1, usageA));
  await host.observe(s, event(7, 'compaction/summary', {
    compactionId: 'fixture-compaction', provider: 'deepseek-official', model: 'deepseek-flash', usage: usageB,
  }));
  await host.observe(s, end(8));
  assert.equal(host.snapshot().daily.requests, 2);
  assert.equal(host.snapshot().daily.totalTokens, 220);
  assert.equal(host.snapshot().lastTask.requests, 2);
  assert.equal(host.snapshot().lastTask.totalTokens, 220);
});

test('explicit assistant turn numbers still identify a task when the plugin missed its start event', async t => {
  const f = await fixture(t);
  const host = await f.open();
  const s = session('already-running');
  await host.observe(s, assistant(12, 3, 1, usageA));
  await host.observe(s, end(13, 3));
  assert.equal(host.snapshot().daily.requests, 1);
  assert.equal(host.snapshot().lastTask.requests, 1);
  assert.equal(host.snapshot().lastTask.totalTokens, 170);
});

test('unknown models, missing usage and tasks without responses do not become zero-cost receipts', async t => {
  const f = await fixture(t);
  const host = await f.open({ configured: false });
  const unknown = session('unknown-model');
  await host.observe(unknown, start());
  await host.observe(unknown, assistant(1, 1, 1, usageA, { model: 'unpriced-model' }));
  await host.observe(unknown, end(2));
  assert.equal(host.snapshot().lastTask.totalTokens, 170);
  assert.equal(host.snapshot().lastTask.unknownCostRequests, 1);
  assert.equal(host.snapshot().lastTask.costs.every(value => value.amount === null), true);
  const missing = session('missing-usage');
  await host.observe(missing, start());
  await host.observe(missing, assistant(1, 1, 1, undefined));
  await host.observe(missing, end(2));
  assert.equal(host.snapshot().lastTask.totalTokens, null);
  assert.equal(host.snapshot().lastTask.unknownCostRequests, 1);
  const noUsage = session('no-response');
  await host.observe(noUsage, start());
  await host.observe(noUsage, end(1));
  assert.equal(host.snapshot().lastTask.requests, 0);
  assert.equal(host.snapshot().lastTask.totalTokens, null);
  assert.equal(host.snapshot().lastTask.unknownCostRequests, 1);
  assert.equal(f.requests.length, 0);
});

test('task costs never come from balance differences and each receipt preserves its balance snapshot', async t => {
  const f = await fixture(t);
  const host = await f.open();
  await host.refresh();
  const s = session('balance-change');
  await host.observe(s, start());
  await host.observe(s, assistant(1, 1, 1, usageA));
  f.account.total = '7.00';
  f.clock.value += 6_000;
  await host.observe(s, end(2));
  const receipt = host.snapshot().lastTask;
  assert.equal(Number(receipt.balance.accounts[0].totalBalance), 7);
  assert.ok(Number(receipt.costs[0].amount) < 1);
  assert.notEqual(Number(receipt.costs[0].amount), 3);
  f.account.total = '4.00';
  f.clock.value += 6_000;
  await host.refresh();
  assert.equal(Number(host.snapshot().balance.accounts[0].totalBalance), 4);
  assert.equal(Number(host.snapshot().lastTask.balance.accounts[0].totalBalance), 7);
});

test('cross-midnight host observations split daily usage and preserve the full task receipt', async t => {
  const f = await fixture(t);
  const before = new Date(2026, 9, 8, 23, 59, 50).getTime();
  const after = new Date(2026, 9, 9, 0, 0, 10).getTime();
  f.clock.value = before;
  const host = await f.open({ configured: false });
  const s = session('midnight');
  await host.observe(s, start(0, 1, before));
  const first = assistant(1, 1, 1, usageA); first.time = before;
  await host.observe(s, first);
  assert.equal(host.snapshot().daily.date, '2026-10-08');
  assert.equal(host.snapshot().daily.totalTokens, 170);
  f.clock.value = after;
  const second = assistant(2, 1, 2, usageB); second.time = after;
  await host.observe(s, second);
  await host.observe(s, end(3, 1, after));
  assert.equal(host.snapshot().daily.date, '2026-10-09');
  assert.equal(host.snapshot().daily.totalTokens, 50);
  assert.equal(host.snapshot().lastTask.totalTokens, 220);
});

test('corrupt billing state is preserved and rejected before any credential or network access', async t => {
  const f = await fixture(t);
  const source = '{broken ledger';
  const path = join(f.dataDir, 'billing.json');
  await writeFile(path, source);
  await assert.rejects(createBillingHost({
    dataDir: f.dataDir,
    ctx: { get() { assert.fail('Corrupt billing state must fail before credential access'); } },
    config: { billingFetch() { assert.fail('Corrupt billing state must fail before network calls'); } },
  }), /invalid JSON.*preserve/i);
  assert.equal(await readFile(path, 'utf8'), source);
});

test('DSH cache-read and cache-write counts are separate inputs rather than double-counted totals', () => {
  assert.deepEqual(normalizeDSHUsage({ inputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 4, outputTokens: 1, totalTokens: 10 }), {
    inputTokens: 9, outputTokens: 1, cacheHitTokens: 2, cacheMissTokens: 7, totalTokens: 10,
  });
  assert.equal(normalizeDSHUsage({ inputTokens: -1, outputTokens: 1 }).inputTokens, null);
  assert.equal(normalizeDSHUsage(undefined).inputTokens, undefined);
});

test('failed attempts are separately billed, use only their last cumulative usage chunk and deduplicate on replay', async t => {
  const f = await fixture(t);
  const host = await f.open();
  await host.refresh();
  const s = routedSession('retried-model-request');
  const failed = attempt(1, 1, 1, [{ inputTokens: 10, outputTokens: 2 }, usageA]);
  // A success carries its own settled stream; it is one response rather than
  // an additional request for every usage chunk embedded in that stream.
  const succeeded = assistant(2, 1, 1, usageB);
  succeeded.data.stream = [{ type: 'chunk', time: initialTime, chunk: { type: 'usage', usage: usageB } }];
  const values = [start(), failed, succeeded, end(3)];
  for (const value of values) await host.observe(s, value);
  for (const value of values) await host.observe(s, value);
  const state = host.snapshot();
  assert.equal(state.daily.requests, 2);
  assert.equal(state.daily.inputTokens, 160);
  assert.equal(state.daily.outputTokens, 60);
  assert.equal(state.daily.totalTokens, 220);
  assert.equal(state.daily.unknownCostRequests, 0);
  assert.equal(state.lastTask.requests, 2);
  assert.equal(state.lastTask.totalTokens, 220);
  assert.equal(state.summaries.length, 1);
  assert.equal(state.lastTask.costs[0].currency, 'USD');
  assert.ok(Number(state.lastTask.costs[0].amount) > 0);
  await host.flush();
  await host.dispose();
  const restored = await f.open();
  await restored.observe(s, failed);
  assert.equal(restored.snapshot().daily.requests, 2);
  assert.equal(restored.snapshot().daily.totalTokens, 220);
});

test('an attempt without reported usage leaves the eventual successful task explicitly incomplete', async t => {
  const f = await fixture(t);
  const host = await f.open({ configured: false });
  const s = routedSession('retry-without-usage');
  await host.observe(s, start());
  await host.observe(s, attempt(1, 1, 1, []));
  await host.observe(s, assistant(2, 1, 1, usageB));
  await host.observe(s, end(3));
  const state = host.snapshot();
  assert.equal(state.daily.requests, 2);
  assert.equal(state.daily.totalTokens, null);
  assert.equal(state.daily.unknownCostRequests, 1);
  assert.equal(state.lastTask.unknownCostRequests, 1);
  assert.equal(state.lastTask.costs.every(value => value.amount === null), true);
});

test('historical attempts keep reported tokens but never borrow a newer live request route for pricing', async t => {
  const f = await fixture(t);
  const host = await f.open({ configured: false });
  const s = {
    ...session('replayed-history'), firstLiveSeq: 10,
    requestHeader() { assert.fail('A historical attempt must not consult the current live header'); },
    requestContext() { assert.fail('A historical attempt must not consult the current live context'); },
  };
  await host.observe(s, start(4));
  await host.observe(s, attempt(5, 1, 1, [usageA]));
  await host.observe(s, end(6));
  const state = host.snapshot();
  assert.equal(state.daily.requests, 1);
  assert.equal(state.daily.totalTokens, 170);
  assert.equal(state.daily.unknownCostRequests, 1);
  assert.equal(state.lastTask.totalTokens, 170);
  assert.equal(state.lastTask.unknownCostRequests, 1);
  assert.equal(state.lastTask.costs.every(value => value.amount === null), true);
});

test('parseable corrupted pending, active and lifecycle state is rejected before credentials or balances are queried', async t => {
  const f = await fixture(t);
  const path = join(f.dataDir, 'billing.json');
  const base = {
    version: 1, ledger: new BillingLedger().exportState(), active: [], lifecycleSeq: [], pending: [], summaries: [], reportSeq: 0,
  };
  const corruptions = [
    { pending: [['invalid-pending-key', null]] },
    { active: [['invalid-turn', null]] },
    { lifecycleSeq: [['invalid-sequence', -1]] },
  ];
  for (const corruption of corruptions) {
    const source = JSON.stringify({ ...base, ...corruption });
    await writeFile(path, source);
    await assert.rejects(createBillingHost({
      dataDir: f.dataDir,
      ctx: { get() { assert.fail('Corrupt billing state must fail before credential access'); } },
      config: { billingFetch() { assert.fail('Corrupt billing state must fail before a balance query'); } },
    }), /Invalid .*billing.*preserve/i);
    assert.equal(await readFile(path, 'utf8'), source, 'The rejected state must remain available for recovery');
  }
});

test('an interrupted completion is rebuilt once from persisted ledger data without repricing its recorded costs', async t => {
  const f = await fixture(t);
  const ledger = new BillingLedger({ now: () => initialTime });
  ledger.recordUsage({
    sessionId: 'interrupted-receipt', eventSeq: 1, turnId: 1, at: initialTime,
    provider: 'deepseek-official', model: 'deepseek-flash',
    usage: { inputTokens: 120, cacheHitTokens: 20, outputTokens: 50 },
    reportedCost: { amount: '0.123456789', currency: 'CNY' },
  });
  const completed = ledger.completeTask({ sessionId: 'interrupted-receipt', turnId: 1, at: initialTime }).task;
  const path = join(f.dataDir, 'billing.json');
  await writeFile(path, JSON.stringify({
    version: 1, ledger: ledger.exportState(), active: [], lifecycleSeq: [['interrupted-receipt', 2]],
    // The ledger is authoritative; a stale cached pending receipt must not
    // dictate its token totals or monetary amount on recovery.
    pending: [[completed.key, { ...completed, tokens: { totalTokens: 999999 }, costs: [{ currency: 'USD', amountDecimal: '9999' }] }]],
    reportSeq: 0, summaries: [],
  }));
  const host = await f.open();
  await host.flush();
  const recovered = host.snapshot();
  assert.equal(recovered.summaries.length, 1);
  assert.equal(recovered.lastTask.seq, 1);
  assert.equal(recovered.lastTask.requests, 1);
  assert.equal(recovered.lastTask.inputTokens, 120);
  assert.equal(recovered.lastTask.totalTokens, 170);
  assert.equal(recovered.lastTask.costs[0].currency, 'CNY');
  assert.equal(recovered.lastTask.costs[0].amount, '0.123456789');
  assert.equal(recovered.lastTask.costs[0].estimated, true);
  assert.equal(recovered.lastTask.balance.accounts[0].currency, 'USD');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.pending, []);
  assert.equal(saved.reportSeq, 1);
  await host.dispose();
  const restarted = await f.open();
  await restarted.flush();
  await restarted.observe(session('interrupted-receipt'), assistant(1, 1, 1, usageA));
  await restarted.observe(session('interrupted-receipt'), end(2));
  assert.equal(restarted.snapshot().summaries.length, 1);
  assert.equal(restarted.snapshot().lastTask.seq, 1);
  assert.equal(restarted.snapshot().daily.requests, 1);
  assert.equal(restarted.snapshot().lastTask.costs[0].amount, '0.123456789');
});
