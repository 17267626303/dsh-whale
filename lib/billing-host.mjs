import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BillingLedger } from './billing-core.mjs';
import { createDeepSeekBalanceService } from './deepseek-balance.mjs';
import { officialRates, PRICE_AS_OF } from './deepseek-pricing.mjs';

/** Only final host usage events enter the ledger; credentials never enter it. */
export async function createBillingHost({ ctx = {}, config = {}, dataDir, now = Date.now, onChange = () => {}, warn = () => {} }) {
  const path = join(dataDir, 'billing.json');
  const saved = await load(path);
  const active = new Map(saved?.active ?? []);
  const lifecycleSeq = new Map(saved?.lifecycleSeq ?? []);
  const pending = new Map(saved?.pending ?? []);
  let summaries = saved?.summaries ?? [];
  let reportSeq = saved?.reportSeq ?? 0;
  let disposed = false;
  let saves = Promise.resolve();
  let lastProvider;
  const runningReports = new Map();
  const notify = () => { if (!disposed) onChange(); };
  let balance;
  const ledger = new BillingLedger({ state: saved?.ledger, now, rates: context => {
    if (!balance.acceptsOfficialProvider(context.provider)) return null;
    const currency = balance.snapshot().accounts[0]?.currency ?? 'CNY';
    return officialRates(context, currency);
  } });
  // Rebuild interrupted reports from validated ledger records, never trust a
  // partially edited pending receipt enough to query credentials on its behalf.
  for (const [key, task] of pending) {
    let restored;
    try { restored = task && ledger.getTask(task); } catch {}
    if (!restored || restored.key !== key || restored.completedAt === null) {
      throw new Error('Invalid pending billing task; preserve the file before restarting');
    }
    pending.set(key, restored);
  }
  for (const [id, turn] of active) {
    if (typeof id !== 'string' || !id || validTurn(turn) === null) throw new Error('Invalid active billing task; preserve the file before restarting');
  }
  for (const [id, seq] of lifecycleSeq) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid billing lifecycle record; preserve the file before restarting');
  }
  balance = createDeepSeekBalanceService({ ctx, config, getProvider: () => lastProvider, fetchImpl: config.billingFetch ?? globalThis.fetch, now, onChange: notify });
  const save = () => {
    const state = JSON.stringify({ version: 1, ledger: ledger.exportState(), active: [...active], lifecycleSeq: [...lifecycleSeq], pending: [...pending], reportSeq, summaries }) + '\n';
    saves = saves.catch(() => {}).then(() => atomicWrite(path, state));
    // Event callbacks cannot surface a rejected disk write to the host emitter.
    saves.catch(() => warn('用量记录保存失败，请检查桌宠数据目录是否可写。'));
    return saves;
  };
  const snapshot = () => {
    const state = ledger.snapshot();
    return { scope: 'dsh-observed', priceAsOf: PRICE_AS_OF, balance: balance.snapshot(), daily: {
      date: state.day, ...view(state.today),
    }, lastTask: structuredClone(summaries.at(-1) ?? null), summaries: structuredClone(summaries) };
  };
  const report = (key, task) => {
    if (runningReports.has(key)) return runningReports.get(key);
    const promise = (async () => {
      await balance.refresh();
      if (disposed) return;
      const summary = { id: key, seq: ++reportSeq, endedAt: task.completedAt, ...view(task), balance: balance.snapshot() };
      summaries = [...summaries, summary].slice(-20);
      pending.delete(key);
      await save();
      notify();
    })().finally(() => runningReports.delete(key));
    runningReports.set(key, promise);
    return promise;
  };
  const observe = async (session, event) => {
    if (disposed || typeof session?.id !== 'string' || !session.id || !event || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
    // Forked sessions carry a parent log prefix; it was paid for by the parent.
    if (Number.isSafeInteger(session.inheritedEventCount) && event.seq < session.inheritedEventCount) return;
    const { type, data = {} } = event;
    const at = eventTime(event, now);
    const id = session.id;
    if (type === 'turn/start' || type === 'turn/end') {
      if (event.seq <= (lifecycleSeq.get(id) ?? -1)) return;
      lifecycleSeq.set(id, event.seq);
      const turn = validTurn(data.turn);
      if (turn === null) return;
      if (type === 'turn/start') {
        active.set(id, turn);
        await save();
        return;
      }
      if (active.has(id) && active.get(id) !== turn) { await save(); return; }
      active.delete(id);
      const result = ledger.completeTask({ sessionId: id, turnId: turn, at, status: data.reason?.kind ?? 'completed' });
      if (!result.completed) { await save(); return; }
      pending.set(result.task.key, result.task);
      await save();
      return report(result.task.key, result.task);
    }
    if (!['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(type)) return;
    // Missing usage is recorded as unknown, so it cannot make a paid task look free.
    const source = type === 'assistant/message' ? data.message?.source : type === 'assistant/attempt' ? attemptRoute(session, event) : data;
    if (type === 'assistant/message' && source?.kind !== 'model') return;
    const provider = typeof source?.provider === 'string' ? source.provider : undefined;
    const model = typeof source?.model === 'string' ? source.model : undefined;
    if (provider) lastProvider = provider;
    const turnId = type.startsWith('assistant/') ? validTurn(data.turn) ?? active.get(id) : active.get(id);
    // A failed/retried attempt is a separate request. Its final cumulative usage
    // chunk may be absent; preserve that uncertainty instead of calling it free.
    const rawUsage = type === 'assistant/attempt' ? lastAttemptUsage(data.stream) : data.usage;
    const result = ledger.recordUsage({ sessionId: id, eventSeq: event.seq, turnId, at, provider, model, usage: normalizeDSHUsage(rawUsage) });
    if (result.changed) { await save(); notify(); }
  };
  // Recover a completion interrupted between ledger persistence and balance refresh.
  queueMicrotask(() => {
    if (disposed) return;
    if (pending.size) {
      for (const [key, task] of pending) report(key, task).catch(() => warn('任务用量通知保存失败。'));
    } else balance.refresh().catch(() => warn('余额暂时无法刷新。'));
  });
  const refreshTimer = setInterval(() => { if (!disposed) balance.refresh().catch(() => {}); }, 60_000);
  refreshTimer.unref();
  return {
    snapshot, observe,
    async refresh({ manual = true } = {}) { await balance.refresh({ manual }); return snapshot(); },
    async flush() {
      // A turn/end listener may still be waiting for its first durable write.
      for (;;) {
        const latest = saves;
        await latest;
        await Promise.all([...runningReports.values()]);
        if (latest === saves && runningReports.size === 0) break;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(refreshTimer);
      balance.dispose();
      await Promise.allSettled([...runningReports.values()]);
      await saves.catch(() => {});
    },
  };
}

export function normalizeDSHUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const read = token(usage.cacheReadTokens ?? 0);
  const write = token(usage.cacheWriteTokens ?? 0);
  const input = token(usage.inputTokens);
  const output = token(usage.outputTokens);
  const inclusive = sum(input, read, write);
  return { inputTokens: inclusive, outputTokens: output, cacheHitTokens: read,
    cacheMissTokens: sum(input, write), totalTokens: sum(inclusive, output) };
}
function token(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function sum(...values) { const value = values.reduce((a, b) => a + b, 0); return values.includes(null) || !Number.isSafeInteger(value) ? null : value; }
function validTurn(value) { return Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && value.trim() ? value : null; }
function attemptRoute(session, event) {
  // A replay's current header may describe a different provider/model.
  if (Number.isSafeInteger(session.firstLiveSeq) && event.seq < session.firstLiveSeq) return {};
  try {
    const context = session.requestContext?.();
    const config = session.requestHeader?.()?.config;
    return { provider: context?.provider ?? config?.provider, model: context?.model ?? config?.model };
  } catch { return {}; }
}
function lastAttemptUsage(stream) {
  if (!Array.isArray(stream)) return;
  for (let i = stream.length - 1; i >= 0; i--) {
    if (stream[i]?.type === 'chunk' && stream[i].chunk?.type === 'usage') return stream[i].chunk.usage;
  }
}
function eventTime(event, now) {
  const value = event.time ?? event.timestamp;
  const at = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isSafeInteger(at) && at >= 0 && !Number.isNaN(new Date(at).getTime()) ? at : now();
}
function view(aggregate) {
  const emptyTask = aggregate.completedAt !== undefined && aggregate.requests === 0;
  return { inputTokens: emptyTask ? null : aggregate.tokens.inputTokens, outputTokens: emptyTask ? null : aggregate.tokens.outputTokens,
    totalTokens: emptyTask ? null : aggregate.tokens.totalTokens, knownTotalTokens: aggregate.tokens.knownTotalTokens,
    unknownTokenRequests: emptyTask ? 1 : aggregate.tokens.unknownRequests, requests: aggregate.requests,
    costs: aggregate.costs.filter(cost => cost.currency !== null).map(cost => ({
      currency: cost.currency, amount: cost.amountDecimal, knownAmount: cost.knownAmountDecimal ?? '0', estimated: cost.estimatedRequests > 0,
    })), unknownCostRequests: emptyTask ? 1 : aggregate.unknownCostRequests };
}
async function load(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Billing state exceeds 32 MiB; preserve the file before restarting');
  let state;
  try { state = JSON.parse(text); } catch { throw new Error('Billing state is invalid JSON; preserve the file before restarting'); }
  if (state?.version !== 1 || !state.ledger || !Number.isSafeInteger(state.reportSeq) || state.reportSeq < 0
    || !Array.isArray(state.active) || !Array.isArray(state.lifecycleSeq) || !Array.isArray(state.pending)
    || !Array.isArray(state.summaries) || state.summaries.length > 20) throw new Error('Unsupported billing state; preserve the file before restarting');
  return state;
}
async function atomicWrite(path, text) {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
