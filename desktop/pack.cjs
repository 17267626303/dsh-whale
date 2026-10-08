'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const electron = path.dirname(require('electron'));
const output = path.join(root, 'dist', process.env.WHALE_PACK_NAME || 'FatWhaleCompanion-win32-x64');
if (path.dirname(output) !== path.join(root,'dist')) throw new Error('Build name must be a single directory name.');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run this portable Windows build on Windows x64.');
if (!fs.existsSync(path.join(root, 'lib', 'ui', 'pet.html'))) throw new Error('The bundled pet UI is missing.');
if (fs.existsSync(output)) throw new Error(`Build already exists: ${output}. Move it aside before rebuilding.`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.cpSync(electron, output, { recursive: true });
fs.rmSync(path.join(output, 'resources', 'default_app.asar'), { force: true });
const resources = path.join(output, 'resources', 'app');
fs.mkdirSync(path.join(resources, 'desktop'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'config.cjs', 'icon.cjs']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(resources, 'desktop', name));
}
fs.cpSync(path.join(root, 'lib', 'ui'), path.join(resources, 'lib', 'ui'), { recursive: true });
fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ name: 'dsh-whale-companion', version: JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version, main: 'desktop/main.cjs' }, null, 2));
fs.renameSync(path.join(output, 'electron.exe'), path.join(output, 'WhaleCompanion.exe'));
console.log(`Portable desktop pet: ${path.join(output, 'WhaleCompanion.exe')}`);
