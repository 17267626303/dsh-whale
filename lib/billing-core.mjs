/**
 * A local ledger of observed DSH model usage. This module never reads credentials,
 * calls a model, infers spend from balance changes, or mixes currency totals.
 *
 * Canonical inputTokens INCLUDES cache hits. Host adapters must normalize the
 * provider/DSH's native usage convention before calling recordUsage().
 * Costs retain exact decimal strings; numeric amounts are convenient UI views.
 */
export class BillingLedger {
  constructor({ state, now = Date.now, rates = [] } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof rates !== 'function' && !Array.isArray(rates)) throw new TypeError('rates must be an array or resolver function');
    this.now = now;
    this.rates = rates;
    this.records = new Map();
    this.aliases = new Map();
    this.tasks = new Map();
    if (state !== undefined) this.restore(state);
  }

  /**
   * Record one final model response, not cumulative stream snapshots.
   * eventSeq/requestId identities are scoped to a session and persisted.
   * reportedCost(s) needs currency; only providerBilled:true is an actual bill.
   */
  recordUsage(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Usage record is required');
    const sessionId = identifier(input.sessionId, 'sessionId');
    const aliases = requestAliases(sessionId, input);
    const matches = new Set(aliases.map(alias => this.aliases.get(alias)).filter(Boolean));
    if (matches.size > 1) throw new Error('Usage identities refer to different existing requests');
    if (matches.size === 1) {
      const record = this.records.get([...matches][0]);
      let changed = false;
      for (const alias of aliases) {
        if (!this.aliases.has(alias)) {
          this.aliases.set(alias, record.id);
          record.aliases.push(alias);
          changed = true;
        }
      }
      return { added: false, changed, record: copy(record) };
    }
    const at = timestamp(input.at ?? this.now());
    const usage = normalizeUsage(input.usage ?? {});
    const provider = optionalIdentifier(input.provider);
    const model = optionalIdentifier(input.model);
    const identity = taskIdentity({ ...input, sessionId }, false);
    const record = {
      id: aliases[0], aliases, sessionId,
      eventSeq: input.eventSeq ?? null,
      requestId: input.requestId === undefined || input.requestId === null ? null : identifier(input.requestId, 'requestId'),
      taskKey: identity?.key ?? null,
      turnId: identity?.turnId ?? null,
      taskId: identity?.taskId ?? null,
      at, day: localDay(at), provider, model, usage,
      costs: calculateCosts(input, { provider, model, at, usage }, this.rates),
    };
    this.records.set(record.id, record);
    for (const alias of aliases) this.aliases.set(alias, record.id);
    if (identity) {
      const task = this.ensureTask(identity, at);
      task.startedAt = Math.min(task.startedAt, at);
    }
    return { added: true, changed: true, record: copy(record) };
  }

  /** One terminal notice per task, including after a saved ledger is reopened. */
  completeTask(input) {
    const identity = taskIdentity(input, true);
    const at = timestamp(input.at ?? this.now());
    const task = this.ensureTask(identity, at);
    const completed = task.completedAt === null;
    if (completed) {
      task.completedAt = at;
      task.completionDay = localDay(at);
      task.status = optionalIdentifier(input.status) ?? 'completed';
    }
    return { completed, task: this.taskSummary(task) };
  }

  getTask(input) {
    const identity = taskIdentity(input, true);
    const task = this.tasks.get(identity.key);
    return task ? this.taskSummary(task) : null;
  }

  snapshot({ day = localDay(this.now()) } = {}) {
    validDay(day);
    const records = [...this.records.values()];
    const today = aggregate(records.filter(record => record.day === day));
    today.completedTasks = [...this.tasks.values()].filter(task => task.completionDay === day).length;
    const tasks = [...this.tasks.values()]
      .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt) || a.key.localeCompare(b.key))
      .map(task => this.taskSummary(task));
    return {
      scope: 'dsh-observed', day, today, tasks,
      lastTask: tasks.find(task => task.completedAt !== null) ?? null,
    };
  }

  /** JSON-safe state. Persist this outside the install directory atomically. */
  exportState() {
    return copy({ version: 1, scope: 'dsh-observed', records: [...this.records.values()], tasks: [...this.tasks.values()] });
  }

  ensureTask(identity, at) {
    if (!this.tasks.has(identity.key)) {
      this.tasks.set(identity.key, {
        ...identity, startedAt: at, completedAt: null, completionDay: null, status: 'running',
      });
    }
    return this.tasks.get(identity.key);
  }

  taskSummary(task) {
    const records = [...this.records.values()].filter(record => record.taskKey === task.key);
    const summary = aggregate(records);
    if (!records.length) {
      // No observed model response does not establish that a task was free.
      summary.costs = [{
        ...unknownCost(null, 'no-usage-observed'),
        knownAmount: 0, knownAmountDecimal: '0',
        unknownRequests: 0, estimatedRequests: 0, reportedRequests: 0,
      }];
    }
    return { ...copy(task), day: task.completionDay ?? localDay(task.startedAt), ...summary };
  }

  restore(state) {
    if (!state || state.version !== 1 || state.scope !== 'dsh-observed'
      || !Array.isArray(state.records) || !Array.isArray(state.tasks)) {
      throw new Error('Unsupported billing ledger state');
    }
    for (const saved of state.records) {
      const record = restoreRecord(saved);
      if (this.records.has(record.id)) throw new Error('Duplicate request in billing ledger state');
      for (const alias of record.aliases) {
        if (this.aliases.has(alias)) throw new Error('Duplicate usage identity in billing ledger state');
        this.aliases.set(alias, record.id);
      }
      this.records.set(record.id, record);
    }
    for (const saved of state.tasks) {
      const identity = taskIdentity(saved, true);
      if (saved.key !== identity.key || this.tasks.has(identity.key)) throw new Error('Invalid task identity in billing ledger state');
      const task = {
        ...identity, startedAt: timestamp(saved.startedAt),
        completedAt: saved.completedAt === null ? null : timestamp(saved.completedAt),
        completionDay: saved.completionDay,
        status: identifier(saved.status, 'task status'),
      };
      if (task.completedAt === null) {
        if (task.completionDay !== null) throw new Error('Unexpected completion day for running task');
      } else validDay(task.completionDay);
      this.tasks.set(identity.key, task);
    }
    for (const record of this.records.values()) {
      if (record.taskKey !== null && !this.tasks.has(record.taskKey)) throw new Error('Usage references a missing task');
    }
  }
}

