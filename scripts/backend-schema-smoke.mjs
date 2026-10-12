import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../src/backend.mjs';
const require=createRequire(import.meta.url);
const {loadClientSchemas}=require('./client-schema.cjs');
const directory=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(directory,'../config/game.json'),'utf8'));
const {schemas}=loadClientSchemas(process.argv[2]);
// Only this disposable test instance advances to level 2 after one rice harvest.
config.bundle.levels.levels[1].cumExp=5;
const api=createBackend({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'xnt-schema-')),config,gameSpeed:30});
const errors=[];
function check(name,schema,value){const result=schema.safeParse(value);if(!result.success)errors.push({name,issues:JSON.parse(JSON.stringify(result.error.issues))});}
async function call(method,route,body={}){
  let response,status;
  const res={setHeader(){},writeHead(code){status=code;},end(value){response=JSON.parse(value)}};
  await api.handle({method,url:'/api'+route,headers:{}},res,'/api'+route,body);
  if(!response){errors.push({name:method+' '+route,error:'Backend did not produce a JSON response.'});return {};}
  if(status>=400){errors.push({name:method+' '+route,status,response});return response;}
  if(response.wallet)check(route+' wallet',schemas.sa,response.wallet);
  if(response.storage)check(route+' storage',schemas.Ea,response.storage);
  for(const object of response.objects||[])check(route+' object'+object.id,schemas.Ta,object);
  return response;
}
const initial=await call('GET','/world');check('GET world',schemas.wr,initial);
const me=await call('GET','/users/me');check('GET wallet',schemas.sa,me.wallet);
await call('GET','/storage');
const field=initial.objects.find(o=>o.kind==='field'),pen=initial.objects.find(o=>o.kind==='pen'),factory=initial.objects.find(o=>o.kind==='factory');
const harvest=await call('POST','/fields/harvest',{objIds:[field.id]});
if(!harvest.done?.includes(field.id))errors.push({name:'harvest.done',response:harvest});
await call('POST','/fields/plant',{items:[{objId:field.id,cropId:'lua'}]});
await call('POST',`/fields/${field.id}/fertilize`,{itemId:'phan_nhanh'});
await call('POST',`/pens/${pen.id}/buy-animal`,{animalDef:'ga'});
await call('POST',`/pens/${pen.id}/feed`,{});
await call('POST',`/factories/${factory.id}/enqueue`,{recipeId:'cam_ga'});
await call('POST','/shop/seeds/buy',{cropId:'lua',qty:2,currency:'gold'});
await call('POST','/storage/sell-npc',{itemId:'lua',qty:1});
await call('POST','/storage/kho/upgrade');
const quests=await call('GET','/quests');for(const quest of [...quests.main,...quests.daily])check('quest '+quest.id,schemas.ja,quest);
check('final world',schemas.wr,api.getWorld());
fs.writeFileSync(path.join(directory,'backend-schema-report.json'),JSON.stringify({errors},null,2));
console.log(JSON.stringify({checked:'world, wallet, storage, field harvest/plant/fertilizer, pen buy/feed, factory queue, seed buy, NPC sale, kho upgrade, all quest rows',errors},null,2));
if(errors.length)process.exitCode=1;
