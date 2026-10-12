const fs=require('fs');
const path=require('path');
const {chromium}=require(process.env.XNT_PLAYWRIGHT_MODULE || 'playwright');
const target=process.argv[2] || process.env.XNT_QA_URL || 'http://127.0.0.1:4198/xom_nong_trai/';
const output=path.resolve(process.argv[3] || path.join(__dirname,'../.local/review-qa/frontend-browser'));
const u=new URL(target);
if(!['127.0.0.1','localhost'].includes(u.hostname)&&!u.hostname.endsWith('.github.io'))throw new Error('Only local or github.io test builds accepted.');
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.XNT_CHROME_PATH ? {executablePath:process.env.XNT_CHROME_PATH} : {})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'vi-VN'});
 const page=await context.newPage();
 const report={target,pageErrors:[],consoleErrors:[],requestFailures:[],httpFailures:[],apiNetwork:[],webSocketNetwork:[],outsideBaseRequests:[],screenshots:[]};
 page.on('pageerror',e=>report.pageErrors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 page.on('requestfailed',r=>report.requestFailures.push({url:r.url(),failure:r.failure()?.errorText}));
 page.on('request',r=>{
   const x=new URL(r.url());
   if(x.pathname.includes('/api/'))report.apiNetwork.push(r.url());
   if(['http:','https:'].includes(x.protocol)&&x.origin===u.origin&&!x.pathname.startsWith(u.pathname))report.outsideBaseRequests.push(r.url());
 });
 page.on('websocket',w=>report.webSocketNetwork.push(w.url()));
 page.on('response',r=>{if(r.status()>=400)report.httpFailures.push({url:r.url(),status:r.status()});});
 const snap=async()=>({url:page.url(),text:await page.locator('body').innerText(),canvasCount:await page.locator('canvas').count(),buttons:await page.getByRole('button').allTextContents()});
 const shot=async name=>{const file=path.join(output,name);await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);};
 try{
  await page.goto(target,{waitUntil:'domcontentloaded',timeout:60000});
  await page.getByRole('button',{name:/^(Chơi ngay|Play now)$/i}).first().waitFor({state:'visible',timeout:60000});
  report.beforeGuest=await snap();
  await page.getByRole('button',{name:/^(Chơi ngay|Play now)$/i}).first().click();
  const later=page.getByRole('button',{name:/^(Để sau|Later)$/i}).first();
  try{await later.waitFor({state:'visible',timeout:15000});await later.click();report.onboardingDismissed=true;}catch{report.onboardingDismissed=false;}
  await page.locator('canvas').first().waitFor({state:'visible',timeout:60000});
  await page.waitForTimeout(3000);
  report.desktop=await snap();
  await shot('desktop-game.png');
  report.storageBefore=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
  // Purchase through the UI to prove module loading, mutations, and browser persistence.
  const shop=page.getByRole('button',{name:/^(Cửa hàng|Shop)$/i}).first();
  await shop.click();
  await page.waitForTimeout(1000);
  report.shop=await snap();
  await page.getByRole('tab',{name:/^(Hạt giống|Seeds)$/i}).first().click();
  const rice=page.getByRole('button',{name:/^(Lúa|Rice),/i}).first();
  await rice.click();await page.waitForTimeout(500);
  report.rice=await snap();
  const buy=page.getByRole('button',{name:/^(Mua|Buy)(?:\s|$)/i}).first();
  await buy.click();await page.waitForTimeout(3500);report.purchased=true;
  report.afterPurchase=await snap();
  report.storageAfter=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
  if(!report.afterPurchase.text.startsWith('2.492\n100\n46/150'))throw new Error('Seed purchase did not update wallet and inventory as expected.');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('canvas').first().waitFor({state:'visible',timeout:60000});
  await page.waitForTimeout(2000);
  report.afterReload=await snap();
  if(!report.afterReload.text.startsWith('2.492\n100\n46/150'))throw new Error('Seed purchase did not survive reload.');
  report.storageReload=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])));
  report.serviceWorkers=await page.evaluate(async()=>navigator.serviceWorker?(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,scriptURL:r.active?.scriptURL})):[]);
  if(!report.serviceWorkers.some(r=>r.scope===target&&r.scriptURL===new URL('push-sw.js',target).href))throw new Error('Service worker did not register within the Pages project scope.');
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(2000);
  report.mobile=await snap();
  await shot('mobile-game.png');
  // Scene changes/reload can cancel unused atlas preloads. Verify every cancelled
  // image is available rather than interpreting navigation cancellation as a 404.
  report.abortedAssetChecks=[];
  for(const url of new Set(report.requestFailures.filter(r=>r.failure==='net::ERR_ABORTED'&&/\.webp$/.test(r.url)).map(r=>r.url))){
   const response=await context.request.get(url);
   const size=(await response.body()).length;
   report.abortedAssetChecks.push({url,status:response.status(),size});
   if(!response.ok()||size===0)throw new Error('Cancelled atlas was unavailable: '+url);
  }
  report.ready=report.desktop.canvasCount>0&&report.afterReload.canvasCount>0;
 }catch(error){report.fatalError=String(error);try{await shot('failure.png');}catch{}}
 finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
 console.log(JSON.stringify({target,ready:report.ready,fatalError:report.fatalError,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,httpFailures:report.httpFailures,apiNetwork:report.apiNetwork,webSocketNetwork:report.webSocketNetwork,abortedAssetChecks:report.abortedAssetChecks,purchase:report.purchased,reload:!!report.afterReload,mobile:!!report.mobile,screenshots:report.screenshots},null,2));
 const unexpectedRequestFailures=report.requestFailures.filter(r=>!(r.failure==='net::ERR_ABORTED'&&(r.url.endsWith('.mp3')||report.abortedAssetChecks?.some(asset=>asset.url===r.url&&asset.status===200&&asset.size>0))));
 if(report.fatalError||!report.ready||report.pageErrors.length||report.consoleErrors.length||unexpectedRequestFailures.length||report.httpFailures.length||report.apiNetwork.length||report.webSocketNetwork.length||report.outsideBaseRequests.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
