const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
// Pages-only QA: every run creates an isolated browser context and disposable
// browser farm. Point XNT_QA_URL at a Pages build served locally or on HTTPS.
const {chromium}=require(process.env.XNT_PLAYWRIGHT_MODULE||'playwright');
const out=path.resolve(__dirname,'../.local/review-qa/frontend-flow');
fs.mkdirSync(out,{recursive:true});
const target=process.env.XNT_QA_URL||'http://127.0.0.1:4198/xom_nong_trai/';
(async()=>{
  const browser=await chromium.launch({...(process.env.XNT_CHROME_PATH?{executablePath:process.env.XNT_CHROME_PATH}:{}),headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'vi-VN'});
  const page=await context.newPage();
  const report={target,errors:[],api:[],steps:[]};
  page.on('pageerror',error=>report.errors.push(String(error)));
  try{
    await page.goto(target,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('[data-testid="login-play"]')||document.querySelector('canvas'));
    if(await page.getByTestId('login-play').isVisible())await page.getByTestId('login-play').click();
    await page.locator('canvas').first().waitFor({state:'visible'});
    await page.waitForTimeout(1200);
    await page.evaluate(()=>{
      const key=Object.keys(localStorage).find(key=>key.startsWith('xnt:pages:')&&key.endsWith('farm/farm.json'));
      if(!key)throw new Error('This QA requires a browser-only Pages build. No isolated localStorage farm was found; a Node server farm will not be modified.');
      const farm=JSON.parse(localStorage.getItem(key));
      farm.wallet={...farm.wallet,level:8,exp:2450,gold:50000,xu:500};
      farm.user.tutorialStep=25;farm.user.tutorialSnoozed=true;
      farm.inventory.lua=30;farm.inventory.ngo=20;
      localStorage.setItem(key,JSON.stringify(farm));
    });
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('canvas').first().waitFor({state:'visible'});
    await page.waitForTimeout(1100);
    assert.equal(await page.getByTestId('modal-account-save').isVisible(),false,'A local farm at level 8 must not automatically open the unavailable online account-save dialog');
    report.steps.push({step:'account-auto-prompt-suppressed'});
    const attach=async()=>page.evaluate(async(baseUrl)=>{
      globalThis.flowEndpoint=route=>new URL('api/'+route,baseUrl).href;
      const url=performance.getEntriesByType('resource').find(entry=>/\/assets\/index-[^/]+\.js$/.test(new URL(entry.name).pathname))?.name;
      if(!url)throw new Error('Main module URL missing');
      const module=await import(url);
      const stores=Object.entries(module).filter(([name,value])=>typeof value?.getState==='function').map(([name,value])=>({name,value,state:value.getState()}));
      globalThis.flowSelect=stores.find(store=>'selectedObjectId'in store.state&&typeof store.state.select==='function')?.value;
      globalThis.flowPanels=stores.find(store=>'panel'in store.state&&typeof store.state.open==='function'&&typeof store.state.close==='function')?.value;
      globalThis.flowWorld=stores.find(store=>'objectsById'in store.state&&'world'in store.state)?.value;
      globalThis.flowAPI=[];
      const fetch=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{
        const response=await fetch(input,init);
        const url=input instanceof Request?input.url:String(input);
        if(url.includes('/api/')){
          let data;try{data=await response.clone().json()}catch{}
          let body;try{body=JSON.parse(init?.body)}catch{}
          flowAPI.push({url,method:init?.method||'GET',body,status:response.status,data});
        }
        return response;
      };
      return stores.map(({name,state})=>({name,keys:Object.keys(state)}));
    },target);
    report.stores=await attach();
    await page.evaluate(()=>flowPanels.getState().open('home'));
    await page.getByTestId('panel-home').waitFor({state:'visible'});
    await page.waitForTimeout(500);
    report.steps.push({step:'home-open',buttons:await page.locator('button:visible').evaluateAll(elements=>elements.map(element=>({id:element.dataset.testid,text:element.innerText,label:element.getAttribute('aria-label')})))});
    await page.screenshot({path:path.join(out,'home-open.png')});
    await page.getByRole('button',{name:'Xem toàn quốc',exact:true}).click();
    await page.waitForTimeout(500);
    const polygon=page.locator('[data-pid="can_tho"]').first();
    await polygon.click({force:true});
    await page.waitForTimeout(250);
    report.steps.push({step:'map-can-tho-selected',text:await page.locator('body').innerText()});
    await page.screenshot({path:path.join(out,'map-selected.png')});
    await page.getByTestId('pickhome-confirm').click();
    await page.waitForTimeout(250);
    report.steps.push({step:'home-confirm-dialog',buttons:await page.locator('button:visible').evaluateAll(elements=>elements.map(element=>({id:element.dataset.testid,text:element.innerText,label:element.getAttribute('aria-label')})))});
    await page.getByTestId('modal-confirm-ok').click();
    await page.getByTestId('panel-home').waitFor({state:'hidden'});
    await page.waitForTimeout(350);
    const home=await page.evaluate(async()=>({profile:await(await fetch(flowEndpoint('home'))).json(),text:document.body.innerText,requests:flowAPI.filter(item=>item.url.endsWith('/api/home'))}));
    assert.equal(home.profile.home.provinceId,'can_tho');
    assert.ok(home.text.includes('Cần Thơ'),'Home change must update the HUD');
    report.steps.push({step:'home-can-tho-confirmed',...home});
    await page.screenshot({path:path.join(out,'home-hud.png')});
    report.api.push(...await page.evaluate(()=>flowAPI));
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('canvas').first().waitFor({state:'visible'});
    await page.waitForTimeout(1100);
    assert.equal(await page.getByTestId('modal-account-save').isVisible(),false,'Reloading a local farm must not reopen the online account-save dialog');
    await attach();
    const restored=await page.evaluate(async()=>({profile:await(await fetch(flowEndpoint('home'))).json(),text:document.body.innerText}));
    assert.equal(restored.profile.home.provinceId,'can_tho');
    assert.ok(restored.text.includes('Cần Thơ'));
    report.steps.push({step:'home-can-tho-after-reload',...restored});
    const factoryId=await page.evaluate(()=>{
      const factory=flowWorld.getState().world.objects.find(object=>object.defId==='may_cam');
      if(!factory)throw new Error('No starting feed mill');
      flowPanels.getState().close();flowSelect.getState().select(factory.id);
      return factory.id;
    });
    await page.getByTestId('popup-factory').waitFor({state:'visible'});
    report.steps.push({step:'factory-open',factoryId,buttons:await page.locator('button:visible').evaluateAll(elements=>elements.map(element=>({id:element.dataset.testid,dataId:element.dataset.id,text:element.innerText,label:element.getAttribute('aria-label')})))});
    await page.getByTestId('popup-factory-hire-worker').first().click();
    await page.getByTestId('modal-confirm-ok').click();
    await page.waitForTimeout(250);
    const hired=await page.evaluate(async(id)=>(await(await fetch(flowEndpoint('world'))).json()).objects.find(object=>object.id===id),factoryId);
    assert.equal(hired.factory.workers,2);
    await page.locator('[data-testid="picker-item"][data-id="cam_ga"]').click();
    await page.locator('[data-testid="picker-item"][data-id="cam_bo"]').click();
    await page.getByTestId('popup-factory-speed-up').nth(1).waitFor({state:'visible'});
    const parallel=await page.evaluate(async(id)=>(await(await fetch(flowEndpoint('world'))).json()).objects.find(object=>object.id===id),factoryId);
    assert.equal(parallel.factory.queue.length,2);
    assert.ok(Date.parse(parallel.factory.queue[0].startAt)<=Date.now());
    assert.ok(Date.parse(parallel.factory.queue[1].startAt)<=Date.now());
    const firstRecipe=parallel.factory.queue[0].recipeId;
    const firstEnd=parallel.factory.queue[0].endAt;
    const secondRecipe=parallel.factory.queue[1].recipeId;
    report.steps.push({step:'factory-worker-two-parallel',factory:parallel.factory});
    await page.screenshot({path:path.join(out,'factory-parallel.png')});
    await page.getByTestId('popup-factory-speed-up').nth(1).click();
    await page.waitForTimeout(250);
    const speedup=await page.evaluate(()=>flowAPI.filter(item=>item.url.endsWith('/api/speed-up')&&item.method==='POST').at(-1));
    assert.equal(speedup.body.target.jobIndex,1);
    assert.equal(speedup.status,200);
    const after=await page.evaluate(async(id)=>(await(await fetch(flowEndpoint('world'))).json()).objects.find(object=>object.id===id),factoryId);
    assert.equal(after.factory.queue.length,1);
    assert.equal(after.factory.queue[0].recipeId,firstRecipe);
    assert.equal(after.factory.queue[0].endAt,firstEnd);
    assert.ok(after.factory.output.some(item=>item.itemId===secondRecipe));
    report.steps.push({step:'factory-second-speedup',request:speedup.body,status:speedup.status,factory:after.factory});
    await page.screenshot({path:path.join(out,'factory-second-finished.png')});
    assert.deepEqual(report.errors,[],'The complete frontend flow must not raise page errors');
    console.log(JSON.stringify({passed:true,steps:report.steps.map(({step})=>step),errors:report.errors,speedup:speedup.body},null,2));
  }catch(error){report.failure=String(error);throw error;}
  finally{
    report.api.push(...await page.evaluate(()=>globalThis.flowAPI||[]).catch(()=>[]));
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
