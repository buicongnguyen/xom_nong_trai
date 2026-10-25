const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.XNT_PLAYWRIGHT_MODULE||'playwright');
const target=process.env.XNT_QA_URL||'http://127.0.0.1:4198/xom_nong_trai/';
const mobile=process.env.XNT_PERF_DESKTOP!=='1';
const out=path.resolve(__dirname,'../.local/review-qa/render-performance-'+(mobile?'mobile':'desktop'));fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({...(process.env.XNT_CHROME_PATH?{executablePath:process.env.XNT_CHROME_PATH}:{}),args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},deviceScaleFactor:mobile?2:1,isMobile:mobile,hasTouch:mobile});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/ThreeRenderer-*.js*',async route=>{const response=await route.fetch();const code=(await response.text()).replace('this.setupPowerSavingWatch();','this.setupPowerSavingWatch();globalThis.__farmRenderer=this;');await route.fulfill({response,body:code});});
 try{
  await page.goto(target);await page.getByTestId('login-play').click();
  await page.waitForFunction(()=>window.__farmRenderer?.mapScene);await page.waitForTimeout(6000);
  if(await page.getByTestId('tutorial-skip').isVisible())await page.getByTestId('tutorial-skip').click();
  await page.waitForTimeout(1000);
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const result=await page.evaluate(async()=>{
   const moduleUrl=name=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.includes('/assets/'+name))?.name;
   const frame=await import(moduleUrl('framePacing-v0NaHLk2.js'));
   const opt=await import(moduleUrl('render-optimizations.mjs'));
   const F=window.__farmRenderer,R=F.renderer,gl=R.getContext();
   F.setPaused(true);F.holdAdapt(1e8);F.nightFactor=F.nightFactorTarget=.9;F.applyLook();
   F.windTime.value=1;F.mapScene.update(1,0,.9);F.fireflies.update(1,0,.9,F.target.x,F.target.z);
   for(const node of F.nodes.values())for(const part of node.parts)F.applyPart(part,1);
   const batch=F.localFireflyBatch;
   if(!batch)throw new Error('The production renderer did not install its firefly batch');
   let counter={calls:0,triangles:0};
   for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){
    const orig=gl[name].bind(gl);gl[name]=(...a)=>{const count=name.startsWith('drawArrays')?a[2]:a[1],instances=name.endsWith('Instanced')?(name.startsWith('drawArrays')?a[3]:a[4]):1;counter.calls++;if(a[0]===gl.TRIANGLES)counter.triangles+=count/3*instances;return orig(...a);};
   }
   const ext=gl.getExtension('WEBGL_multi_draw');
   for(const name of ['multiDrawElementsWEBGL','multiDrawArraysWEBGL'])if(ext?.[name]){const orig=ext[name].bind(ext);ext[name]=(...a)=>{counter.calls++;const counts=name.includes('Elements')?a[1]:a[3],offset=name.includes('Elements')?a[2]:a[4],n=a.at(-1);if(a[0]===gl.TRIANGLES)for(let i=0;i<n;i++)counter.triangles+=counts[offset+i]/3;return orig(...a);};}
   const render=enabled=>{batch.setEnabled(enabled);R.shadowMap.needsUpdate=true;counter={calls:0,triangles:0};const t=performance.now();F.renderNow();return {...counter,ms:performance.now()-t};};
   for(let i=0;i<8;i++){render(false);render(true);}
   const screenshots={};
   for(const [name,enabled]of [['before',false],['control',false],['after',true],['after-control',true]]){render(enabled);screenshots[name]=F.canvas.toDataURL('image/png');}
   const decode=src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);resolve(ctx.getImageData(0,0,c.width,c.height).data);};img.onerror=reject;img.src=src;});
   const compare=(a,b)=>{let changed=0,over2=0,maxDelta=0;for(let i=0;i<a.length;i+=4){const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));if(d)changed++;if(d>2)over2++;maxDelta=Math.max(maxDelta,d);}return {pixels:a.length/4,changed,over2,maxDelta};};
   const pixels=await Promise.all(['before','control','after','after-control'].map(name=>decode(screenshots[name])));
   const visuals={control:compare(pixels[0],pixels[1]),change:compare(pixels[0],pixels[2]),optimizedControl:compare(pixels[2],pixels[3])};
   const pairs=[],nullPairs=[];
   const arm=async enabled=>{const samples=[];for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);samples.push(render(enabled));}return samples;};
   for(let i=0;i<12;i++){if(i%2){const after=await arm(true),before=await arm(false);pairs.push({before,after});}else{const before=await arm(false),after=await arm(true);pairs.push({before,after});}const a=await arm(false),b=await arm(false);nullPairs.push({before:a,after:b});}
   const memory=[];
   for(const tier of ['high','medium','low'])for(let cycle=0;cycle<3;cycle++){
    const before=R.info.memory.textures;
    const handle=frame.r(R,F.scene,F.camera,F.canvasW,F.canvasH,tier,.9,F.leanMobile);
    handle.composer.render();const loaded=R.info.memory.textures;
    handle.dispose();const disposed=R.info.memory.textures;
    opt.disposeComposer(handle.composer);const cleaned=R.info.memory.textures;
    memory.push({tier,cycle,before,loaded,disposed,cleaned,leakedTextures:disposed-cleaned});
   }
   batch.setEnabled(true);
   const lifecycle=[];
   for(const tier of ['medium','low','lite','high']){
    F.applyLevel({tier,ratio:R.getPixelRatio()});
    await new Promise(resolve=>setTimeout(resolve,150));
    F.setPaused(true);F.fireflies.update(1,0,.9,F.target.x,F.target.z);F.renderNow();
    lifecycle.push({tier,flies:F.fireflies.flies.length,instances:batch.mesh?.count||0,spriteChildren:F.fireflies.group.children.filter(c=>c.isSprite).length});
   }
   let freed=false;batch.mesh?.addEventListener('dispose',()=>{freed=true;});
   F.fireflies.dispose();
   return {screenshots,visuals,pairs,nullPairs,memory,lifecycle,freed,remainingFireflyChildren:F.fireflies.group.children.length,quality:F.quality,dpr:R.getPixelRatio(),gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),multiDraw:!!ext};
  });
  for(const[name,url]of Object.entries(result.screenshots))fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(url.split(',')[1],'base64'));
  delete result.screenshots;result.errors=errors;result.target=target;
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2));
  const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
  console.log(JSON.stringify({errors,memory:result.memory,lifecycle:result.lifecycle,freed:result.freed,before:result.pairs[0].before[0],after:result.pairs[0].after[0],medianBeforeMs:median(result.pairs.flatMap(p=>p.before.map(s=>s.ms))),medianAfterMs:median(result.pairs.flatMap(p=>p.after.map(s=>s.ms))),nullBeforeMs:median(result.nullPairs.flatMap(p=>p.before.map(s=>s.ms))),nullAfterMs:median(result.nullPairs.flatMap(p=>p.after.map(s=>s.ms)))},null,2));
  assert.deepEqual(errors,[]);
  assert.equal(result.visuals.control.over2,0,'Frozen baseline must stay within two color levels');
  assert.equal(result.visuals.optimizedControl.over2,0,'Frozen optimized frame must stay within two color levels');
  assert.equal(result.visuals.change.over2,0,'Instancing must preserve the image within two color levels');
  assert.ok(result.pairs.every(p=>p.after[0].calls<p.before[0].calls),'Instancing must reduce raw WebGL draw submissions');
  assert.ok(result.memory.every(m=>m.leakedTextures===0&&m.disposed===m.before),'Composer cleanup must leave no orphaned render texture');
  assert.ok(result.lifecycle.every(x=>x.flies===x.instances&&x.spriteChildren===0),'Quality changes must rebuild one complete batch');
  assert.equal(result.freed,true);assert.equal(result.remainingFireflyChildren,0);
  result.passed=true;fs.writeFileSync(path.join(out,"report.json"),JSON.stringify(result,null,2));
 }catch(error){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),errors},null,2));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
