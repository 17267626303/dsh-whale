/* DSH browser module; DOM only, no React or host source patches. */
(() => {
  const loader = window.__ModuleLoader__;
  if (!loader) return;
  loader.load({
    id:'dsh-whale-companion',
    factory:() => ({
      name:'dsh-whale-companion-client',
      apply(ctx) {
        const mount = () => {
          if (document.getElementById('dsh-whale-companion-frame')) return () => {};
          const iframe = document.createElement('iframe');
          iframe.id='dsh-whale-companion-frame';
          iframe.src='/whale-companion/pet.html';
          iframe.title='大肥鱼桌面宠物';
          iframe.setAttribute('allowtransparency','true');
          const width=324,height=410;
          Object.assign(iframe.style,{position:'fixed',right:'8px',bottom:'8px',width:`${width}px`,height:`${height}px`,border:'0',background:'transparent',zIndex:'2147483000',colorScheme:'light'});
          document.body.append(iframe);
          function clamp(left,top) { return {left:Math.max(0,Math.min(innerWidth-width,left)),top:Math.max(0,Math.min(innerHeight-height,top))}; }
          function move(left,top) { const p=clamp(left,top); Object.assign(iframe.style,{left:`${p.left}px`,top:`${p.top}px`,right:'auto',bottom:'auto'}); return p; }
          try { const p=JSON.parse(localStorage.getItem('dsh-whale-companion-frame-position')); if(Number.isFinite(p?.left)&&Number.isFinite(p?.top))move(p.left,p.top); }catch{}
          const onMessage=(event) => {
            if(event.origin!==location.origin || event.source!==iframe.contentWindow || event.data?.source!=='dsh-whale-companion')return;
            const data=event.data;
            if(data.type==='drag' && Number.isFinite(data.dx)&&Number.isFinite(data.dy)){
              const r=iframe.getBoundingClientRect();
              const p=move(r.left+Math.max(-100,Math.min(100,data.dx)),r.top+Math.max(-100,Math.min(100,data.dy)));
              try{localStorage.setItem('dsh-whale-companion-frame-position',JSON.stringify(p));}catch{}
            }else if(data.type==='reset-position'){
              Object.assign(iframe.style,{left:'',top:'',right:'8px',bottom:'8px'});
              try{localStorage.removeItem('dsh-whale-companion-frame-position');}catch{}
            }else if(data.type==='presence'){
              // Keep iframe running while invisible, so it can observe TTL expiry.
              iframe.style.visibility=data.desktop===true?'hidden':'visible';
            }
          };
          const onResize=()=>{if(iframe.style.left){const r=iframe.getBoundingClientRect();move(r.left,r.top);}};
          window.addEventListener('message',onMessage);
          window.addEventListener('resize',onResize);
          return()=>{window.removeEventListener('message',onMessage);window.removeEventListener('resize',onResize);iframe.remove();};
        };
        if(typeof ctx.effect==='function')ctx.effect(mount);
        else return mount();
      }
    })
  });
})();