/** Machine-local calendar day; never derive a user's local day from UTC slicing. */
export function localDay(at = Date.now()) {
  const date = new Date(timestamp(at));
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeUsage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('usage must be an object');
  const inputTokens = token(input.inputTokens);
  const outputTokens = token(input.outputTokens);
  let cacheHitTokens = token(input.cacheHitTokens);
  let cacheMissTokens = token(input.cacheMissTokens);
  const issues = [];
  if (inputTokens !== null) {
    if (cacheHitTokens !== null && cacheHitTokens > inputTokens
      || cacheMissTokens !== null && cacheMissTokens > inputTokens
      || cacheHitTokens !== null && cacheMissTokens !== null && cacheHitTokens + cacheMissTokens !== inputTokens) {
      issues.push('inconsistent-cache-partition');
      cacheHitTokens = null;
      cacheMissTokens = null;
    } else if (cacheHitTokens !== null && cacheMissTokens === null) cacheMissTokens = inputTokens - cacheHitTokens;
    else if (cacheMissTokens !== null && cacheHitTokens === null) cacheHitTokens = inputTokens - cacheMissTokens;
    else if (inputTokens === 0) { cacheHitTokens = 0; cacheMissTokens = 0; }
  }
  const derivedTotal = inputTokens === null || outputTokens === null ? null : addTokens(inputTokens, outputTokens);
  const reportedTotal = token(input.totalTokens);
  if (derivedTotal !== null && reportedTotal !== null && derivedTotal !== reportedTotal) issues.push('inconsistent-reported-total');
  return {
    inputTokens, outputTokens,
    totalTokens: derivedTotal ?? reportedTotal,
    cacheHitTokens, cacheMissTokens,
    issues,
  };
}

