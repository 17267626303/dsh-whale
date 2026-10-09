/** Read-only balances; credentials stay in the host and never enter a snapshot. */
export const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;
const MANUAL_INTERVAL_MS = 5_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURRENCIES = new Set(['CNY', 'USD']);

class BalanceFailure extends Error {
  constructor(message, unconfigured = false) { super(message); this.unconfigured = unconfigured; }
}
const unconfigured = error => ({ status: 'unconfigured', accounts: [], updatedAt: null, error });
const copy = value => structuredClone(value);

/**
 * API-key routes query the fixed official endpoint. Account-login routes use
 * the host's sanitized account service, without extracting its login grant.
 */
export function createDeepSeekBalanceService({ ctx, config = {}, getProvider,
  fetchImpl = globalThis.fetch, now = Date.now, onChange } = {}) {
  let state = unconfigured('尚未查询余额');
  let stateTarget;
  let pending;
  let disposed = false;
  const listeners = [];
  const lastStarted = new Map();
  const notify = () => { try { onChange?.(snapshot()); } catch {} };
  const service = name => typeof ctx?.get === 'function' ? ctx.get(name) : undefined;

  function selection() {
    try {
      const current = service('agentDefaultModel')?.currentSelection?.();
      if (current?.provider) return current.provider;
      const fallback = typeof getProvider === 'function' ? getProvider() : undefined;
      return typeof fallback === 'string' ? fallback : fallback?.provider;
    } catch { return undefined; }
  }

  function target(provider = selection(), verifyRoute = false) {
    // Wallet lookup is owned by the account service, independently of model routing.
    if (provider === 'deepseek-account' && !verifyRoute) return { provider, key: provider };
    if (!['deepseek-official', 'deepseek-account'].includes(provider)) throw new BalanceFailure('当前模型不是 DeepSeek 官方账户，余额暂不可用');
    let providerConfig;
    try {
      const directory = service('llm')?.listConfigurableProviders?.();
      const route = directory?.find(entry => entry.provider === provider);
      if (route) {
        const rows = service('settings')?.describe?.({ redactSecrets: true });
        providerConfig = rows?.find(row => row.ns === route.settingsNs)?.value;
        for (const part of route.settingsPath ?? []) providerConfig = providerConfig?.[part];
      }
    } catch { throw new BalanceFailure('无法读取当前模型的安全配置，余额暂不可用'); }
    const ref = config.apiKeyEnv ?? providerConfig?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    if (provider === 'deepseek-official' && (typeof ref !== 'string' || !ENV_NAME.test(ref))) throw new BalanceFailure('API Key 引用名称无效');
    let ambientBase;
    try { ambientBase = service('launchEnvironment')?.get?.('DEEPSEEK_BASE_URL')?.value; }
    catch { throw new BalanceFailure('无法确认官方接口配置，余额暂不可用'); }
    const base = providerConfig?.baseURL ?? ambientBase ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port ||
          url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new BalanceFailure('当前模型使用自定义接口，无法查询官方余额'); }
    return provider === 'deepseek-account' ? { provider, key: provider } : { provider, ref, key: `${provider}:${ref}` };
  }

  function snapshot() {
    if (disposed) return copy(state);
    try {
      const selected = target();
      if (stateTarget && selected.key !== stateTarget) return unconfigured('账户已切换，请刷新余额');
    } catch (error) { return unconfigured(safeMessage(error)); }
    return copy(state);
  }

  async function query(selected, signal) {
    if (selected.provider === 'deepseek-account') {
      const account = service('deepseekAccount');
      if (typeof account?.getBalance !== 'function') throw new BalanceFailure('当前客户端未提供账户余额服务', true);
      const client = config.clientIdentity ?? {
        version: '0.3.0', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
      const result = await abortable(Promise.resolve().then(() => account.getBalance(client)), signal);
      if (result === null) throw new BalanceFailure('请先在 DeepSeek 客户端登录账户', true);
      if (result?.status !== 'ready') throw new BalanceFailure('账户余额查询失败，请稍后重试');
      return accountBalances(result);
    }
    const credentials = service('credentials');
    if (typeof credentials?.resolve !== 'function') throw new BalanceFailure('客户端未提供凭据服务，请在模型设置中配置 API Key', true);
    const credential = await abortable(Promise.resolve().then(() => credentials.resolve(selected.ref)), signal);
    const key = credential?.value;
    if (typeof key !== 'string' || key.length === 0) throw new BalanceFailure('请在 DeepSeek 模型设置中配置 API Key', true);
    if (key.length > 4_096 || /[^\x21-\x7e]/u.test(key)) throw new BalanceFailure('已配置的 API Key 格式无效');
    let response;
    try {
      response = await abortable(Promise.resolve().then(() => fetchImpl(OFFICIAL_BALANCE_URL, {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        redirect: 'error', signal,
      })), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BalanceFailure('无法连接 DeepSeek 官方余额接口，请稍后重试');
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch?.(() => {});
      if (response.status === 401 || response.status === 403) throw new BalanceFailure('API Key 验证失败，请检查 DeepSeek 模型设置');
      if (response.status === 429) throw new BalanceFailure('余额查询过于频繁，请稍后重试');
      throw new BalanceFailure('DeepSeek 官方余额查询失败，请稍后重试');
    }
    const text = await boundedBody(response, signal);
    let body;
    try { body = JSON.parse(text); } catch { throw new BalanceFailure('官方余额响应格式异常'); }
    if (typeof body?.is_available !== 'boolean' || !Array.isArray(body.balance_infos) ||
        body.balance_infos.length === 0 || body.balance_infos.length > 8) throw new BalanceFailure('官方余额响应格式异常');
    const seen = new Set();
    return body.balance_infos.map(item => {
      if (!item || !CURRENCIES.has(item.currency) || seen.has(item.currency)) throw new BalanceFailure('官方余额响应格式异常');
      seen.add(item.currency);
      return { currency: item.currency, totalBalance: decimal(item.total_balance),
        grantedBalance: decimal(item.granted_balance), toppedUpBalance: decimal(item.topped_up_balance) };
    });
  }

  async function refresh({ manual = false } = {}) {
    if (disposed) return snapshot();
    let selected;
    try { selected = target(); }
    catch (error) {
      pending?.controller.abort();
      pending = undefined;
      stateTarget = undefined;
      state = unconfigured(safeMessage(error));
      notify();
      return snapshot();
    }
    if (pending?.key === selected.key) return pending.promise;
    if (pending) { pending.controller.abort(); pending = undefined; }
    const at = now();
    if (manual && at - (lastStarted.get(selected.key) ?? -Infinity) < MANUAL_INTERVAL_MS) return snapshot();
    lastStarted.set(selected.key, at);
    const previous = stateTarget === selected.key && state.accounts.length ? copy(state) : null;
    stateTarget = selected.key;
    state = { status: 'loading', accounts: previous?.accounts ?? [], updatedAt: previous?.updatedAt ?? null, error: null };
    notify();
    const controller = new AbortController();
    const operation = { key: selected.key, controller };
    pending = operation;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    operation.promise = (async () => {
      try {
        const accounts = await query(selected, controller.signal);
        if (!disposed && pending === operation) state = { status: 'ready', accounts, updatedAt: now(), error: null };
      } catch (error) {
        if (!disposed && pending === operation) {
          const errorText = controller.signal.aborted ? '余额查询超时，请稍后重试' : safeMessage(error);
          state = previous ? { status: 'stale', accounts: previous.accounts, updatedAt: previous.updatedAt, error: errorText }
            : { status: error?.unconfigured ? 'unconfigured' : 'error', accounts: [], updatedAt: null, error: errorText };
        }
      } finally {
        clearTimeout(timer);
        if (pending === operation) { pending = undefined; notify(); }
      }
      return snapshot();
    })();
    return operation.promise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const stop of listeners.splice(0)) stop();
    pending?.controller.abort();
    pending = undefined;
    state = unconfigured('余额服务已停止');
  }
  function invalidateIdentity() {
    if (disposed) return;
    pending?.controller.abort();
    pending = undefined;
    stateTarget = undefined;
    state = unconfigured('账户凭据已变化，请刷新余额');
    lastStarted.clear();
    notify();
  }
  if (typeof ctx?.on === 'function') {
    const listen = (event, callback) => {
      const stop = ctx.on(event, callback);
      if (typeof stop === 'function') listeners.push(stop);
    };
    listen('credentials/reference-updated', ref => {
      let selected;
      try { selected = target(); } catch { return; }
      if (selected.provider === 'deepseek-official' && typeof ref === 'string' &&
          (process.platform === 'win32' ? ref.toUpperCase() === selected.ref.toUpperCase() : ref === selected.ref)) invalidateIdentity();
    });
    // The account provider owns this grant record; the device record is unrelated.
    listen('credentials/record-updated', key => {
      if (key === 'deepseek-account-platform/default' && selection() === 'deepseek-account') invalidateIdentity();
    });
    listen('deepseek-account/signed-out', () => {
      if (selection() === 'deepseek-account' || stateTarget === 'deepseek-account') invalidateIdentity();
    });
  }
  function acceptsOfficialProvider(provider) {
    try { return Boolean(target(provider, true)); } catch { return false; }
  }
  return { snapshot, refresh, dispose, acceptsOfficialProvider };
}

