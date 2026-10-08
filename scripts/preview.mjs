// Standalone local preview; task buttons are deliberately labelled as a demo.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startHost as apply } from '../lib/index.mjs';
const routes = new Map();
const handlers = new Map();
const effects = [];
const host = '127.0.0.1';
const server = createServer(async (req,res) => {
  const pathname = new URL(req.url,`http://${host}`).pathname;
  const route=routes.get(pathname);
  if(route) { try { await route(req,res); } catch(error) { console.error(error); if(!res.headersSent)res.writeHead(500);res.end(); } return; }
  if(pathname==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(new URL('../preview.html',import.meta.url)));return;}
  if(pathname==='/demo'&&req.method==='POST'){
    let raw=''; for await(const chunk of req){raw+=chunk;if(raw.length>256){res.writeHead(413);res.end();return;}}
    const origin=req.headers.origin;if(origin&&origin!==`http://${host}:${server.address().port}`){res.writeHead(403);res.end();return;}
    let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
    const session={id:'preview-session'};
    const event=(type,data={})=>{for(const fn of handlers.get('session/event')||[])fn(session,{type,data,seq:++seq,time:Date.now()});};
    if(body.state==='thinking')event('turn/start');
    else if(body.state==='working'){event('turn/start');event('tool/call',{id:'preview-tool',name:'preview'});}
    else if(body.state==='waiting')event('approval/asked',{id:'preview-approval',toolName:'演示任务'});
    else if(body.state==='celebrate'||body.state==='error'){event('approval/decided',{id:'preview-approval',outcome:'approved'});event('turn/end',{reason:{kind:body.state==='error'?'error':'completed'}});}
    else{event('approval/decided',{id:'preview-approval',outcome:'approved'});event('turn/end',{reason:{kind:'aborted'}});}
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;
  }
  res.writeHead(404);res.end('Not found');
});
let seq=0;
const port=Number(process.env.PORT)||4318;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
const ctx={
  webServer:{host,port:server.address().port,register({path,handler}){routes.set(path,handler);return()=>routes.delete(path);}},
  dshHomePath(...parts){return new URL(`../.preview-data/${parts.join('/')}`,import.meta.url).pathname.replace(/^\/(\w:)/,'$1');},
  get(name){return name==='webServer'?this.webServer:undefined;},
  on(type,callback){const set=handlers.get(type)||new Set();set.add(callback);handlers.set(type,set);return()=>set.delete(callback);},
  effect(fn){const dispose=fn();if(typeof dispose==='function')effects.push(dispose);},
};
const plugin=await apply(ctx,{dataDir:fileURLToPath(new URL('../.preview-data/data/dsh-whale-companion',import.meta.url))});
console.log(`桌宠预览：http://${host}:${server.address().port}`);
function shutdown(){plugin?.dispose?.();for(const effect of effects)effect();server.close(()=>process.exit());setTimeout(()=>process.exit(),1000).unref();}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
