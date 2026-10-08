// Exercise the actual renderer through Electron CDP; do not emulate its state logic.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

export async function runAppearanceChecks({ command, evaluate, eventually, delay, firstOnly = false }) {
  const ids = ['chibi', 'maid-short', 'maid-long', 'evening'];
  const portraits = firstOnly ? ['maid-short'] : ids.slice(1);
  const inPage = (fn, ...args) => evaluate(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);
  const original = await evaluate("localStorage.getItem('whale-companion-appearance')");
  async function click(selector) {
    const point = await inPage(selector => {
      const element = document.querySelector(selector);
      if (!element?.getClientRects().length) throw new Error(`Not visible: ${selector}`);
      const rect = element.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    }, selector);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await delay(120);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }
  async function menu(open) {
    if (await evaluate("document.getElementById('menu').hidden") === open) await click('#more');
    assert.equal(await evaluate("document.getElementById('more').getAttribute('aria-expanded')"),String(open));
    if (open) {
      const bounds=await inPage(()=>{const r=document.getElementById('menu').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
      assert.ok(bounds.left>=-1&&bounds.top>=-1&&bounds.right<=bounds.width+1&&bounds.bottom<=bounds.height+1,`Menu must fit viewport: ${JSON.stringify(bounds)}`);
    }
  }
  async function assertAppearance(id) {
    const info=await inPage(async()=>{
      const portrait=document.getElementById('portraitArt');
      if(!portrait.hidden) await portrait.decode();
      const r=portrait.getBoundingClientRect(),s=getComputedStyle(portrait);
      return {id:document.getElementById('companion').dataset.appearance,portraitHidden:portrait.hidden,spriteHidden:document.getElementById('spriteArt').hidden,complete:portrait.complete,width:portrait.naturalWidth,height:portrait.naturalHeight,src:portrait.currentSrc,fit:s.objectFit,display:s.display,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}};
    });
    assert.equal(info.id,id,'Task/interaction states must preserve appearance');
    assert.equal(info.portraitHidden,id==='chibi');
    assert.equal(info.spriteHidden,id!=='chibi');
    if(id==='chibi')return;
    assert.ok(info.complete&&info.width>0&&info.height>0,`${id} must decode`);
    assert.ok(info.src.endsWith(`/portraits/${id}.png`),`${id} must use its own image`);
    assert.equal(info.fit,'contain',`${id} must display without cropping`);
    assert.notEqual(info.display,'none');
    const r=info.rect,v=info.viewport;
    assert.ok(r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=v.width+1&&r.bottom<=v.height+1,`${id} must fit desktop viewport: ${JSON.stringify(r)}`);
  }
  async function choose(id) {
    await menu(true);
    await click(`#appearancePicker button[data-appearance="${id}"]`);
    await eventually(()=>inPage(id=>document.getElementById('companion').dataset.appearance===id,id),`choose ${id}`);
    assert.equal(await evaluate("localStorage.getItem('whale-companion-appearance')"),id);
    assert.equal(await inPage(id=>document.querySelector(`#appearancePicker button[data-appearance="${id}"]`).getAttribute('aria-pressed'),id),'true');
    await menu(false);
    await assertAppearance(id);
  }
  async function reload() {
    await command('Page.reload',{ignoreCache:true});
    await eventually(async()=>{try{return await evaluate("document.getElementById('connection')?.textContent.includes('已连接')");}catch{return false;}},'reconnect after reload');
  }
  async function demo(state) {
    const response=await fetch('http://127.0.0.1:4318/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});
    assert.ok(response.ok);
    await eventually(()=>inPage(state=>document.getElementById('companion').dataset.state===state,state),state);
  }
  async function snapshot(){return fetch('http://127.0.0.1:4318/whale-companion/state').then(r=>r.json());}
  async function screenshot(name){const capture=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(new URL(`../artifacts/appearances-preview/${name}.png`,import.meta.url),Buffer.from(capture.data,'base64'));}
  // Substitute only the browser image-loading boundary, with real Image elements.
  // The held image is eventually released to the real decoder; the missing URL
  // produces an actual browser load failure. Renderer functions stay untouched.
  async function interceptImages(mode) {
    await inPage(mode=>{
      const NativeImage=window.Image;
      const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      window.__appearanceSmoke={NativeImage,held:[],images:[]};
      window.Image=function(...args){
        const image=new NativeImage(...args);
        Object.defineProperty(image,'src',{get(){return descriptor.get.call(image);},set(src){
          if(mode==='fail')descriptor.set.call(image,'portraits/__missing_appearance_smoke__.png');
          else{window.__appearanceSmoke.images.push(image);window.__appearanceSmoke.held.push(()=>descriptor.set.call(image,src));}
        }});
        return image;
      };
    },mode);
  }
  async function restoreImages(){await inPage(()=>{if(window.__appearanceSmoke){window.Image=window.__appearanceSmoke.NativeImage;delete window.__appearanceSmoke;}});}
  try {
    await evaluate("localStorage.removeItem('whale-companion-appearance')");
    await reload();
    await assertAppearance('chibi');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#appearancePicker button[data-appearance]'),b=>b.dataset.appearance).sort()"),[...ids].sort());
    await evaluate("localStorage.setItem('whale-companion-appearance','invalid-smoke-value')");
    await reload();
    await assertAppearance('chibi');
    assert.equal(await evaluate("localStorage.getItem('whale-companion-appearance')"),'chibi');

    await interceptImages('hold');
    try {
      await menu(true);
      await click('#appearancePicker button[data-appearance="maid-short"]');
      await eventually(()=>evaluate('window.__appearanceSmoke.held.length===1'),'pending real portrait load');
      await click('#appearancePicker button[data-appearance="chibi"]');
      await inPage(async()=>{const held=window.__appearanceSmoke.held.splice(0);held.forEach(release=>release());await Promise.all(window.__appearanceSmoke.images.map(image=>image.decode()));});
      await delay(150);
      await assertAppearance('chibi');
      assert.equal(await evaluate("localStorage.getItem('whale-companion-appearance')"),'chibi','A late image must not replace a newer choice');
    } finally {await restoreImages();}
    await interceptImages('fail');
    try {
      await click('#appearancePicker button[data-appearance="maid-short"]');
      await eventually(()=>evaluate("document.getElementById('appearanceFeedback').textContent.includes('图片未能加载')"),'actual image failure feedback');
      await assertAppearance('chibi');
      assert.equal(await evaluate("localStorage.getItem('whale-companion-appearance')"),'chibi');
    } finally {await restoreImages();}
    // The picker supports keyboard focus navigation, not just pointer activation.
    await inPage(()=>document.querySelector('#appearancePicker button[data-appearance="chibi"]').focus());
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    assert.equal(await evaluate('document.activeElement.dataset.appearance'),'maid-short');
    await menu(false);
    await demo('idle');
    await mkdir(new URL('../artifacts/appearances-preview/',import.meta.url),{recursive:true});
    await screenshot('chibi');

    for(const id of portraits){
      await choose(id);
      await reload();
      await eventually(()=>inPage(id=>document.getElementById('companion').dataset.appearance===id,id),`${id} persists after reload`);
      await assertAppearance(id);
      await screenshot(id);
      for(const state of ['thinking','working','waiting','celebrate','error']){await demo(state);await assertAppearance(id);}
      await demo('idle');
      const before=await snapshot();
      await click('#feed');
      await eventually(async()=>(await snapshot()).pet.feeds===before.pet.feeds+1,`${id} feed IPC`);
      assert.equal(await evaluate("document.getElementById('companion').dataset.state"),'eat');
      await assertAppearance(id);
      await eventually(()=>evaluate("document.getElementById('companion').dataset.state==='joy'"),`${id} joy`);
      await assertAppearance(id);
      await delay(1200);
      await click('#pet');
      assert.equal(await evaluate("document.getElementById('companion').dataset.state"),'pet');
      await assertAppearance(id);
      await delay(2800);
      const count=(await snapshot()).pet.pets;
      const point=await inPage(()=>{const r=document.getElementById('character').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height*.4};});
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await delay(120);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await delay(780);
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      await eventually(async()=>(await snapshot()).pet.pets===count+1,`${id} long pet exactly once`);
      await assertAppearance(id);await delay(2800);
      const oldX=await evaluate('window.screenX');
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await delay(120);
      await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x-18,y:point.y,button:'left',buttons:1});
      await eventually(()=>evaluate("document.getElementById('companion').dataset.state==='drag'"),`${id} drag`);
      await assertAppearance(id);
      await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x-18,y:point.y,button:'left',clickCount:1});
      const movedX=await evaluate('window.screenX');assert.ok(movedX<oldX,`${id} native drag`);
      await evaluate(`window.whaleDesktop.moveBy(${oldX-movedX},0)`);
      await demo('idle');
    }
    await demo('working');
    await choose('chibi');
    assert.ok((await evaluate("getComputedStyle(document.getElementById('spriteArt')).backgroundImage")).endsWith('/sprites/working.png")'));
    assert.equal(await evaluate("getComputedStyle(document.getElementById('spriteArt')).backgroundSize"),'300% 100%');
    const frames=new Set();for(let n=0;n<8;n++){frames.add(await evaluate("document.getElementById('spriteArt').style.getPropertyValue('--sprite-x')"));await delay(150);}
    assert.ok(frames.size>1,'Returning to chibi must resume unchanged activity frames');
    assert.ok([...frames].every(frame=>['0%','50%','100%'].includes(frame)),'Chibi must use valid horizontal frame positions');
    await demo('idle');
    await menu(true);await screenshot('appearance-picker');await menu(false);
    console.log(`Appearance checks OK (${firstOnly?'PARTIAL: first portrait only':'all four'}): decode, contain, reload, invalid storage, load failure, latest-choice race, keyboard, all states and interactions.`);
  } finally {
    await restoreImages().catch(()=>{});
    await inPage(value=>{if(value===null)localStorage.removeItem('whale-companion-appearance');else localStorage.setItem('whale-companion-appearance',value);},original).catch(()=>{});
  }
}
