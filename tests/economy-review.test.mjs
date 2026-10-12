import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'));
const startTime = Date.parse('2026-10-12T00:00:00.000Z');

function farm(t, edit = () => {}) {
  const prefix = path.resolve(os.tmpdir(), 'xom-economy-review-');
  const dataDir = fs.mkdtempSync(prefix);
  let wall = startTime;
  const options = { dataDir, config, gameSpeed: 1, wallTime: () => wall, random: () => 0 };
  let backend = createBackend(options);
  const seeded = backend.getState();
  edit(seeded);
  fs.writeFileSync(path.join(dataDir, 'farm.json'), JSON.stringify(seeded));
  backend = createBackend(options);
  t.after(() => {
    const target = path.resolve(dataDir);
    assert.ok(target.startsWith(prefix), 'cleanup remains in the dedicated temporary test directory');
    fs.rmSync(target, { recursive: true, force: true });
  });
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    let status, data;
    const url = `/api${route}`;
    const handled = await backend.handle({ url, method }, {
      setHeader() {}, writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); },
    }, new URL(url, 'http://localhost').pathname, body || {});
    assert.equal(handled, true, `implemented route ${route}`);
    return { status, data };
  }
  async function ok(route, body, method) {
    const response = await request(route, body, method);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  return {
    request, ok, state: () => backend.getState(),
    advance: ms => { wall += ms; },
    reload: () => { backend = createBackend(options); },
    object: id => backend.getState().objects.find(obj => obj.id === id),
  };
}
const level2 = state => { state.wallet.level = 2; state.wallet.exp = 50; };
const freeLand = state => { state.objects = state.objects.filter(obj => obj.kind !== 'obstacle'); };
const field = f => f.state().objects.find(obj => obj.field?.state === 'EMPTY');
const factory = f => f.state().objects.find(obj => obj.defId === 'may_cam');
async function enqueue(f, count) {
  const obj = factory(f);
  for (let i = 0; i < count; i++) await f.ok(`/factories/${obj.id}/enqueue`, { recipeId: 'cam_ga' });
  return obj;
}

test('healthy fields cannot create XP or gold through repeated care', async t => {
  const f = farm(t);
  const obj = field(f);
  const before = f.state();
  for (const type of ['dry', 'weed', 'pest', 'invalid']) {
    const result = await f.request(`/fields/${obj.id}/care`, { type });
    assert.equal(result.status, 400);
  }
  assert.deepEqual(f.state(), before);
});

test('repairing a real crop problem consumes its tool and awards XP once', async t => {
  const f = farm(t, state => {
    const obj = state.objects.find(obj => obj.field?.state === 'EMPTY');
    obj.field.problems = [{ type: 'dry', source: 'natural', at: new Date(startTime).toISOString() }];
  });
  const obj = field(f);
  const before = f.state();
  await f.ok(`/fields/${obj.id}/care`, { type: 'dry' });
  assert.equal(f.state().inventory.xeng, before.inventory.xeng - 1);
  assert.equal(f.state().wallet.exp, before.wallet.exp + config.bundle.gameConfig.exp.fixProblem);
  assert.equal(f.state().counters.FIX_PROBLEM, 1);
  assert.deepEqual(f.object(obj.id).field.problems, []);
  const after = f.state();
  assert.equal((await f.request(`/fields/${obj.id}/care`, { type: 'dry' })).status, 400);
  assert.deepEqual(f.state(), after);
});

test('cancelling a waiting middle job refunds its ingredients and removes idle time', async t => {
  const f = farm(t, level2);
  const beforeIngredients = f.state().inventory;
  const obj = await enqueue(f, 3);
  await f.ok(`/factories/${obj.id}/cancel`, { jobIndex: 1 });
  const queue = f.object(obj.id).factory.queue;
  assert.equal(queue.length, 2);
  assert.equal(Date.parse(queue[1].startAt), startTime + 20000);
  assert.equal(Date.parse(queue[1].endAt), startTime + 40000);
  assert.equal(f.state().inventory.lua, beforeIngredients.lua - 4);
  assert.equal(f.state().inventory.ngo, beforeIngredients.ngo - 2);
  f.advance(40000);
  await f.ok('/world');
  assert.deepEqual(f.object(obj.id).factory.queue, []);
  assert.deepEqual(f.object(obj.id).factory.output, [{ itemId: 'cam_ga', qty: 6 }]);
  f.reload();
  await f.ok('/world');
  assert.deepEqual(f.object(obj.id).factory.output, [{ itemId: 'cam_ga', qty: 6 }], 'reload cannot duplicate completed batches');
});

