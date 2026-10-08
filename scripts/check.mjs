import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
for(const file of [manifest.main,manifest.exports['./client'],manifest.dsh.bundle.patch,'lib/ui/pet.html','lib/ui/pet.js','lib/ui/pet.css'])await stat(new URL(`../${file}`,import.meta.url));
for(const state of ['idle','think','working','wait','celebrate','error','eat','joy','drag'])await stat(new URL(`../lib/ui/sprites/${state}.png`,import.meta.url));
for(const file of ['lib/index.mjs','lib/pet-core.mjs','lib/client.js','lib/ui/pet.js','desktop/main.cjs','desktop/preload.cjs','desktop/config.cjs','scripts/preview.mjs']){
  const result=spawnSync(process.execPath,['--check',new URL(`../${file}`,import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error(`${file}: ${result.stderr||result.error}`);
}
const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
let module;
const vm=await import('node:vm');
vm.runInNewContext(source,{window:{__ModuleLoader__:{load(value){module=value;}}}});
if(module?.id!==manifest.name||typeof module.factory().apply!=='function')throw new Error('DSH client registration contract is invalid');
console.log('Manifest, packaged assets, JS syntax, and DSH module registration: OK');