function calculateCosts(input, context, rates) {
  const reported = input.reportedCosts ?? (input.reportedCost ? [input.reportedCost] : []);
  if (!Array.isArray(reported)) throw new TypeError('reportedCosts must be an array');
  const valid = [];
  for (const cost of reported) {
    if (!cost || cost.amount === undefined || cost.amount === null || !validCurrency(cost.currency)) continue;
    const amountDecimal = decimalString(decimal(cost.amount));
    valid.push({
      currency: cost.currency.toUpperCase(), amount: Number(amountDecimal), amountDecimal,
      source: cost.providerBilled === true ? 'reported' : 'estimated',
      provenance: cost.providerBilled === true ? 'provider-billed' : 'host-reported',
      sourceUrl: optionalIdentifier(cost.sourceUrl), asOf: optionalIdentifier(cost.asOf), reason: null,
    });
  }
  if (valid.length) return uniqueCurrencies(valid);
  const resolved = typeof rates === 'function' ? rates(copy(context)) : rates.filter(rate => rateMatches(rate, context));
  if (resolved && typeof resolved.then === 'function') throw new TypeError('rates resolver must be synchronous');
  const candidates = resolved === null || resolved === undefined ? [] : Array.isArray(resolved) ? resolved : [resolved];
  if (!candidates.length) return [unknownCost(null, 'no-verified-rate')];
  return uniqueCurrencies(candidates.map(rate => estimateCost(rate, context)));
}

function estimateCost(rate, { usage }) {
  if (!validCurrency(rate?.currency)) throw new TypeError('Verified rate currency is required');
  const currency = rate.currency.toUpperCase();
  const common = { sourceUrl: optionalIdentifier(rate.sourceUrl), asOf: optionalIdentifier(rate.asOf) };
  if (rate.inputPerMillion === undefined || rate.inputPerMillion === null
    || rate.outputPerMillion === undefined || rate.outputPerMillion === null) {
    return { ...unknownCost(currency, 'incomplete-rate'), ...common };
  }
  const missRate = decimal(rate.inputPerMillion);
  const outputRate = decimal(rate.outputPerMillion);
  const hitRate = rate.cacheHitPerMillion === undefined || rate.cacheHitPerMillion === null ? null : decimal(rate.cacheHitPerMillion);
  if (usage.inputTokens === null || usage.outputTokens === null) return { ...unknownCost(currency, 'incomplete-token-counts'), ...common };
  let hit = usage.cacheHitTokens;
  let miss = usage.cacheMissTokens;
  if (usage.issues.includes('inconsistent-cache-partition')) return { ...unknownCost(currency, 'inconsistent-cache-partition'), ...common };
  if (hit === null || miss === null) {
    if (hitRate === null || decimalString(hitRate) !== decimalString(missRate)) return { ...unknownCost(currency, 'incomplete-cache-partition'), ...common };
    hit = 0;
    miss = usage.inputTokens;
  }
  if (hit > 0 && hitRate === null) return { ...unknownCost(currency, 'incomplete-cache-rate'), ...common };
  const exact = addDecimals(addDecimals(perMillion(missRate, miss), hit === 0 ? zero() : perMillion(hitRate, hit)), perMillion(outputRate, usage.outputTokens));
  const amountDecimal = decimalString(exact);
  return {
    currency, amount: Number(amountDecimal), amountDecimal,
    source: 'estimated', provenance: 'official-rate-estimate', reason: null, ...common,
  };
}

