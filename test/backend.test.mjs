import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost as apply, apply as applyPlugin } from '../lib/index.mjs';
import { PetCore } from '../lib/pet-core.mjs';

function event(core, sessionId, seq, type, data) {
  core.sessionEvent({ id: sessionId }, { seq, type, data });
  return core.snapshot().activity.name;
}

test('task, tool and approval lifecycle only observes DSH and expires completion', () => {
  let now = 1_000;
  const core = new PetCore({ now: () => now });
  assert.equal(event(core, 'a', 0, 'turn/start', { turn: 1 }), 'thinking');
  assert.equal(event(core, 'a', 1, 'tool/call', { callId: 'tool-1' }), 'working');
  assert.equal(event(core, 'a', 2, 'approval/asked', { id: 'approve-1' }), 'waiting');
  assert.equal(event(core, 'a', 3, 'approval/decided', { id: 'approve-1', outcome: 'deny' }), 'working');
  assert.equal(event(core, 'a', 4, 'tool/result', {
    message: { role: 'user', source: { kind: 'tool', callId: 'tool-1' }, content: [{ type: 'tool-result', toolCallId: 'tool-1', content: [] }] },
  }), 'thinking');
  assert.equal(event(core, 'a', 5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'celebrate');
  const seq = core.snapshot().activity.seq;
  now += 7_000;
  assert.equal(core.snapshot().activity.name, 'idle');
  assert.equal(event(core, 'a', 5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'idle');
  assert.equal(core.snapshot().activity.seq, seq + 1);
});

test('concurrent sessions and jobs stay busy when another task finishes', () => {
  const core = new PetCore();
  event(core, 'a', 0, 'turn/start', { turn: 1 });
  event(core, 'b', 0, 'turn/start', { turn: 1 });
  assert.equal(event(core, 'a', 1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'thinking');
  core.jobsChanged({ session: { id: 'b' } }, [{ id: 'bash-1', status: 'running' }]);
  assert.equal(core.snapshot().activity.name, 'working');
  event(core, 'b', 1, 'turn/end', { turn: 1, reason: { kind: 'error' } });
  assert.equal(core.snapshot().activity.name, 'working');
  core.jobDone({ id: 'bash-1', startedAt: 1, status: 'failed' });
  assert.equal(core.snapshot().activity.name, 'error');
  const seq = core.snapshot().activity.seq;
  core.jobDone({ id: 'bash-1', startedAt: 1, status: 'completed' });
  assert.equal(core.snapshot().activity.seq, seq);
});

test('a stale turn close cannot stop a newer turn; disposal clears active state', () => {
  const core = new PetCore();
  event(core, 'a', 0, 'turn/start', { turn: 2 });
  assert.equal(event(core, 'a', 1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'thinking');
  core.sessionDisposed({ id: 'a' });
  assert.equal(core.snapshot().activity.name, 'idle');
  event(core, 'b', 0, 'approval/asked', { id: 'q' });
  assert.equal(event(core, 'b', 1, 'approval/decided', { id: 'q' }), 'idle');
  event(core, 'c', 0, 'turn/start', { turn: 1 });
  assert.equal(event(core, 'c', 1, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }), 'idle');
});

test('blocked turns keep every pending approval until its actual decision, including after a new turn', () => {
  let now = 1_000;
  const core = new PetCore({ now: () => now });
  event(core, 'a', 0, 'turn/start', { turn: 1 });
  event(core, 'a', 1, 'approval/asked', { id: 'first' });
  event(core, 'a', 2, 'approval/asked', { id: 'second' });
  assert.equal(event(core, 'a', 3, 'turn/end', { turn: 1, reason: { kind: 'blocked' } }), 'waiting');
  assert.equal(core.snapshot().activity.until, null);
  now += 60_000;
  assert.equal(core.snapshot().activity.name, 'waiting');
  assert.equal(event(core, 'a', 4, 'approval/decided', { id: 'first', outcome: 'allow' }), 'waiting');
  assert.equal(event(core, 'a', 5, 'turn/start', { turn: 2 }), 'waiting');
  assert.equal(event(core, 'a', 6, 'approval/decided', { id: 'second', outcome: 'deny' }), 'thinking');
  assert.equal(event(core, 'a', 7, 'turn/end', { turn: 2, reason: { kind: 'aborted' } }), 'idle');
  event(core, 'b', 0, 'turn/start', { turn: 1 });
  event(core, 'b', 1, 'approval/asked', { id: 'fast' });
  event(core, 'b', 2, 'turn/end', { turn: 1, reason: { kind: 'blocked' } });
  now += 100;
  assert.equal(event(core, 'b', 3, 'approval/decided', { id: 'fast', outcome: 'deny' }), 'idle');
  event(core, 'c', 0, 'turn/end', { turn: 1, reason: { kind: 'blocked' } });
  assert.equal(event(core, 'c', 1, 'approval/decided', { id: 'missed-asked-event' }), 'idle');
});

test('desktop presence is a lease and does not survive a crash indefinitely', () => {
  let now = 1;
  const core = new PetCore({ now: () => now });
  assert.equal(core.presence(true).presence.desktop, true);
  now += 14_000;
  assert.equal(core.snapshot().presence.desktop, true);
  core.presence(true);
  now += 14_000;
  assert.equal(core.snapshot().presence.desktop, true);
  now += 1_001;
  assert.equal(core.snapshot().presence.desktop, false);
});

async function host(t, { dataDir, now, modernJobs = false } = {}) {
  const ownedDirectory = !dataDir;
  dataDir ??= await mkdtemp(join(tmpdir(), 'dsh-whale-test-'));
  const routes = new Map();
  const listeners = new Map();
  const jobListeners = new Set();
  const changedListeners = new Set();
  const modernJobListeners = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const handler = routes.get(path);
    if (!handler) { res.writeHead(404); res.end(); return; }
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const ctx = {
    webServer: {
      port,
      register({ kind, path, handler }) {
        assert.equal(kind, 'exact');
        assert.ok(!routes.has(path));
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    jobs: {
      list: () => [],
      onJobDone: handler => { jobListeners.add(handler); return () => jobListeners.delete(handler); },
      onJobsChanged: handler => { changedListeners.add(handler); return () => changedListeners.delete(handler); },
    },
  };
  if (modernJobs) ctx.jobs.events = {
    subscribe(filter, listener) {
      assert.deepEqual(filter, { owners: 'all' });
      modernJobListeners.add(listener);
      return () => modernJobListeners.delete(listener);
    },
  };
  const plugin = await apply(ctx, { dataDir, now });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, options = {}) => fetch(`${origin}/whale-companion${path}`, options);
  const post = (path, body, extra = {}) => request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...extra.headers },
    body: JSON.stringify(body), ...extra,
  });
  const close = async () => {
    await plugin.dispose();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (ownedDirectory) await rm(dataDir, { recursive: true, force: true });
  };
  t.after(close);
  return { ctx, plugin, request, post, listeners, jobListeners, changedListeners, modernJobListeners, dataDir, routes, origin };
}

test('modern desktop job feed is preferred, observes all owners and ignores teardown notices', async t => {
  let now = 1_000;
  const h = await host(t, { modernJobs: true, now: () => now });
  assert.equal(h.jobListeners.size, 0);
  assert.equal(h.changedListeners.size, 0);
  assert.equal(h.modernJobListeners.size, 1);
  const publish = event => { for (const listener of h.modernJobListeners) listener(event); };
  const job = { id: 'bash-1', owner: 'agent-1', startedAt: 1, status: 'running' };
  publish({ type: 'registered', job });
  assert.equal(h.plugin.core.snapshot().activity.name, 'working');
  publish({ type: 'output', id: 'bash-1', total: 99 });
  assert.equal(h.plugin.core.snapshot().activity.name, 'working');
  publish({ type: 'settled', job: { ...job, status: 'completed' }, cause: 'producer', awaited: false });
  assert.equal(h.plugin.core.snapshot().activity.name, 'celebrate');
  now += 7_000;
  assert.equal(h.plugin.core.snapshot().activity.name, 'idle');
  publish({ type: 'settled', job: { ...job, status: 'completed' }, cause: 'producer', awaited: false });
  assert.equal(h.plugin.core.snapshot().activity.name, 'idle');
  publish({ type: 'registered', job: { ...job, id: 'bash-2' } });
  publish({ type: 'settled', job: { ...job, id: 'bash-2', status: 'failed' }, cause: 'teardown', awaited: false });
  assert.equal(h.plugin.core.snapshot().activity.name, 'idle');
  await h.plugin.dispose();
  assert.equal(h.modernJobListeners.size, 0);
});

test('HTTP interactions persist all concurrent increments and disposal cleans routes/listeners', async t => {
  const h = await host(t);
  const replies = await Promise.all(Array.from({ length: 24 }, (_, i) => h.post('/interact', { action: i % 2 ? 'pet' : 'feed' })));
  assert.ok(replies.every(reply => reply.status === 200));
  const state = await (await h.request('/state')).json();
  assert.deepEqual(state.pet, { name: '大肥鱼', feeds: 12, pets: 12 });
  const disk = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(disk.pet, state.pet);
  const discovery = JSON.parse(await readFile(join(h.dataDir, 'connection.json'), 'utf8'));
  assert.equal(discovery.url, h.origin);
  // Loading the earlier release's default name preserves all saved counters.
  await writeFile(join(h.dataDir, 'state.json'), JSON.stringify({ ...disk, pet: { ...disk.pet, name: '小鲸' } }));
  const reloaded = await host(t, { dataDir: h.dataDir });
  const reloadedInstance = JSON.parse(await readFile(join(h.dataDir, 'connection.json'), 'utf8')).instanceId;
  assert.deepEqual((await (await reloaded.request('/state')).json()).pet, state.pet);
  await h.plugin.dispose();
  assert.equal(h.routes.size, 0);
  assert.equal(h.jobListeners.size, 0);
  assert.equal(h.changedListeners.size, 0);
  assert.equal(h.listeners.get('session/event').size, 0);
  // Disposing an older host must preserve the newer host's discovery entry.
  assert.equal(JSON.parse(await readFile(join(h.dataDir, 'connection.json'), 'utf8')).instanceId, reloadedInstance);
});

test('HTTP rejects cross-origin, untrusted hosts, unsupported actions and oversized JSON', async t => {
  const h = await host(t);
  assert.equal((await h.request('/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  // WHATWG fetch owns the Host header. Use the actual HTTP carrier for the rebinding check.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${h.origin}/whale-companion/state`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await h.request('/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await h.post('/interact', { action: 'approve' })).status, 400);
  assert.equal((await h.post('/interact', { action: 'feed', padding: 'a'.repeat(5000) })).status, 413);
  const streamedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${h.origin}/whale-companion/interact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write('{"action":"feed","padding":"');
    request.write('a'.repeat(5000));
    request.end('"}');
  });
  assert.equal(streamedStatus, 413);
  assert.equal((await h.request('/interact', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await h.request('/interact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await h.request('/interact')).status, 405);
  assert.equal((await h.request('/../index.mjs')).status, 404);
  assert.equal((await h.post('/presence', { desktop: 'true' })).status, 400);
  assert.equal((await h.post('/presence', { desktop: true })).status, 200);
  assert.equal((await (await h.request('/state')).json()).presence.desktop, true);
  assert.deepEqual((await (await h.request('/state')).json()).pet, { name: '大肥鱼', feeds: 0, pets: 0 });
});

test('SSE delivers real host session events and releases its listener on disconnect', async t => {
  const h = await host(t);
  const abort = new AbortController();
  const response = await h.request('/events', { signal: abort.signal });
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/);
  assert.match(first, /"name":"idle"/);
  for (const listener of h.listeners.get('session/event')) listener({ id: 'actual-host-session' }, { seq: 0, type: 'turn/start', data: { turn: 1 } });
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"name":"thinking"/);
  abort.abort();
  await reader.cancel().catch(() => {});
});

test('authentic sprite sheets are PNGs served only through their exact allowlist routes', async t => {
  const h = await host(t);
  for (const state of ['idle', 'think', 'working', 'wait', 'celebrate', 'error', 'eat', 'joy', 'drag']) {
    const response = await h.request(`/sprites/${state}.png`);
    assert.equal(response.status, 200, state);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.equal((await h.request('/sprites/LICENSE')).status, 404);
  assert.equal((await h.request('/sprites/unknown.png')).status, 404);
  assert.equal((await h.request('/whale-girl-sprites.png')).status, 404);
  const head = await h.request('/sprites/idle.png', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('Content-Length')) > 0);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('corrupt state is preserved and startup fails without overwriting it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-whale-corrupt-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const source = '{ invalid state';
  await writeFile(join(dataDir, 'state.json'), source);
  await assert.rejects(apply({ webServer: { port: 5555, register: () => assert.fail('must not register on corrupted state') } }, { dataDir }), /invalid JSON/);
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), source);
});

test('Cordis entry point returns a disposer effect rather than a controller object', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-whale-effect-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const routes = new Map();
  const dispose = await applyPlugin({
    webServer: { port: 5555, register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
  }, { dataDir });
  assert.equal(typeof dispose, 'function');
  assert.equal(routes.size, 16);
  assert.ok(routes.has('/whale-companion/sprites/idle.png'));
  await dispose();
  assert.equal(routes.size, 0);
});