test('a running production job cannot be cancelled for a full refund', async t => {
  const f = farm(t, level2);
  const obj = await enqueue(f, 1);
  const before = f.state();
  const result = await f.request(`/factories/${obj.id}/cancel`, { jobIndex: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'JOB_STARTED');
  assert.deepEqual(f.state(), before);
});

test('speeding up a waiting batch preserves the dependency on its preceding batch', async t => {
  const f = farm(t, level2);
  const obj = await enqueue(f, 2);
  const xu = f.state().wallet.xu;
  const quote = await f.ok(`/speed-up/quote?objId=${obj.id}&jobIndex=1`);
  await f.ok('/speed-up', { target: { objId: obj.id, jobIndex: 1 }, expectedXu: quote.xuCost });
  assert.equal(f.state().wallet.xu, xu - quote.xuCost);
  assert.deepEqual(f.object(obj.id).factory.output, [], 'waiting output cannot appear before the active batch completes');
  const queue = f.object(obj.id).factory.queue;
  assert.equal(Date.parse(queue[1].endAt), Date.parse(queue[1].startAt));
  f.advance(20000);
  await f.ok('/world');
  assert.deepEqual(f.object(obj.id).factory.output, [{ itemId: 'cam_ga', qty: 6 }]);
});

test('coop ownership limits are enforced before charging for a third coop', async t => {
  const f = farm(t, state => { level2(state); freeLand(state); });
  await f.ok('/world/place', { defId: 'chuong_ga', x: 34, y: 34, rot: 0 });
  const before = f.state();
  const result = await f.request('/world/place', { defId: 'chuong_ga', x: 28, y: 34, rot: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.data.error.code, 'MAX_OBJECTS');
  assert.deepEqual(f.state(), before);
  const entry = (await f.ok('/shop')).tabs.pens.find(def => def.defId === 'chuong_ga');
  assert.equal(entry.owned, entry.max);
});

test('factory construction obeys the concurrent limit and frees the slot after completion', async t => {
  const f = farm(t, state => { state.wallet.level = 5; state.wallet.exp = 800; freeLand(state); });
  const first = await f.ok('/world/place', { defId: 'nha_xay_xat', x: 34, y: 34, rot: 0 });
  const before = f.state();
  const second = { defId: 'lo_duong', x: 28, y: 34, rot: 0 };
  const blocked = await f.request('/world/place', second);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.error.code, 'CONSTRUCTION_LIMIT');
  assert.deepEqual(f.state(), before);
  f.advance(Date.parse(first.objects[0].construction.endsAt) - startTime);
  await f.ok('/world/place', second);
  assert.equal(f.state().objects.filter(obj => obj.construction).length, config.bundle.gameConfig.construction.maxConcurrent);
});

test('quick fertilizer reduces only the remaining current stage within the configured cap', async t => {
  const f = farm(t);
  const first = field(f);
  await f.ok('/fields/plant', { items: [{ objId: first.id, cropId: 'lua' }] });
  await f.ok(`/fields/${first.id}/fertilize`, { itemId: 'phan_nhanh' });
  const firstCrop = f.object(first.id).field;
  assert.equal(Date.parse(firstCrop.stageEndsAt), startTime + 2000);
  assert.equal(Date.parse(firstCrop.matureAt), startTime + 22000);
  const second = field(f);
  await f.ok('/fields/plant', { items: [{ objId: second.id, cropId: 'lua' }] });
  f.advance(15000);
  await f.ok(`/fields/${second.id}/fertilize`, { itemId: 'phan_nhanh' });
  const secondCrop = f.object(second.id).field;
  assert.equal(secondCrop.stage, 1);
  assert.equal(Date.parse(secondCrop.stageEndsAt), startTime + 16000);
  assert.equal(Date.parse(secondCrop.matureAt), startTime + 26000);
  const after = f.state();
  assert.equal((await f.request(`/fields/${second.id}/fertilize`, { itemId: 'phan_nhanh' })).data.error.code, 'ALREADY_FERTILIZED');
  assert.deepEqual(f.state(), after);
});

test('instant fertilizer makes a crop ready and harvest remains limited to one payout', async t => {
  const f = farm(t, state => { state.inventory.phan_sieu_toc = 1; });
  const obj = field(f);
  await f.ok('/fields/plant', { items: [{ objId: obj.id, cropId: 'lua' }] });
  await f.ok(`/fields/${obj.id}/fertilize`, { itemId: 'phan_sieu_toc' });
  assert.equal(f.object(obj.id).field.state, 'MATURE');
  assert.equal(f.state().inventory.phan_sieu_toc, 0);
  await f.ok('/fields/harvest', { objIds: [obj.id] });
  const after = f.state().inventory.lua;
  await f.ok('/fields/harvest', { objIds: [obj.id] });
  assert.equal(f.state().inventory.lua, after);
});

test('upgraded soil affects both crop duration and harvest yield', async t => {
  const f = farm(t, state => { state.objects.find(obj => obj.field?.state === 'EMPTY').field.soilTier = 2; });
  const obj = field(f);
  const crop = config.bundle.crops.crops.find(crop => crop.id === 'lua');
  const soil = config.bundle.gameConfig.soil[2];
  const inventory = f.state().inventory.lua;
  await f.ok('/fields/plant', { items: [{ objId: obj.id, cropId: crop.id }] });
  assert.equal(Date.parse(f.object(obj.id).field.matureAt) - startTime, crop.growSeconds * soil.timeMul * 1000);
  f.advance(crop.growSeconds * soil.timeMul * 1000);
  await f.ok('/fields/harvest', { objIds: [obj.id] });
  assert.equal(f.state().inventory.lua, inventory - crop.sowCost + Math.floor(crop.yieldPerField * soil.yieldMul));
});

test('decor XP is granted at purchase and cannot be repeated through bag placement', async t => {
  const f = farm(t);
  const def = config.bundle.objects.objects.find(def => def.id === 'bu_nhin');
  await f.ok('/shop/decor/buy', { defId: def.id, qty: 2 });
  assert.equal(f.state().wallet.exp, 2 * def.expOnBuy);
  await f.ok('/world/place', { defId: def.id, from: 'bag', x: 34, y: 34, rot: 0 });
  assert.equal(f.state().wallet.exp, 2 * def.expOnBuy);
  await f.ok('/world/place', { defId: def.id, x: 35, y: 34, rot: 0 });
  assert.equal(f.state().wallet.exp, 3 * def.expOnBuy);
});

test('buying a field and feeding an animal award configured XP and quest events', async t => {
  const f = farm(t, level2);
  const before = f.state().wallet.exp;
  await f.ok('/fields/buy', { x: 34, y: 34, rot: 0 });
  assert.equal(f.state().wallet.exp, before + config.bundle.gameConfig.exp.buyField);
  assert.equal(f.state().counters.BUY_FIELD, 1);
  assert.equal((await f.ok('/quests')).daily.find(quest => quest.id === 'd_buy_field').progress, 1);
  const pen = f.state().objects.find(obj => obj.defId === 'chuong_ga');
  await f.ok(`/pens/${pen.id}/buy-animal`, { animalDef: 'ga' });
  const animalId = f.object(pen.id).pen.animals[0].id;
  const exp = f.state().wallet.exp;
  await f.ok(`/pens/${pen.id}/feed`, { animalIds: [animalId] });
  assert.equal(f.state().wallet.exp, exp + config.bundle.gameConfig.exp.feed);
});

test('layout swaps are atomic and invalid rotations or collisions roll back all moves', async t => {
  const f = farm(t);
  const [a, b] = f.state().objects.filter(obj => obj.field?.state === 'EMPTY').slice(0, 2);
  await f.ok('/world/layout', { changes: [
    { objId: a.id, x: b.x, y: b.y, rot: 0 }, { objId: b.id, x: a.x, y: a.y, rot: 0 },
  ] });
  assert.deepEqual([f.object(a.id).x, f.object(b.id).x], [b.x, a.x]);
  const before = f.state();
  for (const change of [{ objId: a.id, x: 34, y: 34, rot: 2 }, { objId: a.id, x: a.x, y: a.y, rot: 0 }]) {
    assert.equal((await f.request('/world/layout', { changes: [change] })).status, 400);
    assert.deepEqual(f.state(), before);
  }
  const badPlace = await f.request('/world/place', { defId: 'bu_nhin', x: 34, y: 34, rot: 2 });
  assert.equal(badPlace.status, 400);
  assert.deepEqual(f.state(), before);
});

test('wrong methods and failing batches cannot partially change the farm or its saved state', async t => {
  const f = farm(t);
  const national = await f.ok('/map/national');
  assert.equal(national.provinces.length, config.bundle.provinces.provinces.length);
  const provinceId = national.provinces[0].id;
  assert.equal((await f.ok(`/map/provinces/${provinceId}`)).id, provinceId);
  const ripe = f.state().objects.find(obj => obj.field?.state === 'MATURE');
  const before = f.state();
  const wrongMethod = await f.request('/fields/harvest', { objIds: [ripe.id, 999999] }, 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(f.state(), before);
  const badBatch = await f.request('/fields/harvest', { objIds: [ripe.id, 999999] });
  assert.equal(badBatch.status, 404);
  assert.deepEqual(f.state(), before);
  f.reload();
  assert.deepEqual(f.state(), before);
  const full = farm(t, state => { state.inventory = { lua: config.bundle.storage.ham.capacity.start }; });
  const fullBefore = full.state();
  const fullRipe = fullBefore.objects.find(obj => obj.field?.state === 'MATURE');
  const cannotHarvest = await full.request('/fields/harvest', { objIds: [fullRipe.id] });
  assert.equal(cannotHarvest.data.error.code, 'STORAGE_FULL');
  assert.deepEqual(full.state(), fullBefore, 'full storage preserves the crop, XP and inventory');
  const cannotBuy = await full.request('/shop/seeds/buy', { cropId: 'lua', qty: 1, pay: 'gold' });
  assert.equal(cannotBuy.data.error.code, 'STORAGE_FULL');
  assert.deepEqual(full.state(), fullBefore, 'full storage also refunds the attempted purchase');
});
