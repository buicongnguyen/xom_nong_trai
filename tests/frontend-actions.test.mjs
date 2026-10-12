import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'));
const start = Date.parse('2026-10-12T00:00:00.000Z');
const day = 86400000;
function farm(t, seed = () => {}) {
  const prefix = path.resolve(os.tmpdir(), 'xom-frontend-actions-');
  const dataDir = fs.mkdtempSync(prefix);
  let time = start;
  const options = { dataDir, config, gameSpeed: 1, wallTime: () => time, random: () => 0 };
  let backend = createBackend(options);
  const state = backend.getState();
  seed(state);
  fs.writeFileSync(path.join(dataDir, 'farm.json'), JSON.stringify(state));
  backend = createBackend(options);
  t.after(() => {
    const target = path.resolve(dataDir);
    assert.ok(target.startsWith(prefix));
    fs.rmSync(target, { recursive: true, force: true });
  });
  async function request(route, body = {}, method = 'POST') {
    let status, data;
    const url = `/api${route}`;
    const handled = await backend.handle({ url, method }, {
      setHeader() {}, writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); },
    }, new URL(url, 'http://localhost').pathname, body);
    assert.equal(handled, true, route);
    return { status, data };
  }
  async function ok(route, body, method) {
    const response = await request(route, body, method);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  return { request, ok, get: route => ok(route, {}, 'GET'), state: () => backend.getState(),
    advance: ms => { time += ms; }, reload: () => { backend = createBackend(options); },
    obj: id => backend.getState().objects.find(obj => obj.id === id) };
}
const level3 = state => { state.wallet.level = 3; state.wallet.exp = 200; };
const factory = f => f.state().objects.find(obj => obj.defId === 'may_cam');
const empty = f => f.state().objects.find(obj => obj.field?.state === 'EMPTY');
const price = worker => {
  const spec = config.bundle.gameConfig.factoryWorkers.hires[worker - 2];
  const cfg = config.bundle.gameConfig.factoryWorkers;
  return Math.ceil(Math.max(spec.minGold, spec.priceMult * config.bundle.buildings.buildings.find(obj => obj.id === 'may_cam').price) / cfg.roundTo) * cfg.roundTo;
};

test('worker hires use the client quote, seat order and level gates without charging rejected requests', async t => {
  const f = farm(t);
  const id = factory(f).id;
  const before = f.state();
  assert.equal((await f.request(`/factories/${id}/hire-worker`, { expectedGold: price(2) })).data.error.code, 'LEVEL_TOO_LOW');
  assert.deepEqual(f.state(), before);
  const high = farm(t, state => { state.wallet.level = 8; state.wallet.exp = 2450; });
  const highId = factory(high).id;
  const highBefore = high.state();
  assert.equal((await high.request(`/factories/${highId}/hire-worker`, { expectedGold: price(3), workerNo: 3 })).data.error.code, 'WORKER_ORDER');
  assert.equal((await high.request(`/factories/${highId}/hire-worker`, { expectedGold: price(2) - 1 })).data.error.code, 'PRICE_CHANGED');
  assert.deepEqual(high.state(), highBefore);
  const hired = await high.ok(`/factories/${highId}/hire-worker`, { expectedGold: price(2) });
  assert.equal(hired.wallet.gold, highBefore.wallet.gold - price(2));
  assert.equal(hired.objects[0].factory.workers, 2);
  assert.deepEqual(hired.objects[0].factory.hires, [{ no: 2, until: new Date(start + 7 * day).toISOString() }]);
  assert.equal(hired.workerNo, 2);
});