function aggregate(records) {
  const tokens = {};
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens']) {
    const known = records.filter(record => record.usage[field] !== null);
    const sum = known.reduce((total, record) => addTokens(total, record.usage[field]), 0);
    tokens[field] = known.length === records.length ? sum : null;
    if (['inputTokens', 'outputTokens', 'totalTokens'].includes(field)) tokens[`known${field[0].toUpperCase()}${field.slice(1)}`] = sum;
  }
  tokens.unknownRequests = records.filter(record => record.usage.inputTokens === null || record.usage.outputTokens === null).length;
  const currencies = [...new Set(records.flatMap(record => record.costs.map(cost => cost.currency)))].sort((a, b) => String(a).localeCompare(String(b)));
  const unpriced = records.filter(record => record.costs.some(cost => cost.currency === null && cost.amountDecimal === null));
  const costs = currencies.map(currency => {
    const entries = records.flatMap(record => record.costs.filter(cost => cost.currency === currency));
    const unknown = entries.filter(cost => cost.amountDecimal === null).length + (currency === null ? 0 : unpriced.length);
    const known = entries.filter(cost => cost.amountDecimal !== null);
    const exact = known.reduce((total, cost) => addDecimals(total, decimal(cost.amountDecimal)), zero());
    const knownAmountDecimal = decimalString(exact);
    const estimated = known.filter(cost => cost.source === 'estimated').length;
    const reported = known.filter(cost => cost.source === 'reported').length;
    return {
      currency,
      amount: unknown ? null : Number(knownAmountDecimal),
      amountDecimal: unknown ? null : knownAmountDecimal,
      knownAmount: Number(knownAmountDecimal), knownAmountDecimal,
      source: unknown ? 'unknown' : estimated && reported ? 'mixed' : estimated ? 'estimated' : reported ? 'reported' : 'none',
      unknownRequests: unknown, estimatedRequests: estimated, reportedRequests: reported,
    };
  });
  return {
    requests: records.length, tokens, costs,
    unknownCostRequests: records.filter(record => record.costs.some(cost => cost.amountDecimal === null)).length,
  };
}

function unknownCost(currency, reason) {
  return {
    currency, amount: null, amountDecimal: null, source: 'unknown',
    provenance: 'unknown', sourceUrl: null, asOf: null, reason,
  };
}

function restoreRecord(saved) {
  if (!saved || !Array.isArray(saved.aliases) || !saved.aliases.length || !Array.isArray(saved.costs) || !saved.costs.length) throw new Error('Invalid usage record in billing ledger state');
  const sessionId = identifier(saved.sessionId, 'sessionId');
  const expected = requestAliases(sessionId, saved);
  const aliases = saved.aliases.map(alias => identifier(alias, 'usage alias'));
  if (!expected.every(alias => aliases.includes(alias)) || new Set(aliases).size !== aliases.length || aliases[0] !== saved.id
    || !aliases.every(alias => validPersistedAlias(alias, sessionId))) throw new Error('Invalid persisted usage aliases');
  const identity = taskIdentity(saved, false);
  if ((identity?.key ?? null) !== saved.taskKey) throw new Error('Invalid persisted usage task identity');
  const usage = normalizeUsage(saved.usage);
  if (Array.isArray(saved.usage.issues)) usage.issues = [...new Set([...usage.issues, ...saved.usage.issues.map(issue => identifier(issue, 'usage issue'))])];
  const costs = uniqueCurrencies(saved.costs.map(cost => {
    const currency = cost.currency === null ? null : validCurrency(cost.currency) ? cost.currency.toUpperCase() : null;
    if (cost.currency !== null && currency === null) throw new Error('Invalid persisted cost currency');
    if (cost.amountDecimal === null) return { ...unknownCost(currency, optionalIdentifier(cost.reason) ?? 'unknown'), sourceUrl: optionalIdentifier(cost.sourceUrl), asOf: optionalIdentifier(cost.asOf) };
    if (!['reported', 'estimated'].includes(cost.source) || currency === null) throw new Error('Invalid persisted cost source');
    const amountDecimal = decimalString(decimal(cost.amountDecimal));
    return {
      currency, amount: Number(amountDecimal), amountDecimal, source: cost.source,
      provenance: identifier(cost.provenance, 'cost provenance'),
      sourceUrl: optionalIdentifier(cost.sourceUrl), asOf: optionalIdentifier(cost.asOf), reason: null,
    };
  }));
  validDay(saved.day);
  return {
    id: identifier(saved.id, 'record id'), aliases, sessionId,
    eventSeq: saved.eventSeq, requestId: saved.requestId,
    taskKey: saved.taskKey, turnId: identity?.turnId ?? null, taskId: identity?.taskId ?? null,
    at: timestamp(saved.at), day: saved.day,
    provider: optionalIdentifier(saved.provider), model: optionalIdentifier(saved.model), usage, costs,
  };
}