function safeMessage(error) {
  return error instanceof BalanceFailure ? error.message : '余额查询失败，请稍后重试';
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let aborted;
  const interruption = new Promise((_, reject) => {
    aborted = () => reject(new Error('aborted'));
    signal.addEventListener('abort', aborted, { once: true });
  });
  try { return await Promise.race([promise, interruption]); }
  finally { signal.removeEventListener('abort', aborted); }
}

async function boundedBody(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    void response.body?.cancel?.().catch?.(() => {});
    throw new BalanceFailure('官方余额响应过大');
  }
  if (!response.body?.getReader) throw new BalanceFailure('官方余额响应格式异常');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new BalanceFailure('官方余额响应过大');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** Canonical exact decimal string; avoid binary float rounding in wallet sums. */
function decimal(value) {
  if (typeof value !== 'string' || value.length > 160) throw new BalanceFailure('官方余额响应格式异常');
  const match = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/iu.exec(value);
  if (!match) throw new BalanceFailure('官方余额响应格式异常');
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 80) throw new BalanceFailure('官方余额响应格式异常');
  const whole = match[2] ?? '0', fraction = match[3] ?? match[4] ?? '';
  const scale = fraction.length - exponent;
  let digits = (whole + fraction).replace(/^0+(?=\d)/u, '');
  if (scale < 0) digits += '0'.repeat(-scale);
  if (scale > 0) digits = digits.padStart(scale + 1, '0');
  let result = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  result = result.replace(/^0+(?=\d)/u, '').replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
  return result === '0' ? '0' : match[1] + result;
}

