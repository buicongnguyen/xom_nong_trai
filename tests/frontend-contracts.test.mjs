import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createBackend} from '../src/backend.mjs';

const require=createRequire(import.meta.url);
const {loadContracts}=require('./client-contracts.cjs');
const schemas=loadContracts();
const config=JSON.parse(fs.readFileSync(new URL('../config/game.json',import.meta.url),'utf8'));

function fixture(t,prepare=()=>{}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'xnt-ui-contract-'));
  const options={dataDir,config,gameSpeed:1};
  let api=createBackend(options);
  const initial=api.getState();
  prepare(initial);
  fs.writeFileSync(path.join(dataDir,'farm.json'),JSON.stringify(initial));
  api=createBackend(options);
  t.after(()=>{
    for(const name of ['farm.json','farm.json.tmp']){
      const file=path.join(dataDir,name);
      if(fs.existsSync(file))fs.unlinkSync(file);
    }
    fs.rmdirSync(dataDir);
  });
  async function request(route,body,method=body===undefined?'GET':'POST'){
    let status,data;
    const url='/api'+route;
    const handled=await api.handle({method,url},{setHeader(){},writeHead(value){status=value;},end(value){data=JSON.parse(value);}},new URL(url,'http://localhost').pathname,body||{});
    assert.equal(handled,true,`Missing endpoint ${method} ${route}`);
    return {status,data};
  }
  async function ok(route,body,method){
    const response=await request(route,body,method);
    assert.equal(response.status,200,`${method||'default'} ${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  return {request,ok,state:()=>api.getState(),reload:()=>{api=createBackend(options);}};
}

function compatible(name,data){
  const parsed=schemas[name].safeParse(data);
  assert.equal(parsed.success,true,`${name}: ${JSON.stringify(parsed.success?{}:parsed.error.issues)}`);
  return parsed.data;
}

test('changing home returns the direct Home schema consumed by the province picker',async t=>{
  const f=fixture(t);
  const selected=compatible('homePost',await f.ok('/home',{provinceId:'tp_ho_chi_minh',change:true}));
  assert.equal(selected.provinceId,'tp_ho_chi_minh');
  assert.equal(selected.skinRegion,'nam');
  f.reload();
  const restored=compatible('homeGet',await f.ok('/home'));
  assert.equal(restored.home.provinceId,'tp_ho_chi_minh');
  assert.equal((await f.ok('/world')).region,'nam');
});

test('seed purchase charges the currency sent by the original shop UI',async t=>{
  const f=fixture(t);
  const before=f.state();
  const seed=(await f.ok('/shop/seeds')).seeds.find(seed=>seed.cropId==='lua');
  const response=await f.ok('/shop/seeds/buy',{cropId:'lua',qty:2,currency:'xu'});
  assert.equal(response.wallet.gold,before.wallet.gold);
  assert.equal(response.wallet.xu,before.wallet.xu-seed.xuPrice*2);
  assert.equal(f.state().inventory.lua,before.inventory.lua+2);
});

test('disabled ads and dog progress use valid offline response schemas',async t=>{
  const f=fixture(t);
  const ads=compatible('ads',await f.ok('/ads/status'));
  assert.equal(ads.enabled,false);
  assert.equal(ads.provider,null);
  const dog=compatible('dog',await f.ok('/dog/progress'));
  assert.equal(dog.enabled,false);
});

test('earned title selection updates the profile and persists after reload',async t=>{
  const achievement=config.bundle.quests.achievements[0];
  const titleId=`${achievement.id}_1`;
  const f=fixture(t,state=>{state.claimedAchievements=[`${achievement.id}:1`];});
  const titles=compatible('titles',await f.ok('/titles'));
  assert.equal(titles.catalog.find(title=>title.id===titleId).owned,true);
  const changed=compatible('profilePatch',await f.ok('/users/me',{activeTitle:titleId},'PATCH'));
  assert.equal(changed.user.title,titleId);
  f.reload();
  assert.equal(compatible('me',await f.ok('/users/me')).user.title,titleId);
  assert.equal(compatible('titles',await f.ok('/titles')).active,titleId);
  const cleared=compatible('profilePatch',await f.ok('/users/me',{activeTitle:''},'PATCH'));
  assert.equal(cleared.user.title??'','');
  assert.equal(compatible('titles',await f.ok('/titles')).active,null);
});

test('profile title selection rejects a title that has not been earned',async t=>{
  const achievement=config.bundle.quests.achievements[0];
  const f=fixture(t);
  const response=await f.request('/users/me',{activeTitle:`${achievement.id}_1`},'PATCH');
  assert.ok(response.status>=400);
  assert.equal((await f.ok('/users/me')).user.title??'','');
  assert.equal((await f.ok('/titles')).active,null);
});

test('single-player and empty offline panels retain the original client response contracts',async t=>{
  const f=fixture(t);
  const endpoints={
    me:'/users/me',homeGet:'/home',map:'/map/national',province:'/map/provinces/ha_noi',
    storage:'/storage',shop:'/shop',seeds:'/shop/seeds',quests:'/quests',achievements:'/achievements',titles:'/titles',
    truck:'/orders/truck',boat:'/orders/boat',checkin:'/checkin',chests:'/chests',mailbox:'/mailbox',logs:'/logs',
    events:'/events',flags:'/flags',chat:'/chat/global/messages',chatSummary:'/chat/summary',dm:'/dm/threads',
    giftcode:'/giftcode/announcements',spotlight:'/leaderboards/spotlight',pass:'/pass/current',affiliate:'/affiliate/links',
  };
  for(const [name,route]of Object.entries(endpoints))compatible(name,await f.ok(route));
});

test('Vietnam map click identifiers resolve to named provinces and can become home',async t=>{
  const f=fixture(t);
  const response=await f.ok('/config');
  const canonical=response.bundle.provinces.provinces;
  const national=compatible('map',await f.ok('/map/national'));
  const examples=[['hung_yen','Hưng Yên','bac'],['hue','Huế','trung'],['can_tho','Cần Thơ','nam'],['tp_ho_chi_minh','TP. Hồ Chí Minh','nam']];
  for(const [id,name,region]of examples){
    assert.equal(canonical.find(province=>province.id===id)?.name,name);
    assert.equal(national.provinces.find(province=>province.id===id)?.name,name);
    const detail=compatible('province',await f.ok(`/map/provinces/${id}`));
    assert.equal(detail.name,name);
    const selected=compatible('homePost',await f.ok('/home',{provinceId:id,change:true}));
    assert.equal(selected.provinceId,id);
    assert.equal(selected.skinRegion,region);
  }
});

test('legacy saved home IDs migrate to the province IDs used by the map',async t=>{
  const f=fixture(t,state=>{state.home.provinceId='province_32';state.home.skinRegion='nam';state.region='nam';});
  assert.equal(compatible('homeGet',await f.ok('/home')).home.provinceId,'can_tho');
  const selected=compatible('homePost',await f.ok('/home',{provinceId:'ho_chi_minh',change:true}));
  assert.equal(selected.provinceId,'tp_ho_chi_minh');
  f.reload();
  assert.equal(compatible('homeGet',await f.ok('/home')).home.provinceId,'tp_ho_chi_minh');
});
