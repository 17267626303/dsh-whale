import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PetCore } from './pet-core.mjs';
import { createBillingHost } from './billing-host.mjs';

export const name = 'dsh-whale-companion';
export const inject = ['webServer'];
const PREFIX = '/whale-companion';
const STATIC = new Map([
  ['/pet.html', ['pet.html', 'text/html; charset=utf-8']],
  ['/pet.js', ['pet.js', 'text/javascript; charset=utf-8']],
  ['/pet.css', ['pet.css', 'text/css; charset=utf-8']],
  ...['idle', 'think', 'working', 'wait', 'celebrate', 'error', 'eat', 'joy', 'drag']
    .map(state => [`/sprites/${state}.png`, [`sprites/${state}.png`, 'image/png']]),
  ...['maid-short', 'maid-long', 'evening']
    .map(portrait => [`/portraits/${portrait}.png`, [`portraits/${portrait}.png`, 'image/png']]),
]);

/** Cordis plugin entry point: the returned function is a lifecycle effect. */
export async function apply(ctx, config = {}) {
  const host = await startHost(ctx, config);
  return host.dispose;
}

/** Standalone bootstrap for preview/test carriers. It returns an explicit controller. */
export async function startHost(ctx, config = {}) {
  // Cordis's explicit get is safe for an optional capability; direct undeclared
  // service reads throw under the real host's context proxy.
  const homePath = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined;
  const dataDir = config.dataDir ?? (typeof homePath === 'function'
    ? homePath('data', name)
    : join(resolveHome(), 'data', name));
  const statePath = join(dataDir, 'state.json');
  const connectionPath = join(dataDir, 'connection.json');
  const core = new PetCore({ pet: await loadPet(statePath), now: config.now });
  const disposers = [];
  const streams = new Set();
  let disposed = false;
  let saves = Promise.resolve();
  const instanceId = randomUUID();
  const warn = message => {
    if (typeof ctx.logger === 'function') ctx.logger(name).warn(message);
    else console.warn(`[${name}] ${message}`);
  };
  const broadcast = state => {
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const response of streams) {
      if (response.destroyed || response.writableLength > 64 * 1024) {
        streams.delete(response);
        response.end();
      } else response.write(event);
    }
  };
  let billing;
  const snapshot = () => ({ ...core.snapshot(), billing: billing?.snapshot() });
  billing = await createBillingHost({ ctx, config, dataDir, now: config.now,
    warn, onChange: () => { if (billing) broadcast(snapshot()); } });
  disposers.push(() => billing.dispose());
  const save = () => {
    const text = JSON.stringify({ version: 1, pet: core.snapshot().pet }, null, 2) + '\n';
    saves = saves.catch(error => warn(`Previous counter save failed: ${error.message}`))
      .then(() => atomicWrite(statePath, text));
    return saves;
  };
  const observe = disposer => {
    if (typeof disposer === 'function') disposers.push(disposer);
  };
  const sendJSON = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  const route = async (req, res) => {
    try {
      if (disposed) return sendJSON(res, 503, { error: 'Pet plugin is stopping' });
      if (!localRequest(req, ctx.webServer.port)) return sendJSON(res, 403, { error: 'Local same-origin requests only' });
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const path = pathname.slice(PREFIX.length);
      if (path === '/state' && req.method === 'GET') return sendJSON(res, 200, snapshot());
      if (path === '/billing/state' && req.method === 'GET') return sendJSON(res, 200, billing.snapshot());
      if (path === '/billing/refresh' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
          return sendJSON(res, 400, { error: 'Balance refresh accepts only an empty JSON object' });
        }
        return sendJSON(res, 200, await billing.refresh());
      }
      if (path === '/interact' && req.method === 'POST') {
        const body = await readJSON(req);
        if (!body || !['feed', 'pet'].includes(body.action)) return sendJSON(res, 400, { error: 'action must be feed or pet' });
        core.interact(body.action);
        await save();
        return sendJSON(res, 200, snapshot());
      }
      if (path === '/presence' && req.method === 'POST') {
        const body = await readJSON(req);
        if (typeof body?.desktop !== 'boolean') return sendJSON(res, 400, { error: 'desktop must be boolean' });
        core.presence(body.desktop);
        return sendJSON(res, 200, snapshot());
      }
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (STATIC.has(path) && (req.method === 'GET' || req.method === 'HEAD')) {
        const [file, mime] = STATIC.get(path);
        const body = await readFile(new URL(`./ui/${file}`, import.meta.url));
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': body.length,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (['/state', '/interact', '/presence', '/events', '/billing/state', '/billing/refresh', ...STATIC.keys()].includes(path)) {
        res.setHeader('Allow', ['/interact', '/presence', '/billing/refresh'].includes(path) ? 'POST' : 'GET, HEAD');
        return sendJSON(res, 405, { error: 'Method not allowed' });
      }
      return sendJSON(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) warn(`Request failed: ${error.message}`);
      sendJSON(res, status, { error: status === 500 ? 'Unable to save pet state' : error.message });
    }
  };
  try {
    // Exact route registrations ensure no catch-all can accidentally serve arbitrary files.
    for (const path of ['/state', '/interact', '/presence', '/events', '/billing/state', '/billing/refresh', ...STATIC.keys()]) {
      observe(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${path}`, handler: route }));
    }
    if (typeof ctx.on === 'function') {
      observe(ctx.on('session/event', (session, event) => {
        core.sessionEvent(session, event);
        billing.observe(session, event).catch(() => warn('用量事件记录失败，请检查桌宠数据目录。'));
      }));
      observe(ctx.on('session/disposed', session => core.sessionDisposed(session)));
    }
    const attachJobs = jobs => {
      const detach = [];
      if (typeof jobs?.events?.subscribe === 'function') {
        // Desktop 0.2 uses a structured event feed; CLI 0.1 uses the legacy
        // listeners below. Subscribe to one API so settlements are not doubled.
        const current = new Map((jobs.list?.() ?? []).map(job => [String(job.id), job]));
        const refresh = () => core.jobsChanged({ sessionId: 'desktop-job-feed' }, [...current.values()]);
        refresh();
        detach.push(jobs.events.subscribe({ owners: 'all' }, event => {
          if (!event.job) return; // Output events contain counters, no lifecycle snapshot.
          const job = event.job;
          if (event.type === 'removed') current.delete(String(job.id));
          else current.set(String(job.id), job);
          refresh();
          if (event.type === 'settled' && event.cause !== 'teardown') core.jobDone(job);
        }));
      } else {
        if (typeof jobs?.onJobDone === 'function') detach.push(jobs.onJobDone(job => core.jobDone(job)));
        if (typeof jobs?.onJobsChanged === 'function') {
          detach.push(jobs.onJobsChanged(owner => core.jobsChanged(owner, jobs.list(owner))));
          core.jobsChanged(undefined, jobs.list());
        }
      }
      return () => {
        for (const stop of detach) stop();
        core.jobs.clear();
        core.tick();
      };
    };
    if (typeof ctx.inject === 'function') {
      // Optional services belong in a child fiber in this Cordis version;
      // {required, optional} is not a supported inject declaration.
      const jobsFiber = ctx.inject(['jobs'], jobsCtx => attachJobs(jobsCtx.jobs));
      observe(() => jobsFiber.dispose());
    } else {
      observe(attachJobs(ctx.jobs));
    }
    observe(core.subscribe(state => broadcast({ ...state, billing: billing.snapshot() })));
    const timer = setInterval(() => {
      core.tick();
      for (const stream of streams) if (!stream.destroyed) stream.write(': heartbeat\n\n');
    }, 1_000);
    timer.unref();
    observe(() => clearInterval(timer));
    const url = `http://127.0.0.1:${ctx.webServer.port}`;
    await atomicWrite(connectionPath, JSON.stringify({ version: 1, url, instanceId, pid: process.pid, startedAt: Date.now() }, null, 2) + '\n');
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose();
    throw error;
  }

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const disposer of disposers.reverse()) await disposer();
    for (const stream of streams) stream.end();
    streams.clear();
    await saves.catch(error => warn(`Unable to save counters: ${error.message}`));
    // A second host can share this location. Never remove its newer discovery record.
    try {
      const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
      if (connection.instanceId === instanceId) await unlink(connectionPath);
    } catch (error) { if (error.code !== 'ENOENT') warn(`Unable to clear connection record: ${error.message}`); }
  };
  return { core, billing, dispose };
}

function resolveHome() {
  const configured = process.env.DSH_HOME?.trim();
  if (!configured) return join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (/^~[/\\]/.test(configured)) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

async function loadPet(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (Buffer.byteLength(source) > 64 * 1024) throw new Error('Pet state exceeds 64 KiB; preserve the file and inspect it before restarting');
  let data;
  try { data = JSON.parse(source); }
  catch { throw new Error('Pet state is invalid JSON; preserve the file and inspect it before restarting'); }
  if (data?.version !== 1 || !data.pet || typeof data.pet !== 'object' || Array.isArray(data.pet)) {
    throw new Error('Unsupported pet state; preserve the file and inspect it before restarting');
  }
  return data.pet;
}

async function atomicWrite(path, text) {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function localRequest(req, port) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let target;
  try { target = new URL(`http://${host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || Number(target.port || 80) !== port) return false;
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === target.origin;
}

async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  if (Number(req.headers['content-length'] ?? 0) > 4096) {
    req.resume();
    throw Object.assign(new Error('Request body exceeds 4096 bytes'), { status: 413 });
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      req.resume();
      throw Object.assign(new Error('Request body exceeds 4096 bytes'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
