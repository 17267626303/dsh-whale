'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { argumentsFrom, loopbackOrigin, discoveryFiles, serverOrigin, validateRequest, clampBounds } = require('../config.cjs');

test('restricts connection targets to HTTP(S) loopback without credentials', () => {
  for (const url of ['http://127.0.0.1:3456', 'https://localhost:99', 'http://[::1]:20']) assert.ok(loopbackOrigin(url));
  for (const url of ['https://example.com', 'file:///tmp/a', 'http://localhost.example.com', 'http://user:pass@localhost']) {
    assert.throws(() => loopbackOrigin(url));
  }
});
test('reads a plugin discovery record and honors explicit URL precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-discovery-'));
  try {
    const [file] = discoveryFiles({ home: dir }, {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:18888' }));
    assert.equal(serverOrigin({ home: dir }, {}), 'http://127.0.0.1:18888');
    assert.equal(serverOrigin({ home: dir, url: 'http://localhost:3000' }, { DSH_PET_URL: 'http://localhost:4000' }), 'http://localhost:3000');
  } finally {
    const target = fs.realpathSync(dir);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), target);
    if (!relative.startsWith('whale-discovery-') || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
    fs.rmSync(target, { recursive: true, force: true });
  }
});
test('does not expose arbitrary routes or mutation payloads to the renderer', () => {
  assert.equal(validateRequest('/whale-companion/state').method, 'GET');
  assert.deepEqual(validateRequest('/interact', { action: 'pet' }).body, { action: 'pet' });
  for (const [route, body] of [['/settings', {}], ['/interact', { action: 'run' }], ['/interact', { action: 'pet', command: 'x' }], ['/state', {}], ['/presence', { desktop: 'yes' }]]) {
    assert.throws(() => validateRequest(route, body));
  }
});
test('clamps disconnected-monitor positions back into a usable screen', () => {
  const area = { x: 0, y: 0, width: 1366, height: 768 };
  assert.deepEqual(clampBounds({ x: -999, y: 2000, width: 360, height: 520 }, area), { x: 0, y: 248, width: 360, height: 520 });
});
test('parses both argument styles and rejects missing values', () => {
  assert.deepEqual(argumentsFrom(['main.cjs', '--url=http://localhost:99', '--home', 'C:\\pet']), { url: 'http://localhost:99', home: 'C:\\pet' });
  assert.throws(() => argumentsFrom(['--url', '--home']));
});
