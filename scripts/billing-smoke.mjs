// Runs against the local preview's mocked balance server. Never opens top-up or calls a model.
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';

export async function runBillingChecks({command,evaluate,eventually,delay,portable=false}) {
  const base='http://127.0.0.1:4318';
  const mode=portable?'portable':'source';
  const getBilling=async()=>{
    const response=await fetch(`${base}/whale-companion/billing/state`);
    assert.equal(response.status,200,'Preview must provide the mocked billing API');
    return response.json();
  };
  const demo=async state=>{
    const response=await fetch(`${base}/demo`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});
    assert.equal(response.status,200,`Preview demo ${state}`);
    return response.json();
  };
  const waitFor=async(fn,label,timeout=20000)=>{
    const until=Date.now()+timeout;
    while(Date.now()<until){if(await fn())return;await delay(150);}
    throw new Error(`Timed out: ${label}`);
  };
  const showPanel=async()=>{
    await evaluate("if(document.getElementById('menu').hidden)document.getElementById('more').click();document.getElementById('billingTab').click()");
    await delay(180);
  };
  const capture=async name=>{
    await mkdir(new URL('../artifacts/billing-preview/',import.meta.url),{recursive:true});
    const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(new URL(`../artifacts/billing-preview/${mode}-${name}.png`,import.meta.url),Buffer.from(result.data,'base64'));
  };
  const assertBounds=async()=>{
    const bounds=await evaluate("(()=>{const r=document.getElementById('menu').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()");
    assert.ok(bounds.left>=7&&bounds.top>=7&&bounds.right<=bounds.width-7&&bounds.bottom<=bounds.height-7,`Billing menu must fit the window: ${JSON.stringify(bounds)}`);
  };
  const refresh=async()=>{
    await evaluate("document.getElementById('refreshBalance').click()");
    await eventually(()=>evaluate("!document.getElementById('refreshBalance').disabled"),'balance refresh finished');
  };

  // Reload seeds the notification cursor from historical summaries created by the earlier UI checks.
  await demo('billing-ready');
  await command('Page.reload');
  await eventually(()=>evaluate("document.getElementById('connection')?.textContent.includes('已连接')"),'billing page reconnected');
  await showPanel();
  assert.equal(await evaluate("document.getElementById('billingTab').getAttribute('aria-selected')"),'true');
  assert.equal(await evaluate("document.getElementById('appearancePanel').hidden"),true);
  assert.equal(await evaluate("typeof window.whaleDesktop.openTopUp"),'function');
  assert.deepEqual(await evaluate("(()=>{const a=document.getElementById('topUp');return {href:a.href,target:a.target,rel:a.rel}})()"),{
    href:'https://platform.deepseek.com/top_up',target:'_blank',rel:'noopener noreferrer',
  });
  assert.equal(await evaluate("window.whaleDesktop.request('/billing/refresh',{apiKey:'rejected'}).then(()=>false,()=>true)"),true);
  await refresh();
  await eventually(()=>evaluate("document.getElementById('billingBalance').textContent.includes('100')"),'mocked 100 CNY balance');
  assert.ok((await evaluate("document.getElementById('billingBalanceStatus').textContent")).includes('更新于'));
  await assertBounds();
  await capture('ready');
  await delay(1400);
  assert.equal(await evaluate("document.getElementById('bubble').dataset.summarySeq||null"),null,'Historical summaries must not replay after reload');

  await evaluate("window.__billingReports=[];window.__billingObserver=new MutationObserver(()=>{const b=document.getElementById('bubble'),seq=b.dataset.summarySeq;if(seq&&window.__billingReports.at(-1)?.seq!==seq)window.__billingReports.push({seq,text:b.textContent})});window.__billingObserver.observe(document.getElementById('bubble'),{attributes:true,attributeFilter:['data-summary-seq']})");
  const before=await getBilling();
  await demo('billing-task');
  await waitFor(async()=>{const b=await getBilling();return b.lastTask?.seq>(before.lastTask?.seq||0);},'task summary recorded');
  const task=(await getBilling()).lastTask;
  assert.equal(task.totalTokens,1700);
  assert.equal(task.inputTokens,1500);
  assert.equal(task.outputTokens,200);
  assert.ok(task.costs.length>0&&task.costs[0].amount!==null,'Known official model must provide an estimated cost');
  await eventually(()=>evaluate(`document.getElementById('bubble').dataset.summarySeq===${JSON.stringify(String(task.seq))}`),'new task report bubble');
  let report=await evaluate("document.getElementById('bubble').textContent");
  assert.ok(report.includes('1,700 Token')&&report.includes('余额')&&report.includes('100'),report);
  assert.ok(report.includes(task.costs[0].amount)&&report.includes('估算'),report);
  await evaluate("document.getElementById('more').click()");
  await capture('task-summary');
  await showPanel();
  await eventually(()=>evaluate("document.getElementById('billingLastTokens').textContent.includes('1,700')"),'last task details');
  assert.ok((await evaluate("document.getElementById('billingLastCost').textContent")).includes(task.costs[0].amount));
  const after=await getBilling();
  assert.equal((after.daily.knownTotalTokens??after.daily.totalTokens)-(before.daily.knownTotalTokens??before.daily.totalTokens),1700);
  await refresh();
  await refresh();
  await delay(7000);
  assert.equal(await evaluate(`window.__billingReports.filter(item=>item.seq===${JSON.stringify(String(task.seq))}).length`),1,'Refreshing must not replay the same task report');

  // Complete two turns before the renderer's next poll. Both reports must be retained and ordered.
  const concurrentBefore=await getBilling();
  await Promise.all([demo('billing-task'),demo('billing-task')]);
  await waitFor(async()=>{
    const b=await getBilling();
    return b.summaries.filter(item=>item.seq>(concurrentBefore.lastTask?.seq||0)).length>=2;
  },'both concurrent completions recorded');
  const expected=(await getBilling()).summaries.filter(item=>item.seq>(concurrentBefore.lastTask?.seq||0)).sort((a,b)=>a.seq-b.seq).map(item=>String(item.seq));
  assert.equal(expected.length,2);
  await waitFor(()=>evaluate(`window.__billingReports.filter(item=>${JSON.stringify(expected)}.includes(item.seq)).length===2`),'both queued reports displayed');
  const observed=await evaluate(`window.__billingReports.filter(item=>${JSON.stringify(expected)}.includes(item.seq)).map(item=>item.seq)`);
  assert.deepEqual(observed,expected,'Concurrent task reports must display in sequence order without loss');

  // A balance failure must retain the last successful amount and its timestamp.
  await showPanel();
  const oldBalance=await evaluate("document.getElementById('billingBalance').textContent");
  const oldStamp=(await getBilling()).balance.updatedAt;
  await demo('billing-error');
  await refresh();
  await eventually(()=>evaluate("document.getElementById('billingBalanceStatus').textContent.includes('失败')"),'safe failed balance refresh');
  assert.equal(await evaluate("document.getElementById('billingBalance').textContent"),oldBalance);
  assert.equal((await getBilling()).balance.updatedAt,oldStamp);
  assert.ok((await evaluate("document.getElementById('billingBalanceStatus').textContent")).includes('更新于'));
  await assertBounds();
  await capture('stale');
  await demo('billing-ready');
  await refresh();
  await eventually(async()=>!(await evaluate("document.getElementById('billingBalanceStatus').textContent")).includes('失败'),'balance refresh recovered');

  // A turn without a model usage record must not become a zero-cost report.
  const unknownBefore=await getBilling();
  await demo('thinking');
  await demo('celebrate');
  await waitFor(async()=>(await getBilling()).lastTask?.seq>(unknownBefore.lastTask?.seq||0),'missing-usage task recorded');
  const unknown=(await getBilling()).lastTask;
  assert.equal(unknown.requests,0);
  assert.ok(unknown.unknownCostRequests>0);
  await eventually(()=>evaluate("document.getElementById('billingLastTokens').textContent==='未返回用量'"),'missing usage displayed explicitly');
  assert.ok((await evaluate("document.getElementById('billingLastCost').textContent")).includes('暂不可用'));
  const dailyWithMissingUsage=(await getBilling()).daily;
  if(dailyWithMissingUsage.totalTokens===null&&dailyWithMissingUsage.knownTotalTokens>0){
    const dailyText=await evaluate("document.getElementById('billingDailyTokens').textContent");
    assert.ok(dailyText.includes('已知')&&dailyText.includes('未完整'),dailyText);
  }
  await waitFor(()=>evaluate(`document.getElementById('bubble').dataset.summarySeq===${JSON.stringify(String(unknown.seq))}`),'missing usage summary report');
  report=await evaluate("document.getElementById('bubble').textContent");
  assert.ok(report.includes('金额暂不可用')&&report.includes('未返回用量'),report);
  assert.ok(!/本次\s*(?:¥|US\$)\s*0(?:\.0+)?\b/.test(report),report);
  await evaluate("document.querySelector('.billing-scroll').scrollTop=document.querySelector('.billing-scroll').scrollHeight");
  await assertBounds();
  await capture('unavailable');
  // Switching away from the official account must erase its cached amount, even with updatedAt=null.
  await demo('billing-unconfigured');
  await eventually(()=>evaluate("document.getElementById('billingBalance').textContent==='未配置'"),'removed account amount cleared');
  assert.equal((await getBilling()).balance.updatedAt,null);
  assert.ok(!(await evaluate("document.getElementById('billingBalance').textContent")).includes('100'));
  await evaluate("document.querySelector('.billing-scroll').scrollTop=0");
  await capture('account-unconfigured');
  await demo('billing-ready');
  await eventually(()=>evaluate("document.getElementById('billingBalance').textContent.includes('100')"),'official account restored');
  // A failed model attempt followed by real usage must retain known tokens without claiming completeness.
  const partialBefore=await getBilling();
  await demo('billing-partial');
  await waitFor(async()=>(await getBilling()).lastTask?.seq>(partialBefore.lastTask?.seq||0),'partial task recorded');
  const partialBilling=await getBilling();
  const partial=partialBilling.lastTask;
  assert.equal(partial.totalTokens,null);
  assert.equal(partial.knownTotalTokens,1700);
  assert.ok(partial.unknownTokenRequests>0);
  await eventually(()=>evaluate("document.getElementById('billingLastTokens').textContent.includes('已知 1,700 Token（未完整）')"),'partial task tokens retained explicitly');
  assert.ok((await evaluate("document.getElementById('billingLastCost').textContent")).includes('暂不可用'));
  const partialDailyText=await evaluate("document.getElementById('billingDailyTokens').textContent");
  assert.ok(partialDailyText.includes('已知')&&partialDailyText.includes('未完整')&&partialDailyText.includes(partialBilling.daily.knownTotalTokens.toLocaleString('zh-CN')),partialDailyText);
  await waitFor(()=>evaluate(`document.getElementById('bubble').dataset.summarySeq===${JSON.stringify(String(partial.seq))}`),'partial usage report');
  const partialReport=await evaluate("document.getElementById('bubble').textContent");
  assert.ok(partialReport.includes('已知 1,700 Token（未完整）')&&partialReport.includes('暂不可用'),partialReport);
  await evaluate("document.querySelector('.billing-scroll').scrollTop=0");
  await assertBounds();
  await capture('partial');
  await evaluate("window.__billingObserver.disconnect()");
  console.log('Billing UI integration OK: mocked balance, refresh/stale recovery, daily usage, task cost, no replay, ordered concurrent reports, missing/partial usage, removed account cleared, fixed top-up link, bounded menu, screenshots.');
}