test('hiring a second worker starts a waiting batch while preserving the already running batch', async t => {
  const f = farm(t, level3);
  const id = factory(f).id;
  for (let i = 0; i < 3; i++) await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_ga' });
  const active = f.obj(id).factory.queue[0];
  await f.ok(`/factories/${id}/hire-worker`, { expectedGold: price(2) });
  const queue = f.obj(id).factory.queue;
  assert.deepEqual(queue[0], active);
  assert.equal(queue[1].w, 2);
  assert.equal(queue[1].startAt, active.startAt);
  assert.equal(queue[2].startAt, active.endAt);
  f.advance(20000);
  await f.get('/world');
  assert.deepEqual(f.obj(id).factory.output, [{ itemId: 'cam_ga', qty: 6 }]);
  f.reload();
  await f.get('/world');
  assert.deepEqual(f.obj(id).factory.output, [{ itemId: 'cam_ga', qty: 6 }]);
});

test('speeding up one parallel worker leaves the other worker timer unchanged', async t => {
  const f = farm(t, level3);
  const id = factory(f).id;
  await f.ok(`/factories/${id}/hire-worker`, { expectedGold: price(2) });
  await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_ga' });
  await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_bo' });
  const first = f.obj(id).factory.queue[0];
  const quote = await f.get(`/speed-up/quote?objId=${id}&jobIndex=1`);
  await f.ok('/speed-up', { target: { objId: id, jobIndex: 1 }, expectedXu: quote.xuCost });
  assert.deepEqual(f.obj(id).factory.queue[0], first);
  assert.deepEqual(f.obj(id).factory.output, [{ itemId: 'cam_bo', qty: 3 }]);
});

test('worker renewal is limited to two prepaid periods and expiration restores one worker', async t => {
  const f = farm(t, level3);
  const id = factory(f).id;
  await f.ok(`/factories/${id}/hire-worker`, { expectedGold: price(2) });
  await f.ok(`/factories/${id}/hire-worker`, { expectedGold: price(2), workerNo: 2 });
  assert.equal(Date.parse(f.obj(id).factory.hires[0].until), start + 14 * day);
  const before = f.state();
  assert.equal((await f.request(`/factories/${id}/hire-worker`, { expectedGold: price(2), workerNo: 2 })).data.error.code, 'RENEW_TOO_EARLY');
  assert.deepEqual(f.state(), before);
  f.reload();
  f.advance(14 * day);
  await f.get('/world');
  assert.equal(f.obj(id).factory.workers, 1);
  await f.ok(`/factories/${id}/hire-worker`, { expectedGold: price(2) });
  assert.equal(f.obj(id).factory.workers, 2);
  assert.equal(f.obj(id).factory.hires.length, 1, 'rehiring reuses the same seat record');
  assert.equal(Date.parse(f.obj(id).factory.hires[0].until), start + 21 * day);
});

test('an expired worker finishes an active batch but receives no new batch', async t => {
  const f = farm(t, state => {
    level3(state);
    state.objects.find(obj => obj.defId === 'may_cam').factory.hires = [{ no: 2, until: new Date(start + 10000).toISOString() }];
  });
  const id = factory(f).id;
  await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_ga' });
  await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_ga' });
  f.advance(12000);
  await f.ok(`/factories/${id}/enqueue`, { recipeId: 'cam_ga' });
  const queue = f.obj(id).factory.queue;
  assert.equal(f.obj(id).factory.workers, 1);
  assert.equal(queue[1].w, 2, 'the active expired job keeps its worker');
  assert.equal(queue[2].w, 1);
  assert.equal(Date.parse(queue[2].startAt), start + 20000);
  f.advance(8000);
  await f.get('/world');
  assert.deepEqual(f.obj(id).factory.output, [{ itemId: 'cam_ga', qty: 6 }]);
});

test('uproot discards a growing crop without refunding seeds or soil upgrades', async t => {
  const f = farm(t, state => { state.objects.find(obj => obj.field?.state === 'EMPTY').field.soilTier = 2; });
  const id = empty(f).id;
  await f.ok('/fields/plant', { items: [{ objId: id, cropId: 'lua' }] });
  const before = f.state();
  await f.ok(`/fields/${id}/uproot`);
  assert.deepEqual(f.state().inventory, before.inventory);
  assert.deepEqual(f.state().wallet, before.wallet);
  assert.equal(f.obj(id).field.state, 'EMPTY');
  assert.equal(f.obj(id).field.soilTier, 2);
  assert.equal(f.obj(id).field.cycleNo, 1);
  const after = f.state();
  assert.equal((await f.request(`/fields/${id}/uproot`)).data.error.code, 'NOT_GROWING');
  assert.deepEqual(f.state(), after);
});

