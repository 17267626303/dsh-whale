'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { fileURLToPath } = require('node:url');
const { argumentsFrom, serverOrigin, validateRequest, clampBounds, TOP_UP_URL } = require('./config.cjs');
const whaleIcon = require('./icon.cjs');

const options = argumentsFrom(process.argv.slice(1));
const uiFile = path.resolve(__dirname, '../lib/ui/pet.html');
let win, tray, heartbeat, saveTimer, quitting = false, released = false;
let activeOrigin = serverOrigin(options);
let announcedOrigin = null;
app.setName('DeepSeek Whale Companion');

function transport(origin, request) {
  return new Promise((resolve, reject) => {
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
    const url = new URL(`/whale-companion${request.route}`, origin);
    const socket = (url.protocol === 'https:' ? https : http).request(url, {
      method: request.method,
      headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: request.route === '/billing/refresh' ? 15000 : 2500,
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) socket.destroy(new Error('Pet response is too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`DSH pet HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('DSH pet returned invalid JSON')); }
      });
    });
    socket.on('timeout', () => socket.destroy(new Error('DSH pet connection timed out')));
    socket.on('error', reject);
    socket.end(payload);
  });
}

async function refreshPresence() {
  try {
    const discovered = serverOrigin(options);
    if (announcedOrigin && announcedOrigin !== discovered) {
      transport(announcedOrigin, validateRequest('/presence', { desktop: false })).catch(() => {});
      announcedOrigin = null;
    }
    activeOrigin = discovered;
    await transport(activeOrigin, validateRequest('/presence', { desktop: Boolean(win && win.isVisible()) }));
    announcedOrigin = activeOrigin;
  } catch { /* Offline animation and interactions remain available in the bundled UI. */ }
}

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
  try { return fileURLToPath(new URL(event.senderFrame.url)) === uiFile; } catch { return false; }
}

function savedBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  let bounds = { x: primary.x + primary.width - 344, y: primary.y + primary.height - 430, width: 324, height: 410 };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'position.json'), 'utf8'));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) bounds = { ...bounds, x: saved.x, y: saved.y };
  } catch {}
  return clampBounds(bounds, screen.getDisplayMatching(bounds).workArea);
}

function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(clampBounds(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea));
}

function persistPosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const { x, y } = win.getBounds();
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'position.json'), JSON.stringify({ x, y }));
    } catch {}
  }, 180);
}

function showPet() {
  if (!win) return;
  keepOnScreen(); win.showInactive(); refreshPresence();
}

function petMenu() {
  return Menu.buildFromTemplate([
    { label: '显示大肥鱼', click: showPet },
    { label: '暂时隐藏', click: () => { win.hide(); refreshPresence(); } },
    { label: '打开插件页面', click: () => shell.openExternal(`${activeOrigin}/whale-companion/pet.html`).catch(() => {}) },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(), title: '大肥鱼 · DeepSeek', icon: nativeImage.createFromBuffer(whaleIcon()),
    frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  // The renderer loads bundled files only; DSH HTTP requests run through the narrow IPC proxy.
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url.startsWith('data:') || details.url.startsWith('devtools:');
    try {
      const resource = fileURLToPath(details.url);
      const relative = path.relative(path.dirname(uiFile), resource);
      allowed = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    } catch {}
    callback({ cancel: !allowed });
  });
  win.webContents.on('context-menu', () => petMenu().popup({ window: win }));
  win.on('move', persistPosition);
  win.once('ready-to-show', showPet);
  win.on('closed', () => { win = null; if (!quitting) app.quit(); });
  win.loadFile(uiFile, { query: { desktop: '1' } }).catch(error => {
    console.error('Unable to load the bundled pet UI:', error.message); app.quit();
  });
  const icon = nativeImage.createFromBuffer(whaleIcon());
  tray = new Tray(icon); tray.setToolTip('大肥鱼 · DeepSeek 桌面宠物'); tray.setContextMenu(petMenu());
  tray.on('click', showPet);
}

ipcMain.handle('whale:request', async (event, route, body) => {
  if (!trusted(event)) throw new Error('Untrusted pet frame');
  const request = validateRequest(route, body);
  activeOrigin = serverOrigin(options);
  return transport(activeOrigin, request);
});
ipcMain.on('whale:move', (event, dx, dy) => {
  if (!trusted(event) || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1000 || Math.abs(dy) > 1000) return;
  const current = win.getBounds();
  const proposed = { ...current, x: current.x + Math.round(dx), y: current.y + Math.round(dy) };
  win.setBounds(clampBounds(proposed, screen.getDisplayMatching(proposed).workArea));
});
ipcMain.on('whale:open-client', event => { if (trusted(event)) shell.openExternal(`${activeOrigin}/whale-companion/pet.html`).catch(() => {}); });
ipcMain.handle('whale:open-top-up', async (event, ...args) => {
  if (!trusted(event) || args.length !== 0) throw new Error('Unsupported top-up request');
  await shell.openExternal(TOP_UP_URL);
  return true;
});
ipcMain.on('whale:quit', event => { if (trusted(event)) app.quit(); });
ipcMain.on('whale:menu', event => { if (trusted(event)) petMenu().popup({ window: win }); });
ipcMain.on('whale:ignore-mouse', (event, ignore) => {
  if (trusted(event) && typeof ignore === 'boolean') win.setIgnoreMouseEvents(ignore, { forward: true });
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showPet);
  app.whenReady().then(() => {
    createWindow(); heartbeat = setInterval(refreshPresence, 4000);
    screen.on('display-removed', keepOnScreen);
    screen.on('display-metrics-changed', keepOnScreen);
  });
  app.on('before-quit', event => {
    quitting = true; clearInterval(heartbeat); clearTimeout(saveTimer);
    if (released) return;
    event.preventDefault(); released = true;
    const origin = announcedOrigin || activeOrigin;
    transport(origin, validateRequest('/presence', { desktop: false })).catch(() => {}).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
