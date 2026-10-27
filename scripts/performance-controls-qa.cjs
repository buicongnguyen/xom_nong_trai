const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.XNT_PLAYWRIGHT_MODULE||'playwright');
const target=process.env.XNT_QA_URL||'http://127.0.0.1:4198/xom_nong_trai/';
(async()=>{
 const browser=await chromium.launch({...(process.env.XNT_CHROME_PATH?{executablePath:process.env.XNT_CHROME_PATH}:{} )});
 try{for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/ThreeRenderer-*.js*',async route=>{const response=await route.fetch();let code=await response.text();const anchor='this.setupPowerSavingWatch();';assert.equal(code.split(anchor).length,2);await route.fulfill({response,body:code.replace(anchor,anchor+'window.__farmRenderer=this;')});});
  await page.goto(target);await page.getByTestId('login-play').click();await page.waitForFunction(()=>window.__farmRenderer?.mapScene);await page.waitForTimeout(4000);if(await page.getByTestId('tutorial-skip').isVisible())await page.getByTestId('tutorial-skip').click();
  const cdp=await context.newCDPSession(page);
  const frame=()=>page.evaluate(()=>window.__farmRenderer.getCameraFrame());
  const before=await frame();const x=mobile?195:720,y=mobile?420:500;
  if(mobile){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i*10,y:y+i*5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+80,y+40,{steps:8});await page.mouse.up();}
  await page.waitForTimeout(300);const panned=await frame();assert.ok(before.x!==panned.x||before.y!==panned.y,'drag must pan');
  if(mobile){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-70,y,id:1},{x:x+70,y,id:2}]});for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70+i*8,y,id:1},{x:x+70-i*8,y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else await page.mouse.wheel(0,240);
  await page.waitForTimeout(300);const zoomed=await frame();assert.notEqual(panned.zoom,zoomed.zoom,'wheel/pinch must zoom');
  const picking=await page.evaluate(()=>{const F=window.__farmRenderer;F.setPaused(true);const arms=[];for(const enabled of [false,true]){F.localWorkCache.setEnabled(enabled);F.renderNow();const picks=[];for(let y=F.canvasH*.25;y<F.canvasH*.75;y+=30)for(let x=F.canvasW*.25;x<F.canvasW*.75;x+=30)picks.push(F.pickObjectAt(x,y));arms.push(picks);}return {equal:JSON.stringify(arms[0])===JSON.stringify(arms[1]),hits:arms[0].filter(x=>x!==null).length};});
  assert.ok(picking.equal&&picking.hits>0,'farm picking must match after pan/zoom');assert.deepEqual(errors,[]);
  const out=path.resolve(__dirname,'../.local/review-qa/performance-controls');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,(mobile?'mobile':'desktop')+'.json'),JSON.stringify({passed:true,before,panned,zoomed,picking,errors},null,2));console.log({mobile,passed:true,picking});await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