function sumDecimals(values) {
  const normalized = values.map(decimal);
  const scale = Math.max(0, ...normalized.map(value => value.split('.')[1]?.length ?? 0));
  const total = normalized.reduce((sum, value) => {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const units = BigInt(whole + fraction.padEnd(scale, '0'));
    return sum + (negative ? -units : units);
  }, 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  return decimal((negative ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

function accountBalances(result) {
  if (!Array.isArray(result.value) || !Array.isArray(result.bonusWallets) ||
      result.value.length + result.bonusWallets.length > 64) throw new BalanceFailure('账户余额响应格式异常');
  const wallets = new Map();
  for (const [field, list] of [['normal', result.value], ['bonus', result.bonusWallets]]) {
    for (const item of list) {
      if (!item || !CURRENCIES.has(item.currency)) throw new BalanceFailure('账户余额响应格式异常');
      const entry = wallets.get(item.currency) ?? { normal: [], bonus: [] };
      entry[field].push(decimal(item.balance));
      wallets.set(item.currency, entry);
    }
  }
  if (!wallets.size) throw new BalanceFailure('账户暂未返回余额');
  return [...wallets].map(([currency, wallet]) => {
    const toppedUpBalance = sumDecimals(wallet.normal), grantedBalance = sumDecimals(wallet.bonus);
    return { currency, totalBalance: sumDecimals([toppedUpBalance, grantedBalance]), grantedBalance, toppedUpBalance };
  });
}
