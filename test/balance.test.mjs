import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekBalanceService, OFFICIAL_BALANCE_URL } from '../lib/deepseek-balance.mjs';

const payload = (total = '12.3400') => ({ is_available: true, balance_infos: [
  { currency: 'CNY', total_balance: total, granted_balance: '2.34', topped_up_balance: '10' },
] });
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function setup({ provider = 'deepseek-official', route = {}, credentials, services = {}, config = {}, fetchImpl, now, onChange, getProvider } = {}) {
  let selected = provider;
  const capabilities = {
    agentDefaultModel: { currentSelection: () => ({ provider: selected, model: 'deepseek-v4-flash' }) },
    llm: { listConfigurableProviders: () => [{ provider: selected, settingsNs: 'official-route', settingsPath: [] }] },
    settings: { describe: options => {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: 'official-route', value: route }];
    } },
    launchEnvironment: { get: () => ({ value: 'https://api.deepseek.com/anthropic' }) },
    credentials: credentials ?? { resolve: async () => ({ value: 'test-key-only', source: 'file' }) },
    ...services,
  };
  const listeners = new Map();
  const ctx = {
    get: key => capabilities[key],
    on: (name, listener) => {
      const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group);
      return () => { group.delete(listener); if (!group.size) listeners.delete(name); };
    },
  };
  return { service: createDeepSeekBalanceService({ ctx, config,
    fetchImpl: fetchImpl ?? (async () => response(payload())), now, onChange, getProvider }),
    select: value => { selected = value; }, listeners,
    emit: (name, value) => { for (const listener of listeners.get(name) ?? []) listener(value); } };
}

test('official request uses host reference, fixed HTTPS URL, bounded timeout and no redirects', async () => {
  let reference, request;
  const { service } = setup({ route: { apiKeyEnv: 'CUSTOM_DEEPSEEK_KEY' },
    credentials: { resolve: async ref => { reference = ref; return { value: 'private-test-secret', source: 'file' }; } },
    fetchImpl: async (url, options) => { request = { url, options }; return response(payload()); } });
  const result = await service.refresh();
  assert.equal(reference, 'CUSTOM_DEEPSEEK_KEY');
  assert.equal(request.url, OFFICIAL_BALANCE_URL);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer private-test-secret');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.accounts, [{ currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.34', toppedUpBalance: '10' }]);
  assert.doesNotMatch(JSON.stringify(result), /private-test-secret|CUSTOM_DEEPSEEK_KEY/);
  result.accounts[0].totalBalance = 'changed';
  assert.equal(service.snapshot().accounts[0].totalBalance, '12.34');
  service.dispose();
});

test('API key is resolved again for each operation and explicit legal reference wins', async () => {
  const seen = [];
  let reads = 0;
  const { service } = setup({ config: { apiKeyEnv: 'EXPLICIT_KEY' }, route: { apiKeyEnv: 'OTHER_KEY' },
    credentials: { resolve: async ref => { assert.equal(ref, 'EXPLICIT_KEY'); return { value: `rotated-${++reads}` }; } },
    fetchImpl: async (_url, options) => { seen.push(options.headers.Authorization); return response(payload()); } });
  await service.refresh(); await service.refresh();
  assert.deepEqual(seen, ['Bearer rotated-1', 'Bearer rotated-2']);
  service.dispose();
});

