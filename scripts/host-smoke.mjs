/** Real Cordis activation smoke. Uses a stub HTTP service and temporary state only. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../lib/index.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/host-smoke.mjs [--cordis <Cordis package directory or entry file>]');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--cordis')) {
  throw new Error('Expected --cordis <package directory or entry file>');
}

function cordisEntry(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    return statSync(path).isDirectory() ? require.resolve(path) : path;
  }
  try { return require.resolve('@deepseek-ai/cordis'); } catch {}
  // Resolve through the installed CLI's dependency closure rather than installing
  // a second Cordis copy or importing any of the user's profile plugins.
  const roots = new Set([
    ...String(process.env.PATH ?? '').split(delimiter),
    ...String(process.env.NODE_PATH ?? '').split(delimiter),
    dirname(process.execPath),
  ].filter(Boolean));
  for (const root of roots) {
    for (const anchor of [
      join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(root, '@deepseek-ai', 'dsh', 'package.json'),
    ]) {
      if (!existsSync(anchor)) continue;
      try { return createRequire(anchor).resolve('@deepseek-ai/cordis'); } catch {}
    }
  }
  throw new Error('Cordis was not found. Pass --cordis <installed Cordis package directory>.');
}

const entry = cordisEntry(args[1]);
const { Context } = await import(pathToFileURL(entry).href);
const temporary = await mkdtemp(join(tmpdir(), 'whale-cordis-smoke-'));
const routes = new Map();
const jobListeners = new Set();
const ctx = new Context();
const port = 43891; // Stub only: no socket is opened by this smoke test.
ctx.provide('webServer', {
  port,
  register(route) {
    assert.equal(route.kind, 'exact');
    assert.ok(!routes.has(route.path), `Duplicate route: ${route.path}`);
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  },
});
ctx.provide('jobs', {
  list: () => [],
  events: {
    subscribe(filter, listener) {
      assert.deepEqual(filter, { owners: 'all' });
      jobListeners.add(listener);
      return () => jobListeners.delete(listener);
    },
  },
});
const fixtureKey = 'cordis-smoke-fixture-not-a-real-key';
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) });
ctx.provide('credentials', { resolve: async () => ({ value: fixtureKey, source: 'test' }) });

async function snapshot() {
  let status;
  let body;
  await routes.get('/whale-companion/state').handler({
    method: 'GET', url: '/whale-companion/state',
    headers: { host: `127.0.0.1:${port}` },
  }, {
    writeHead(value) { status = value; },
    end(value) { body = value; },
  });
  assert.equal(status, 200);
  return JSON.parse(body);
}

let fiber;
try {
  fiber = await ctx.plugin(plugin, { dataDir: temporary, billingFetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, `Bearer ${fixtureKey}`);
    return new Response(JSON.stringify({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: '42.50', granted_balance: '0', topped_up_balance: '42.50' },
    ] }));
  } });
  assert.deepEqual([...routes.keys()].sort(), [
    '/whale-companion/billing/state',
    '/whale-companion/billing/refresh',
    '/whale-companion/events', '/whale-companion/interact',
    '/whale-companion/pet.css', '/whale-companion/pet.html',
    '/whale-companion/pet.js', '/whale-companion/presence',
    ...['idle','think','working','wait','celebrate','error','eat','joy','drag'].map(state => `/whale-companion/sprites/${state}.png`),
    ...['maid-short','maid-long','evening'].map(portrait => `/whale-companion/portraits/${portrait}.png`),
    '/whale-companion/state',
  ].sort());
  const connection = JSON.parse(await readFile(join(temporary, 'connection.json'), 'utf8'));
  assert.equal(connection.url, `http://127.0.0.1:${port}`);
  assert.equal((await snapshot()).activity.name, 'idle');
  const session = { id: 'isolated-smoke-session' };
  ctx.emit('session/event', session, { type: 'turn/start', seq: 0, data: { turn: 1 } });
  assert.equal((await snapshot()).activity.name, 'thinking');
  ctx.emit('session/event', session, { type: 'assistant/message', seq: 1, time: Date.now(), data: {
    turn: 1, usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
    message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
  } });
  ctx.emit('session/event', session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal((await snapshot()).activity.name, 'celebrate');
  let billing;
  for (let attempt = 0; attempt < 50; attempt++) {
    billing = (await snapshot()).billing;
    if (billing.lastTask) break;
    await delay(20);
  }
  assert.equal(billing.balance.status, 'ready');
  assert.equal(billing.balance.accounts[0].totalBalance, '42.5');
  assert.equal(billing.lastTask.totalTokens, 1700);
  assert.equal(billing.lastTask.requests, 1);
  assert.ok(!JSON.stringify(billing).includes(fixtureKey));
  assert.equal(jobListeners.size, 1, 'The optional modern jobs service must activate');
  for (const listener of jobListeners) listener({ type: 'registered', job: { id: 'smoke-job', startedAt: 1, status: 'running' } });
  assert.equal((await snapshot()).activity.name, 'working');
  for (const listener of jobListeners) listener({ type: 'settled', cause: 'producer', job: { id: 'smoke-job', startedAt: 1, status: 'completed' } });
  assert.equal((await snapshot()).activity.name, 'celebrate');
  await fiber.dispose();
  assert.equal(routes.size, 0, 'Disposal must withdraw every route');
  assert.equal(jobListeners.size, 0, 'Disposal must withdraw the optional jobs listener');
  assert.equal(existsSync(join(temporary, 'connection.json')), false);
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version; } catch {}
  console.log(`PASS: Cordis ${version} activated the real plugin, observed session/job events, and cleaned up all routes, listeners, and discovery state.`);
  console.log(`Cordis entry: ${entry}`);
} finally {
  if (fiber) await fiber.dispose();
  await ctx.fiber.dispose();
  await rm(temporary, { recursive: true, force: true });
}