function taskIdentity(input, required) {
  if (!input || typeof input !== 'object') throw new TypeError('Task identity is required');
  const sessionId = identifier(input.sessionId, 'sessionId');
  const taskId = input.taskId === undefined || input.taskId === null ? null : identifier(input.taskId, 'taskId');
  const turnId = input.turnId === undefined || input.turnId === null ? null
    : typeof input.turnId === 'number' ? token(input.turnId) : identifier(input.turnId, 'turnId');
  if (taskId === null && turnId === null) {
    if (required) throw new TypeError('taskId or turnId is required');
    return null;
  }
  return { key: JSON.stringify(['task', sessionId, taskId !== null ? 'id' : 'turn', taskId ?? String(turnId)]), sessionId, turnId, taskId };
}

function requestAliases(sessionId, input) {
  const aliases = [];
  if (input.eventSeq !== undefined && input.eventSeq !== null) {
    const seq = token(input.eventSeq);
    aliases.push(JSON.stringify(['event', sessionId, seq]));
  }
  if (input.requestId !== undefined && input.requestId !== null) aliases.push(JSON.stringify(['request', sessionId, identifier(input.requestId, 'requestId')]));
  if (!aliases.length) throw new TypeError('eventSeq or requestId is required for persistent deduplication');
  return aliases;
}

function validPersistedAlias(alias, sessionId) {
  let parts;
  try { parts = JSON.parse(alias); } catch { return false; }
  return Array.isArray(parts) && parts.length === 3 && parts[1] === sessionId
    && JSON.stringify(parts) === alias && (parts[0] === 'event'
      ? Number.isSafeInteger(parts[2]) && parts[2] >= 0
      : parts[0] === 'request' && typeof parts[2] === 'string' && parts[2].trim() === parts[2] && parts[2].length > 0);
}

function rateMatches(rate, context) {
  return rate && rate.provider === context.provider && (rate.model === context.model || rate.aliases?.includes(context.model));
}

function uniqueCurrencies(costs) {
  if (new Set(costs.map(cost => cost.currency)).size !== costs.length) throw new Error('Duplicate currency cost/rate for one request');
  return costs;
}

function token(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Token counts and sequence numbers must be non-negative safe integers');
  return value;
}

function addTokens(a, b) {
  const total = a + b;
  if (!Number.isSafeInteger(total)) throw new RangeError('Token total exceeds the safe integer range');
  return total;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalIdentifier(value) {
  return value === undefined || value === null ? null : identifier(value, 'identifier');
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Number.isNaN(new Date(value).getTime())) throw new TypeError('Timestamp must be a valid non-negative epoch millisecond integer');
  return value;
}

function validCurrency(value) {
  return typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value);
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('Day must be YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new TypeError('Invalid calendar day');
}

function zero() { return { coefficient: 0n, scale: 0 }; }

function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Amount/rate must be a non-negative decimal');
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new TypeError('Amount/rate must be a non-negative finite decimal');
  const raw = String(value).trim();
  const source = raw.startsWith('.') ? `0${raw}` : raw.startsWith('+.') ? `+0${raw.slice(1)}` : raw;
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new TypeError('Amount/rate must be a non-negative decimal');
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 18 || match[1].length + (match[2]?.length ?? 0) > 40) throw new RangeError('Amount/rate precision is outside supported bounds');
  let coefficient = BigInt(match[1] + (match[2] ?? ''));
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return normalizedDecimal({ coefficient, scale });
}

function normalizedDecimal({ coefficient, scale }) {
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return { coefficient, scale };
}

function addDecimals(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return normalizedDecimal({
    coefficient: a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale), scale,
  });
}

function perMillion(rate, tokens) {
  return normalizedDecimal({ coefficient: rate.coefficient * BigInt(tokens), scale: rate.scale + 6 });
}

function decimalString({ coefficient, scale }) {
  if (scale === 0) return String(coefficient);
  const digits = String(coefficient).padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function copy(value) { return structuredClone(value); }