test('concurrent refreshes merge and manual requests have a five second minimum', async () => {
  let time = 10_000, calls = 0, finish;
  const { service } = setup({ now: () => time, fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = service.refresh({ manual: true });
  const merged = service.refresh({ manual: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(service.snapshot().status, 'loading');
  finish(response(payload())); await Promise.all([first, merged]);
  time += 4_999;
  await service.refresh({ manual: true }); assert.equal(calls, 1);
  time += 1;
  const next = service.refresh({ manual: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish(response(payload('13'))); await next;
  service.dispose();
});

test('missing key is unconfigured and host exceptions never expose their secrets', async () => {
  let calls = 0;
  const empty = setup({ credentials: { resolve: async () => undefined }, fetchImpl: async () => { calls++; } }).service;
  assert.equal((await empty.refresh()).status, 'unconfigured'); assert.equal(calls, 0); empty.dispose();
  const broken = setup({ credentials: { resolve: async () => { throw new Error('SENSITIVE-KEY'); } } }).service;
  const result = await broken.refresh();
  assert.equal(result.status, 'error'); assert.doesNotMatch(JSON.stringify(result), /SENSITIVE-KEY/); broken.dispose();
});

test('authentication failure keeps a previous same-route balance as stale', async () => {
  let calls = 0, time = 1_000;
  const { service } = setup({ now: () => time, fetchImpl: async () => ++calls === 1 ? response(payload()) :
    new Response('SENSITIVE-KEY internal details', { status: 401 }) });
  await service.refresh(); time = 2_000;
  const result = await service.refresh();
  assert.equal(result.status, 'stale'); assert.equal(result.updatedAt, 1_000);
  assert.equal(result.accounts[0].totalBalance, '12.34');
  assert.match(result.error, /验证失败/); assert.doesNotMatch(JSON.stringify(result), /SENSITIVE-KEY|internal details/);
  service.dispose();
});

test('HTTP and parsing errors return a safe Chinese error without raw responses', async () => {
  for (const supplied of [new Response('SENSITIVE-KEY', { status: 429 }), new Response('SENSITIVE-KEY', { status: 500 }),
    new Response('SENSITIVE-KEY'), response({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'bad' }] })]) {
    const { service } = setup({ fetchImpl: async () => supplied });
    const result = await service.refresh(); assert.equal(result.status, 'error');
    assert.doesNotMatch(JSON.stringify(result), /SENSITIVE-KEY|total_balance|bad/); service.dispose();
  }
});

test('response cap rejects declared and streaming bodies larger than 64 KiB', async () => {
  for (const supplied of [new Response('{}', { headers: { 'content-length': '65537' } }), new Response(' '.repeat(65_537))]) {
    const { service } = setup({ fetchImpl: async () => supplied });
    const result = await service.refresh(); assert.equal(result.status, 'error'); assert.match(result.error, /过大/); service.dispose();
  }
});

test('eight second deadline bounds credential resolution as well as HTTP', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { service } = setup({ credentials: { resolve: () => new Promise(() => {}) } });
  const operation = service.refresh();
  await Promise.resolve(); context.mock.timers.tick(8_000);
  const result = await operation;
  assert.equal(result.status, 'error'); assert.match(result.error, /超时/); service.dispose();
});

test('account login uses sanitized host wallet service and exact decimal aggregation', async () => {
  let client, keyReads = 0, httpCalls = 0;
  const { service } = setup({ provider: 'deepseek-account', credentials: { resolve: async () => { keyReads++; } },
    services: { deepseekAccount: { getBalance: async identity => { client = identity; return {
      status: 'ready', value: [{ currency: 'CNY', balance: '0.1' }, { currency: 'CNY', balance: '0.2' }, { currency: 'USD', balance: '3e-2' }],
      bonusWallets: [{ currency: 'CNY', balance: '.00000001' }, { currency: 'USD', balance: '0.07' }],
    }; } } }, fetchImpl: async () => { httpCalls++; } });
  const result = await service.refresh();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.accounts, [
    { currency: 'CNY', totalBalance: '0.30000001', toppedUpBalance: '0.3', grantedBalance: '0.00000001' },
    { currency: 'USD', totalBalance: '0.1', toppedUpBalance: '0.03', grantedBalance: '0.07' },
  ]);
  assert.equal(client.version, '0.3.0'); assert.equal(client.locale, 'zh-CN');
  assert.ok(Number.isFinite(client.timezoneOffsetSeconds)); assert.equal(keyReads, 0); assert.equal(httpCalls, 0);
  service.dispose();
});

test('signed out accounts are unconfigured and failed accounts are never zero', async () => {
  for (const [value, status] of [[null, 'unconfigured'], [{ status: 'failed' }, 'error']]) {
    const { service } = setup({ provider: 'deepseek-account', services: { deepseekAccount: { getBalance: async () => value } } });
    const result = await service.refresh(); assert.equal(result.status, status); assert.deepEqual(result.accounts, []); service.dispose();
  }
});

test('current default provider wins over background session provider and account changes hide old balances', async () => {
  let accountCalls = 0;
  const { service, select } = setup({ getProvider: () => 'deepseek-account', services: { deepseekAccount: { getBalance: async () => { accountCalls++; } } } });
  await service.refresh(); assert.equal(accountCalls, 0);
  select('other-provider');
  assert.equal(service.snapshot().status, 'unconfigured'); assert.deepEqual(service.snapshot().accounts, []);
  await service.refresh(); assert.equal(accountCalls, 0); service.dispose();
});

test('unsupported provider, custom endpoint and malformed references never resolve a key', async () => {
  for (const options of [{ provider: 'deepseek' }, { provider: 'openai' }, { route: { baseURL: 'https://third-party.invalid' } },
    { route: { baseURL: 'http://api.deepseek.com' } }, { route: { baseURL: 'https://api.deepseek.com@third-party.invalid' } },
    { config: { apiKeyEnv: '../key' } }]) {
    let reads = 0;
    const { service } = setup({ ...options, credentials: { resolve: async () => { reads++; } } });
    const result = await service.refresh(); assert.equal(result.status, 'unconfigured'); assert.equal(reads, 0);
    assert.equal(service.acceptsOfficialProvider(options.provider ?? 'deepseek-official'), false); service.dispose();
  }
});

test('provider switches during an operation cannot publish the previous account', async () => {
  let finish;
  const { service, select } = setup({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const operation = service.refresh(); await new Promise(resolve => setImmediate(resolve));
  select('other-provider'); finish(response(payload()));
  const result = await operation; assert.equal(result.status, 'unconfigured'); assert.deepEqual(result.accounts, []);
  service.dispose();
});

test('dispose cancels pending requests and notification exceptions stay contained', async () => {
  const changes = [];
  const { service } = setup({ credentials: { resolve: () => new Promise(() => {}) }, onChange: state => { changes.push(state.status); throw new Error('observer'); } });
  const operation = service.refresh(); service.dispose();
  const result = await operation; assert.equal(result.status, 'unconfigured'); assert.deepEqual(result.accounts, []);
  assert.ok(changes.includes('loading'));
});


test('updating the selected API key immediately clears old balances and removes manual throttle', async () => {
  let calls = 0;
  const { service, emit, listeners } = setup({ fetchImpl: async () => response(payload(String(++calls))) });
  await service.refresh({ manual: true });
  emit('credentials/reference-updated', 'UNRELATED_KEY');
  assert.equal(service.snapshot().status, 'ready');
  emit('credentials/reference-updated', 'DEEPSEEK_API_KEY');
  assert.equal(service.snapshot().status, 'unconfigured');
  assert.deepEqual(service.snapshot().accounts, []); assert.equal(service.snapshot().updatedAt, null);
  await service.refresh({ manual: true });
  assert.equal(calls, 2); assert.equal(service.snapshot().accounts[0].totalBalance, '2');
  service.dispose(); assert.equal(listeners.size, 0);
});

test('credential updates abort in-flight responses so a former account cannot republish', async () => {
  let finish, signal;
  const { service, emit } = setup({ fetchImpl: (_url, options) => {
    signal = options.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const operation = service.refresh(); await new Promise(resolve => setImmediate(resolve));
  emit('credentials/reference-updated', 'DEEPSEEK_API_KEY');
  assert.equal(signal.aborted, true);
  finish(response(payload('999')));
  const result = await operation;
  assert.equal(result.status, 'unconfigured'); assert.deepEqual(result.accounts, []);
  service.dispose();
});

test('account sign-out and grant changes clear old wallets, while device records do not', async () => {
  const { service, emit, listeners } = setup({ provider: 'deepseek-account', services: { deepseekAccount: {
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '8' }], bonusWallets: [] }),
  } } });
  await service.refresh();
  emit('credentials/record-updated', 'deepseek-account-platform/device');
  assert.equal(service.snapshot().status, 'ready');
  emit('deepseek-account/signed-out');
  assert.equal(service.snapshot().status, 'unconfigured'); assert.deepEqual(service.snapshot().accounts, []);
  await service.refresh();
  emit('credentials/record-updated', 'deepseek-account-platform/default');
  assert.equal(service.snapshot().status, 'unconfigured'); assert.deepEqual(service.snapshot().accounts, []);
  service.dispose(); assert.equal(listeners.size, 0);
});


test('account wallets remain queryable independently of custom model routing and API key references', async () => {
  let calls = 0;
  const { service } = setup({ provider: 'deepseek-account', route: { baseURL: 'https://model-proxy.invalid' },
    config: { apiKeyEnv: '../irrelevant-to-account' }, services: { deepseekAccount: { getBalance: async () => {
      calls++; return { status: 'ready', value: [{ currency: 'CNY', balance: '9' }], bonusWallets: [] };
    } } } });
  assert.equal((await service.refresh()).status, 'ready'); assert.equal(calls, 1);
  assert.equal(service.acceptsOfficialProvider('deepseek-account'), false, 'Custom model routes must still not use official prices');
  service.dispose();
});
