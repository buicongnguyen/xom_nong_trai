const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.XNT_PLAYWRIGHT_MODULE||'playwright');
const mobile=process.env.XNT_PERF_DESKTOP!=='1',out=path.resolve(__dirname,'../.local/review-qa/cpu-performance-'+(mobile?'mobile':'desktop'));
fs.mkdirSync(out,{recursive:true});
(async()=>{
const browser=await chromium.launch({...(process.env.XNT_CHROME_PATH?{executablePath:process.env.XNT_CHROME_PATH}:{}),args:['--use-angle=d3d11','--enable-gpu','--ignore-gpu-blocklist']});
try{
const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},deviceScaleFactor:mobile?2:1,isMobile:mobile,hasTouch:mobile});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.route('**/ThreeRenderer-*.js*',async route=>{const r=await route.fetch();let code=await r.text();const anchor='this.setupPowerSavingWatch();';assert.equal(code.split(anchor).length,2);code=code.replace(anchor,anchor+'globalThis.__farmRenderer=this;');await route.fulfill({response:r,body:code});});
await page.route('**/performance-correctness.mjs',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(__dirname,'performance-correctness.mjs'),'utf8')}));
await page.goto(process.env.XNT_QA_URL||'http://127.0.0.1:4198/xom_nong_trai/');await page.getByTestId('login-play').click();await page.waitForFunction(()=>window.__farmRenderer?.mapScene);await page.waitForTimeout(6000);if(await page.getByTestId('tutorial-skip').isVisible())await page.getByTestId('tutorial-skip').click();await page.waitForTimeout(1000);
const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
const report=await page.evaluate(async()=>{
 const F=window.__farmRenderer,R=F.renderer,gl=R.getContext();F.setPaused(true);F.holdAdapt(1e8);F.nightFactor=F.nightFactorTarget=.9;F.applyLook();
 const mainUrl=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/index-Gy4nOY45.js')).name;
 const main=await import(mainUrl),Matrix4=main.bi;
 const optUrl=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/cpu-optimizations.mjs'))?.name;
 const opt=await import(optUrl),cache=F.localWorkCache;
 if(!cache)throw Error('Production work cache missing');
 if(cache){F.localWorkCache=cache;cache.setEnabled(false);}
 const original={},undo=[];let counters,active=true,pass='main';
 const reset=()=>counters={compose:0,multiply:0,draws:0,shadowDraws:0,postDraws:0,triangles:0,bufferData:0,bufferDataBytes:0,bufferSubData:0,bufferSubDataBytes:0,textureSubImageCalls:0,textureSubImageBytes:0};reset();
 const wrap=(obj,key,fn)=>{const orig=obj[key];obj[key]=function(...args){return fn.call(this,orig,args);};undo.push(()=>obj[key]=orig);};
 for(const [method,key]of [['compose','compose'],['multiplyMatrices','multiply']])wrap(Matrix4.prototype,method,function(fn,a){if(active)counters[key]++;return fn.apply(this,a);});
 wrap(R,'renderBufferDirect',function(fn,a){const previous=pass;pass=a[3].isMeshDepthMaterial||a[3].isMeshDistanceMaterial?'shadow':a[1]===F.scene?'main':'post';try{return fn.apply(this,a);}finally{pass=previous;}});
 const draw=(mode,n,instances=1)=>{if(!active)return;counters.draws++;if(pass==='shadow')counters.shadowDraws++;if(pass==='post')counters.postDraws++;if(mode===gl.TRIANGLES)counters.triangles+=n/3*instances;};
 for(const method of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced'])wrap(gl,method,function(fn,a){draw(a[0],method.startsWith('drawArrays')?a[2]:a[1],method.endsWith('Instanced')?a[method.startsWith('drawArrays')?3:4]:1);return fn.apply(this,a);});
 const ext=gl.getExtension('WEBGL_multi_draw');for(const method of ['multiDrawElementsWEBGL','multiDrawArraysWEBGL'])if(ext?.[method])wrap(ext,method,function(fn,a){const counts=method.includes('Elements')?a[1]:a[3],offset=method.includes('Elements')?a[2]:a[4];let n=0;for(let i=0;i<a.at(-1);i++)n+=counts[offset+i];draw(a[0],n);return fn.apply(this,a);});
 const bytes=(data,offset=0,len=0)=>typeof data==='number'?data:data?.byteLength===undefined?0:(len||data.length-offset)*(data.BYTES_PER_ELEMENT||1);
 wrap(gl,'bufferData',function(fn,a){if(active){counters.bufferData++;counters.bufferDataBytes+=bytes(a[1],a[3],a[4]);}return fn.apply(this,a);});
 wrap(gl,'bufferSubData',function(fn,a){if(active){counters.bufferSubData++;counters.bufferSubDataBytes+=bytes(a[2],a[3],a[4]);}return fn.apply(this,a);});
 wrap(gl,'texSubImage2D',function(fn,a){if(active){counters.textureSubImageCalls++;if(ArrayBuffer.isView(a[8])){const channels=a[6]===gl.RGBA?4:a[6]===gl.RGB?3:a[6]===gl.RG?2:1;counters.textureSubImageBytes+=a[4]*a[5]*channels*a[8].BYTES_PER_ELEMENT;}}return fn.apply(this,a);});
 const update=(t,dt)=>{F.windTime.value=t;for(const node of F.nodes.values())for(const part of node.parts)F.applyPart(part,t);F.mapScene.update(t,dt,.9);F.fireflies.update(t,dt,.9,F.target.x,F.target.z);F.fx3d.update(dt*1000);};
 const step=(t,dt=0)=>{update(t,dt);R.shadowMap.needsUpdate=true;F.renderNow();};
 const memory=()=>{const arrays=new Set();let nodes=0,visible=0;const instances=[];F.scene.traverse(o=>{nodes++;if(o.visible)visible++;for(const a of [...Object.values(o.geometry?.attributes||{}),o.geometry?.index,o.instanceMatrix,o.instanceColor])if(a?.array)arrays.add(a.array);if(o.isInstancedMesh)instances.push({name:o.name,count:o.count,capacity:o.instanceMatrix.count,bytes:o.instanceMatrix.array.byteLength});});return {...R.info.memory,programs:R.info.programs.length,nodes,visible,geometryAndInstanceBytes:[...arrays].reduce((n,a)=>n+a.byteLength,0),instances};};
 for(let i=0;i<8;i++)step(2);reset();for(let i=0;i<20;i++)step(2);const frozen={...counters};reset();for(let i=0;i<30;i++)step(2+i/60,1/60);const moving={...counters};
 const result={frozen,moving,memory:memory(),frames:{frozen:20,moving:30},quality:F.quality,dpr:R.getPixelRatio(),gpu:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
 if(cache){cache.setEnabled(true);for(let i=0;i<8;i++)step(2);reset();for(let i=0;i<20;i++)step(2);result.optimizedFrozen={...counters};reset();for(let i=0;i<30;i++)step(2+i/60,1/60);result.optimizedMoving={...counters};result.optimizedMemory=memory();}
 for(const restore of undo.reverse())restore();
 if(cache){
  const screenshots={};
  const capture=name=>{R.shadowMap.needsUpdate=true;F.renderNow();screenshots[name]=F.canvas.toDataURL('image/png');};
  for(const phase of ['night','day','selection','effects']){
   F.nightFactor=F.nightFactorTarget=phase==='day'?0:.9;F.applyLook();F.fireflies.update(3,0,F.nightFactor,F.target.x,F.target.z);F.mapScene.update(3,0,F.nightFactor);
   if(phase==='selection')F.applySelection([...F.nodes.keys()][0]);
   if(phase==='effects'){F.applySelection(null);F.fx3d.spawnWaterSplash(new main.bk(F.target.x,1,F.target.z));F.fx3d.update(70);}
   cache.setEnabled(false);for(let i=0;i<3;i++){F.fireflies.update(3,0,F.nightFactor,F.target.x,F.target.z);F.renderNow();}
   capture(phase+'-before');capture(phase+'-control');cache.setEnabled(true);F.fireflies.update(3,0,F.nightFactor,F.target.x,F.target.z);capture(phase+'-after');capture(phase+'-after-control');
  }
  const decode=src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);resolve(ctx.getImageData(0,0,c.width,c.height).data);};img.onerror=reject;img.src=src;});
  const diff=(a,b)=>{let changed=0,over2=0,maxDelta=0;for(let i=0;i<a.length;i+=4){const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));if(d)changed++;if(d>2)over2++;maxDelta=Math.max(d,maxDelta);}return {pixels:a.length/4,changed,over2,maxDelta};};
  result.visuals={};for(const phase of ['night','day','selection','effects']){const p=await Promise.all(['before','control','after','after-control'].map(s=>decode(screenshots[phase+'-'+s])));result.visuals[phase]={control:diff(p[0],p[1]),change:diff(p[0],p[2]),optimizedControl:diff(p[2],p[3])};}
  result.screenshots=screenshots;
  F.fx3d.update(3000);F.nightFactor=F.nightFactorTarget=.9;F.applyLook();
  // Remove all operation wrappers before timing either arm.
  const arm=async(enabled,moving,time)=>{cache.setEnabled(enabled);step(time);const samples=[];for(let i=0;i<4;i++){await new Promise(requestAnimationFrame);const start=performance.now();step(time+(moving?i/60:0),moving?1/60:0);samples.push(performance.now()-start);}return samples;};
  result.timing={};for(const scenario of ['frozen','moving']){const pairs=[],nullPairs=[];for(let i=0;i<12;i++){const time=10+i;let before,after;if(i%2){after=await arm(true,scenario==='moving',time);before=await arm(false,scenario==='moving',time);}else{before=await arm(false,scenario==='moving',time);after=await arm(true,scenario==='moving',time);}pairs.push({before,after});nullPairs.push({before:await arm(true,scenario==='moving',time),after:await arm(true,scenario==='moving',time)});}result.timing[scenario]={pairs,nullPairs};}
  cache.setEnabled(true);result.correctness=await (await import('./performance-correctness.mjs')).runCorrectness(main,opt,F);
 }
 return result;
});
await cdp.send('Profiler.enable');await page.evaluate(()=>{window.__farmRenderer.setPaused(false);window.__farmRenderer.ensureLoop();});await cdp.send('Profiler.start');await page.waitForTimeout(4000);const {profile}=await cdp.send('Profiler.stop');await page.evaluate(()=>window.__farmRenderer.setPaused(true));
report.memoryCycles=[];
for(let cycle=0;cycle<3;cycle++){
 await page.evaluate(async()=>{const F=window.__farmRenderer;for(const tier of ['low','high']){F.applyLevel({tier,ratio:F.renderer.getPixelRatio()});await new Promise(r=>setTimeout(r,700));F.setPaused(true);F.fireflies.update(3,0,.9,F.target.x,F.target.z);F.renderNow();}});
 await cdp.send('HeapProfiler.collectGarbage');const heap=await cdp.send('Runtime.getHeapUsage');
 const gpu=await page.evaluate(()=>{const F=window.__farmRenderer;return {...F.renderer.info.memory,programs:F.renderer.info.programs.length,flies:F.fireflies.flies.length,instances:F.localFireflyBatch.mesh.count};});
 report.memoryCycles.push({cycle,heap,gpu});
}
const hits=new Map();for(let i=0;i<profile.samples.length;i++)hits.set(profile.samples[i],(hits.get(profile.samples[i])||0)+profile.timeDeltas[i]);report.cpu=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.split('/').at(-1),ms:(hits.get(n.id)||0)/1000})).sort((a,b)=>b.ms-a.ms).slice(0,25);report.errors=errors;report.passed=errors.length===0&&Object.values(report.visuals||{}).every(v=>v.control.over2===0&&v.change.over2===0&&v.optimizedControl.over2===0)&&report.optimizedFrozen.compose<report.frozen.compose&&report.optimizedFrozen.multiply<report.frozen.multiply&&report.optimizedFrozen.bufferSubData===0&&report.optimizedFrozen.draws===report.frozen.draws&&report.optimizedFrozen.triangles===report.frozen.triangles&&report.optimizedMemory.geometryAndInstanceBytes===report.memory.geometryAndInstanceBytes;const label='compare';for(const [name,url]of Object.entries(report.screenshots||{}))fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(url.split(',')[1],'base64'));delete report.screenshots;fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,label+'.cpuprofile'),JSON.stringify(profile));console.log(JSON.stringify({frozen:report.frozen,optimizedFrozen:report.optimizedFrozen,moving:report.moving,optimizedMoving:report.optimizedMoving,visuals:report.visuals,correctness:report.correctness,errors},null,2));assert.equal(report.passed,true);assert.deepEqual(errors,[]);for(const v of Object.values(report.visuals||{})){assert.equal(v.control.over2,0);assert.equal(v.change.over2,0);assert.equal(v.optimizedControl.over2,0);}
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
