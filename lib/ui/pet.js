/* Reference whale-girl sprites. Same renderer is used by DSH and the Electron shell. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const shell = window.whaleDesktop;
  const desktop = shell?.isDesktop === true;
  const embedded = window.parent !== window;
  const preview = new URLSearchParams(location.search).has('preview');
  document.body.classList.toggle('desktop', desktop);
  const labels = { idle:'大肥鱼在陪你', thinking:'正在认真思考', working:'正在处理任务', waiting:'等你确认一下', celebrate:'任务完成啦', error:'遇到一点小问题', eat:'好吃喵！', pet:'被摸头啦', joy:'开心开心', drag:'轻轻拎起来' };
  const lines = { idle:'今天也一起加油吧。', thinking:'你忙你的，我在这里陪你。', working:'正在努力，马上就好。', waiting:'有一步需要你在 DSH 中确认哦。', celebrate:'完成啦！辛苦你了 ♡', error:'别着急，我们再试一次。' };
  const allowed = new Set(Object.keys(labels));
  let connected = false;
  let snapshot = null;
  let lastSeq = null;
  let lastRemote = 'idle';
  let transientUntil = 0;
  let dragging = null;
  let pressTimer = null;
  let bubbleTimer = null;
  let actionBusy = false;
  let stopped = false;
  let controller = null;
  let lastFeed = 0;
  let pollTimer = null;
  let parentHidden = false;
  let spriteTimer = null;
  let spriteState = null;
  let appearance = 'chibi';
  let appearanceRequest = 0;
  const appearanceStorageKey = 'whale-companion-appearance';
  const appearances = {
    chibi:{label:'动画大肥鱼'},
    'maid-short':{label:'短裙女仆',src:'portraits/maid-short.png'},
    'maid-long':{label:'长裙女仆',src:'portraits/maid-long.png'},
    evening:{label:'黑金礼服',src:'portraits/evening.png'},
  };
  const appearanceButtons = [...$('appearancePicker').querySelectorAll('button[data-appearance]')];
  const spriteFrames = {idle:3,thinking:1,working:3,waiting:1,celebrate:3,error:2,eat:3,pet:2,joy:2,drag:1};
  const spriteFps = {working:3,celebrate:4,error:4,eat:8,pet:5,joy:5};
  function animateSprite(name) {
    if (appearance !== 'chibi') { clearTimeout(spriteTimer); spriteState = null; return; }
    if (spriteState === name) return;
    spriteState = name;
    clearTimeout(spriteTimer);
    const element = document.querySelector('.sprite-art');
    const frames = spriteFrames[name] || 1;
    let frame = 0;
    const paint = () => element?.style.setProperty('--sprite-x', frames === 1 ? '0%' : `${frame / (frames - 1) * 100}%`);
    paint();
    if (frames < 2 || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    const advance = () => {
      if (stopped || spriteState !== name) return;
      frame = (frame + 1) % frames;
      paint();
      spriteTimer = setTimeout(advance, name === 'idle' ? (frame === 0 ? 3600 : 90) : 1000 / (spriteFps[name] || 3));
    };
    spriteTimer = setTimeout(advance,name === 'idle' ? 3600 : 1000 / (spriteFps[name] || 3));
  }

  function fitMenu() {
    const menu = $('menu');
    if (menu.hidden) return;
    menu.style.setProperty('--menu-shift-x','0px');
    menu.style.setProperty('--menu-shift-y','0px');
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8,Math.min(rect.left,innerWidth-rect.width-8));
    const top = Math.max(8,Math.min(rect.top,innerHeight-rect.height-8));
    menu.style.setProperty('--menu-shift-x',`${left-rect.left}px`);
    menu.style.setProperty('--menu-shift-y',`${top-rect.top}px`);
  }
  function setMenuOpen(open) {
    $('menu').hidden = !open;
    $('more').setAttribute('aria-expanded',String(open));
    if (open) requestAnimationFrame(fitMenu);
  }
  function appearanceFeedback(message = '') {
    $('appearanceFeedback').textContent = message;
    $('appearanceFeedback').hidden = !message;
    requestAnimationFrame(fitMenu);
  }
  function rememberAppearance(id) {
    try { localStorage.setItem(appearanceStorageKey,id); } catch { /* The choice still works for this session. */ }
  }
  function applyAppearance(id, persist = true) {
    appearance = id;
    $('companion').dataset.appearance = id;
    $('spriteArt').hidden = id !== 'chibi';
    $('portraitArt').hidden = id === 'chibi';
    if (id === 'chibi') $('portraitArt').removeAttribute('src');
    else $('portraitArt').src = appearances[id].src;
    for (const button of appearanceButtons) button.setAttribute('aria-pressed',String(button.dataset.appearance === id));
    $('appearanceNote').textContent = `${appearances[id].label} · ${id === 'chibi' ? '多帧动画' : '立绘动作反馈'}`;
    $('appearancePicker').setAttribute('aria-busy','false');
    clearTimeout(spriteTimer);
    spriteState = null;
    animateSprite($('companion').dataset.state || 'idle');
    if (persist) rememberAppearance(id);
  }
  function verifyPortrait(src) {
    return new Promise((resolve,reject) => {
      const image = new Image();
      const finish = (success) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (success && image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
        else reject(new Error('Portrait unavailable'));
      };
      const timer = setTimeout(() => finish(false),6000);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = src;
    });
  }
  function portraitUnavailable(id) {
    applyAppearance('chibi');
    const message = `${appearances[id]?.label || '立绘'}图片未能加载，已切回动画大肥鱼。`;
    appearanceFeedback(message);
    showBubble(message);
  }
  async function selectAppearance(id, announce = true) {
    if (!Object.hasOwn(appearances,id)) id = 'chibi';
    const requestId = ++appearanceRequest;
    appearanceFeedback();
    if (id !== 'chibi') {
      $('appearancePicker').setAttribute('aria-busy','true');
      appearanceFeedback(`正在加载${appearances[id].label}…`);
      try { await verifyPortrait(appearances[id].src); }
      catch {
        if (requestId === appearanceRequest && !stopped) portraitUnavailable(id);
        return;
      }
    }
    if (requestId !== appearanceRequest || stopped) return;
    applyAppearance(id);
    appearanceFeedback();
    if (announce) showBubble(`换成${appearances[id].label}啦。`);
  }
  for (const button of appearanceButtons) button.addEventListener('click',() => selectAppearance(button.dataset.appearance));
  $('appearancePicker').addEventListener('keydown',(event) => {
    const steps = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-2,ArrowDown:2};
    if (!Object.hasOwn(steps,event.key)) return;
    const index = appearanceButtons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    appearanceButtons[(index+steps[event.key]+appearanceButtons.length)%appearanceButtons.length].focus();
  });
  $('portraitArt').addEventListener('error',() => {
    if (appearance !== 'chibi') { ++appearanceRequest; portraitUnavailable(appearance); }
  });

  function post(type, extra = {}) {
    if (embedded) window.parent.postMessage({ source:'dsh-whale-companion', type, ...extra }, location.origin);
  }
  async function request(path, body) {
    if (desktop) return shell.request(path, body);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3500);
    controller = abort;
    try {
      const res = await fetch(`/whale-companion${path}`, { method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', headers:body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body), signal:abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); if (controller === abort) controller = null; }
  }
  function showBubble(text, sticky = false) {
    clearTimeout(bubbleTimer);
    $('bubble').textContent = text;
    $('bubble').classList.remove('quiet');
    if (!sticky) bubbleTimer = setTimeout(() => $('bubble').classList.add('quiet'), 5500);
  }
  function setState(name, text, sticky = false) {
    if (!allowed.has(name)) name = 'idle';
    $('companion').dataset.state = name;
    animateSprite(name);
    $('status').textContent = labels[name];
    if (text) showBubble(text, sticky);
  }
  function remoteState() {
    const name = snapshot?.activity?.name;
    return allowed.has(name) ? name : 'idle';
  }
  function restoreState() {
    if (Date.now() < transientUntil || dragging?.moved) return;
    setState(remoteState());
  }
  function offline(reason) {
    if (connected) showBubble('DSH 暂时离线，我在这里等你回来。');
    connected = false;
    $('connection').textContent = preview ? '独立预览 · 任务状态为演示' : '未连接 DSH · 喂食和摸头仍可使用';
    $('connection').title = reason instanceof Error ? reason.message : '';
    snapshot = null;
    lastRemote = 'idle';
    lastSeq = null;
    restoreState();
  }
  function accept(next) {
    if (!next || typeof next !== 'object' || !next.activity || !next.pet) throw new Error('插件状态格式不兼容');
    const wasConnected = connected;
    connected = true;
    snapshot = next;
    const state = remoteState();
    $('connection').textContent = '已连接 DSH · 任务状态自动同步';
    if (!desktop && embedded) {
      const hidden = next.presence?.desktop === true;
      if (parentHidden !== hidden) { parentHidden = hidden; post('presence', {desktop:hidden}); }
    }
    const changed = next.activity.seq !== lastSeq || state !== lastRemote;
    lastSeq = next.activity.seq;
    lastRemote = state;
    if (changed && Date.now() >= transientUntil && !dragging?.moved) setState(state, lines[state], state === 'waiting');
    else if (!wasConnected) restoreState();
  }
  async function poll() {
    if (stopped) return;
    try { accept(await request('/state')); } catch (error) { offline(error); }
    restoreState();
    pollTimer = setTimeout(poll, connected ? 1200 : 3000);
  }
  function animate(action) {
    const feeding = action === 'feed';
    transientUntil = Date.now() + 2600;
    setState(feeding ? 'eat' : 'pet', feeding ? ['啊呜，谢谢投喂！','没吃饱喵，再来一点？','吃饱啦，继续陪你！'][Math.floor(Math.random()*3)] : ['嘿嘿，好舒服 ♡','摸摸头，烦恼都飞走。','收到你的喜欢啦！'][Math.floor(Math.random()*3)]);
    if (feeding) setTimeout(() => { if (!dragging?.moved && Date.now() < transientUntil) setState('joy'); }, 1500);
    setTimeout(restoreState, 2700);
  }
  async function interact(action) {
    if (actionBusy || Date.now() - lastFeed < 450) return;
    lastFeed = Date.now();
    animate(action);
    if (!connected) return;
    actionBusy = true;
    try { const next = await request('/interact', {action}); if (next?.activity) accept(next); }
    catch (error) { offline(error); }
    finally { actionBusy = false; }
  }
  $('feed').addEventListener('click', () => interact('feed'));
  $('pet').addEventListener('click', () => interact('pet'));
  function toggleMenu() { setMenuOpen($('menu').hidden); }
  $('more').addEventListener('click', toggleMenu);
  $('character').addEventListener('contextmenu', (event) => { event.preventDefault(); setMenuOpen(true); });
  document.addEventListener('pointerdown', (event) => { if (!$('menu').contains(event.target) && event.target !== $('more')) setMenuOpen(false); });
  document.addEventListener('keydown',(event) => {
    if (event.key === 'Escape' && !$('menu').hidden) { event.preventDefault(); setMenuOpen(false); $('more').focus(); }
  });
  if (desktop && typeof shell.setIgnoreMouseEvents === 'function') {
    document.addEventListener('mousemove', (event) => {
      // Transparent space lets clicks reach the desktop below the pet.
      shell.setIgnoreMouseEvents(!dragging && !event.target.closest('button,#menu'));
    });
  }
  $('character').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); interact('pet'); } });
  $('openClient').hidden = !desktop;
  $('openClient').addEventListener('click', () => { shell?.openClient(); setMenuOpen(false); });
  $('hidePet').textContent = desktop ? '退出桌宠' : '收起桌宠';
  $('hidePet').addEventListener('click', () => {
    setMenuOpen(false);
    if (desktop) { shell.close(); return; }
    $('companion').hidden = true;
    $('restore').hidden = false;
  });
  $('restore').addEventListener('click', () => { $('restore').hidden = true; $('companion').hidden = false; showBubble('我回来啦！'); });
  function resetPosition() {
    $('companion').style.left = '';
    $('companion').style.top = '';
    $('companion').style.right = '';
    $('companion').style.bottom = '';
    try { localStorage.removeItem('whale-companion-position'); } catch {}
    if (embedded) post('reset-position');
    setMenuOpen(false);
  }
  $('resetPosition').hidden = desktop;
  $('resetPosition').addEventListener('click', resetPosition);
  function clampPosition(left, top) {
    const root = $('companion');
    return {left:Math.max(0,Math.min(innerWidth-root.offsetWidth,left)),top:Math.max(0,Math.min(innerHeight-root.offsetHeight,top))};
  }
  function positionAt(left, top) {
    const root = $('companion');
    const pos = clampPosition(left,top);
    Object.assign(root.style,{left:`${pos.left}px`,top:`${pos.top}px`,right:'auto',bottom:'auto'});
    return pos;
  }
  if (!desktop && !embedded) {
    try { const saved = JSON.parse(localStorage.getItem('whale-companion-position')); if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) positionAt(saved.left,saved.top); } catch {}
  }
  $('character').addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = $('companion').getBoundingClientRect();
    dragging = {id:event.pointerId,x:event.screenX,y:event.screenY,startX:event.screenX,startY:event.screenY,left:rect.left,top:rect.top,moved:false,headPetted:false};
    $('character').setPointerCapture(event.pointerId);
    pressTimer = setTimeout(() => {
      if (dragging && !dragging.moved) { dragging.headPetted = true; interact('pet'); }
    },650);
  });
  $('character').addEventListener('pointermove', (event) => {
    if (!dragging || dragging.id !== event.pointerId) return;
    const dx = event.screenX-dragging.x, dy = event.screenY-dragging.y;
    if (!dragging.moved && Math.hypot(event.screenX-dragging.startX,event.screenY-dragging.startY) < 5) return;
    if (!dragging.moved) { dragging.moved = true; clearTimeout(pressTimer); setMenuOpen(false); setState('drag'); }
    if (desktop) shell.moveBy(dx,dy);
    else if (embedded) post('drag',{dx,dy});
    else { dragging.left += dx; dragging.top += dy; positionAt(dragging.left,dragging.top); }
    dragging.x = event.screenX; dragging.y = event.screenY;
  });
  function endDrag(event) {
    if (!dragging || dragging.id !== event.pointerId) return;
    clearTimeout(pressTimer);
    const moved = dragging.moved, petted = dragging.headPetted;
    dragging = null;
    if ($('character').hasPointerCapture(event.pointerId)) $('character').releasePointerCapture(event.pointerId);
    if (moved) {
      restoreState();
      if (!desktop && !embedded) {
        const rect = $('companion').getBoundingClientRect();
        try { localStorage.setItem('whale-companion-position',JSON.stringify({left:rect.left,top:rect.top})); } catch {}
      }
    } else if (!petted && event.type === 'pointerup') interact('pet');
  }
  $('character').addEventListener('pointerup',endDrag);
  $('character').addEventListener('pointercancel',endDrag);
  window.addEventListener('resize',() => { if (!desktop && !embedded && $('companion').style.left) { const rect=$('companion').getBoundingClientRect(); positionAt(rect.left,rect.top); } fitMenu(); });
  window.addEventListener('pagehide',() => { stopped=true; ++appearanceRequest; clearTimeout(pollTimer); clearTimeout(pressTimer); clearTimeout(bubbleTimer); clearTimeout(spriteTimer); controller?.abort(); });
  applyAppearance('chibi',false);
  let savedAppearance = null;
  try { savedAppearance = localStorage.getItem(appearanceStorageKey); } catch {}
  if (savedAppearance && Object.hasOwn(appearances,savedAppearance)) selectAppearance(savedAppearance,false);
  else if (savedAppearance) rememberAppearance('chibi');
  bubbleTimer = setTimeout(() => $('bubble').classList.add('quiet'),6500);
  poll();
})();