test('daily reroll costs Xu, returns one fresh distinct quest and can be used once per slot', async t => {
  const f = farm(t);
  const initial = await f.get('/quests');
  const xu = f.state().wallet.xu;
  const changed = await f.ok('/quests/daily/reroll', { questId: initial.daily[0].id });
  assert.equal(changed.wallet.xu, xu - config.bundle.gameConfig.quests.dailyRerollXu);
  assert.equal(changed.quest.id, 'd_feed_animal');
  assert.equal(changed.quest.rerolled, true);
  assert.equal(changed.quest.progress, 0);
  const daily = (await f.get('/quests')).daily;
  assert.equal(daily.length, config.bundle.gameConfig.quests.dailyPick);
  assert.equal(new Set(daily.map(quest => quest.id)).size, daily.length);
  assert.ok(!daily.some(quest => quest.id === initial.daily[0].id));
  const before = f.state();
  assert.equal((await f.request('/quests/daily/reroll', { questId: changed.quest.id })).data.error.code, 'CANNOT_REROLL');
  assert.deepEqual(f.state(), before);
  f.reload();
  assert.equal((await f.get('/quests')).daily[0].rerolled, true);
});

test('daily reroll rejects completed quests and missing funds without replacing the quest', async t => {
  const f = farm(t);
  await f.get('/quests');
  for (const id of f.state().objects.filter(obj => obj.field?.state === 'EMPTY').map(obj => obj.id)) {
    await f.ok('/fields/plant', { items: [{ objId: id, cropId: 'lua' }] });
  }
  const ripe = f.state().objects.find(obj => obj.field?.state === 'MATURE');
  await f.ok('/fields/harvest', { objIds: [ripe.id] });
  await f.ok('/fields/plant', { items: [{ objId: ripe.id, cropId: 'lua' }] });
  const before = f.state();
  assert.equal((await f.request('/quests/daily/reroll', { questId: 'd_plant' })).data.error.code, 'CANNOT_REROLL');
  assert.deepEqual(f.state(), before);
  const poor = farm(t, state => { state.wallet.xu = 0; });
  await poor.get('/quests');
  const poorBefore = poor.state();
  assert.equal((await poor.request('/quests/daily/reroll', { questId: 'd_plant' })).data.error.code, 'NOT_ENOUGH_XU');
  assert.deepEqual(poor.state(), poorBefore);
});

test('a new Vietnam calendar day resets daily reroll availability', async t => {
  const f = farm(t);
  await f.get('/quests');
  await f.ok('/quests/daily/reroll', { questId: 'd_plant' });
  f.advance(day);
  const fresh = await f.get('/quests');
  assert.deepEqual(fresh.daily.map(quest => quest.id), config.bundle.quests.dailyPool.slice(0, 5).map(quest => quest.id));
  assert.ok(fresh.daily.every(quest => !quest.rerolled && quest.progress === 0 && !quest.claimedAt));
  await f.ok('/quests/daily/reroll', { questId: 'd_plant' });
});

test('peaceful mode returns the raw home contract and persists a strictly boolean setting', async t => {
  const f = farm(t);
  const beforeWallet = f.state().wallet;
  const result = await f.ok('/home/peaceful', { enabled: true });
  assert.equal(result.peacefulMode, true);
  assert.equal(typeof result.provinceId, 'string');
  assert.equal(result.home, undefined);
  assert.deepEqual(f.state().wallet, beforeWallet);
  f.reload();
  assert.equal((await f.get('/home')).home.peacefulMode, true);
  const before = f.state();
  assert.equal((await f.request('/home/peaceful', { enabled: 'false' })).status, 400);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.ok('/home/peaceful', { enabled: false })).peacefulMode, false);
});
