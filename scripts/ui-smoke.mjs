// Real Electron smoke test, using Chromium's local DevTools protocol.
import assert from 'node:assert/strict';
import { runAppearanceChecks } from './appearance-smoke.mjs';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../desktop/package.json',import.meta.url));
const electron=require('electron');
const root=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const portable=process.argv.includes('--portable');
const executable=portable?fileURLToPath(new URL(`../dist/${process.env.WHALE_PACK_NAME || 'FatWhaleCompanion-win32-x64'}/WhaleCompanion.exe`,import.meta.url)):electron;
const launchArgs=[...(portable?[]:[fileURLToPath(new URL('../desktop/main.cjs',import.meta.url))]),'--url=http://127.0.0.1:4318','--remote-debugging-port=9438','--disable-gpu'];
const child=spawn(executable,launchArgs,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';child.stderr.on('data',c=>{output+=c;});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let socket;
const pending=new Map();let id=0;
function command(method,params={}){return new Promise((resolve,reject)=>{const seq=++id;pending.set(seq,{resolve,reject});socket.send(JSON.stringify({id:seq,method,params}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;}
async function eventually(fn,label){let actual;for(let n=0;n<40;n++){actual=await fn();if(actual)return;await delay(150);}throw new Error(`Timed out: ${label}`);}
try{
  let target;
  for(let n=0;n<60;n++){try{const pages=await fetch('http://127.0.0.1:9438/json/list').then(r=>r.json());target=pages.find(p=>p.type==='page'&&p.url.includes('pet.html'));if(target)break;}catch{}await delay(200);}
  if(!target)throw new Error(`No pet page. ${output}`);
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const task=pending.get(data.id);pending.delete(data.id);data.error?task?.reject(new Error(data.error.message)):task?.resolve(data.result);}});
  await eventually(()=>evaluate("document.getElementById('connection')?.textContent.includes('已连接')"),'connection');
  assert.equal(await evaluate('window.whaleDesktop.isDesktop'),true);
  assert.equal(await evaluate("document.querySelector('#character svg')===null"),true);
  await runAppearanceChecks({command,evaluate,eventually,delay,firstOnly:process.argv.includes('--first-portrait')});
  assert.ok((await evaluate("getComputedStyle(document.querySelector('.sprite-art')).backgroundImage")).includes('sprites/idle.png'));
  const before=await fetch('http://127.0.0.1:4318/whale-companion/state').then(r=>r.json());
  await evaluate("document.getElementById('feed').click()");
  await eventually(async()=>{const s=await fetch('http://127.0.0.1:4318/whale-companion/state').then(r=>r.json());return s.pet.feeds===before.pet.feeds+1;},'feed persisted through IPC');
  assert.ok(['eat','joy'].includes(await evaluate("document.getElementById('companion').dataset.state")));
  await delay(2800);
  await evaluate("document.getElementById('pet').click()");
  assert.equal(await evaluate("document.getElementById('companion').dataset.state"),'pet');
  await delay(2800);
  const petsBefore=(await fetch('http://127.0.0.1:4318/whale-companion/state').then(r=>r.json())).pet.pets;
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:160,y:155});
  await delay(100);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:160,y:155,button:'left',clickCount:1});
  await delay(780);
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:160,y:155,button:'left',clickCount:1});
  await eventually(async()=>{const s=await fetch('http://127.0.0.1:4318/whale-companion/state').then(r=>r.json());return s.pet.pets===petsBefore+1;},'long head pet exactly once');
  await delay(2200);
  for(const state of ['thinking','working','waiting','celebrate','error']){
    await fetch('http://127.0.0.1:4318/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});
    await eventually(()=>evaluate(`document.getElementById('companion').dataset.state===${JSON.stringify(state)}`),state);
    const imageState={thinking:'think',working:'working',waiting:'wait',celebrate:'celebrate',error:'error'}[state];
  assert.ok((await evaluate("getComputedStyle(document.querySelector('.sprite-art')).backgroundImage")).includes(`sprites/${imageState}.png`));
  }
  await fetch('http://127.0.0.1:4318/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"state":"idle"}'});
  await eventually(()=>evaluate("document.getElementById('companion').dataset.state==='idle'"),'idle');
  const oldX=await evaluate('window.screenX');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:160,y:155});
  await delay(120);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:160,y:155,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:142,y:155,button:'left',buttons:1});
  await delay(200);
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:142,y:155,button:'left',clickCount:1});
  const movedX=await evaluate('window.screenX');
  assert.ok(movedX<oldX,'Dragging the character should move the native window');
  await evaluate(`window.whaleDesktop.moveBy(${oldX-movedX},0)`);
  // Confirm API stays limited to pet operations.
  assert.equal(await evaluate("window.whaleDesktop.request('/not-allowed').then(()=>false,()=>true)"),true);
  await mkdir(new URL('../artifacts/appearances-preview/',import.meta.url),{recursive:true});
  await evaluate("document.getElementById('feed').click()");await delay(350);
  const captured=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(new URL('../artifacts/appearances-preview/chibi-feed.png',import.meta.url),Buffer.from(captured.data,'base64'));
  await delay(3000);
  const idleCapture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(new URL('../artifacts/appearances-preview/chibi-idle.png',import.meta.url),Buffer.from(idleCapture.data,'base64'));
  console.log('Electron integration OK: connected, feed, head pet, 5 task states, drag IPC, API boundary, screenshot.');
  await evaluate('window.whaleDesktop.close()');
}finally{
  socket?.close();
  await delay(500);
  if(child.exitCode===null)child.kill();
}
