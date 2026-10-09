'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TOP_UP_URL = 'https://platform.deepseek.com/top_up';

function argumentsFrom(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    for (const key of ['url', 'home']) {
      if (argv[i] === `--${key}`) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`);
        result[key] = argv[++i];
        break;
      }
      if (argv[i].startsWith(`--${key}=`)) result[key] = argv[i].slice(key.length + 3);
    }
  }
  return result;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The pet connects only to an HTTP(S) server on this computer.');
  }
  return url.origin;
}

function discoveryFiles(options = {}, env = process.env) {
  const homes = options.home ? [options.home] : [
    env.DSH_HOME,
    env.APPDATA && path.join(env.APPDATA, 'dsh-desktop-client', 'dsh'),
    path.join(env.USERPROFILE || os.homedir(), '.dsh'),
  ].filter(Boolean);
  return [...new Set(homes.map(home => path.resolve(home)))].map(home => path.join(home, 'data', 'dsh-whale-companion', 'connection.json'));
}

function serverOrigin(options = {}, env = process.env) {
  if (options.url || env.DSH_PET_URL) return loopbackOrigin(options.url || env.DSH_PET_URL);
  for (const file of discoveryFiles(options, env)) {
    try {
      if (fs.statSync(file).size > 4096) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return loopbackOrigin(value.url);
    } catch { /* A missing or stale discovery record must not stop the local pet. */ }
  }
  return 'http://127.0.0.1:3080';
}

function validateRequest(route, body) {
  if (typeof route !== 'string') throw new Error('Invalid pet route');
  route = route.replace(/^\/whale-companion(?=\/)/, '');
  if (route === '/state' && body === undefined) return { route, method: 'GET' };
  if (route === '/billing/state' && body === undefined) return { route, method: 'GET' };
  if (route === '/billing/refresh' && body && typeof body === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(body)) && Reflect.ownKeys(body).length === 0) {
    return { route, method: 'POST', body: {} };
  }
  if (route === '/interact' && body && ['feed', 'pet'].includes(body.action) && Object.keys(body).every(key => key === 'action')) {
    return { route, method: 'POST', body: { action: body.action } };
  }
  if (route === '/presence' && body && typeof body.desktop === 'boolean' && Object.keys(body).every(key => key === 'desktop')) {
    return { route, method: 'POST', body: { desktop: body.desktop } };
  }
  throw new Error('Unsupported pet request');
}

function clampBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))),
    width,
    height,
  };
}

module.exports = { argumentsFrom, loopbackOrigin, discoveryFiles, serverOrigin, validateRequest, clampBounds, TOP_UP_URL };
