import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const sourceConfig = JSON.parse(fs.readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'));
const start = Date.parse('2026-10-13T00:00:00.000Z');
function farm(t, seed = () => {}, configure = () => {}) {
  const config = structuredClone(sourceConfig);
  configure(config);
  const prefix = path.resolve(os.tmpdir(), 'xom-dog-seeds-');
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
  return { config, request, ok, get: route => ok(route, {}, 'GET'), state: () => backend.getState(),
    advance: ms => { time += ms; }, reload: () => { backend = createBackend(options); } };
}

test('feeding a purchased dog consumes food, persists the guard timer and expires after an hour', async t => {
  const f = farm(t, state => { state.inventory.xuong_gam = 2; });
  await f.ok('/shop/dogs/buy', { dogId: 'dog_local' });
  assert.equal(f.state().dog.active, false);
  const before = f.state();
  const result = await f.ok('/dog/feed', { qty: 1 });
  assert.equal(result.dog.active, true);
  assert.equal(result.dog.foodStackSeconds, f.config.bundle.gameConfig.dogRules.foodSeconds);
  assert.equal(Date.parse(result.dog.fedUntil), start + 3600000);
  assert.equal(f.state().inventory.xuong_gam, before.inventory.xuong_gam - 1);
  assert.deepEqual(f.state().wallet, before.wallet);
  f.reload();
  assert.equal((await f.get('/world')).dog.active, true);
  f.advance(3601000);
  const expired = (await f.get('/world')).dog;
  assert.equal(expired.active, false);
  assert.equal(expired.foodStackSeconds, 0);
});

test('dog food adds to the remaining timer and the stack limit rejects an entire oversized feed', async t => {
  const f = farm(t, state => { state.inventory.xuong_gam = 30; });
  await f.ok('/shop/dogs/buy', { dogId: 'dog_local' });
  await f.ok('/dog/feed', { qty: 1 });
  f.advance(1800000);
  await f.ok('/dog/feed', { qty: 1 });
  assert.equal(f.state().dog.foodStackSeconds, 5400);
  assert.equal(Date.parse(f.state().dog.fedUntil), start + 7200000);
  const before = f.state();
  const tooMuch = await f.request('/dog/feed', { qty: 24 });
  assert.equal(tooMuch.status, 400);
  assert.deepEqual(f.state(), before, 'a feed over the cap consumes no food and does not extend the timer');
});

test('dog feeding rejects missing ownership or insufficient food without charging anything', async t => {
  const f = farm(t);
  const before = f.state();
  assert.equal((await f.request('/dog/feed', { qty: 1 })).status, 404);
  assert.deepEqual(f.state(), before);
  await f.ok('/shop/dogs/buy', { dogId: 'dog_local' });
  const bought = f.state();
  assert.equal((await f.request('/dog/feed', { qty: 1 })).status, 400);
  assert.deepEqual(f.state(), bought);
});

test('seed purchases honor the frontend currency and configured maximum of 999 units', async t => {
  const f = farm(t, state => {
    state.wallet.gold = 20000;
    state.wallet.xu = 1500;
    state.storageLevels.ham = 40;
  });
  const before = f.state();
  const qty = f.config.bundle.gameConfig.seedShop.maxBuyQtyPerRequest;
  assert.equal(qty, 999);
  const quote = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  await f.ok('/shop/seeds/buy', { cropId: 'lua', qty, currency: 'xu' });
  assert.equal(f.state().inventory.lua, before.inventory.lua + qty);
  assert.equal(f.state().wallet.gold, before.wallet.gold);
  assert.equal(f.state().wallet.xu, before.wallet.xu - quote.xuPrice * qty);
  const limits = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(limits.xuDailyRemaining, f.config.bundle.gameConfig.seedShop.xuDailyUnitLimitPerCrop - qty);
  const after = f.state();
  assert.equal((await f.request('/shop/seeds/buy', { cropId: 'lua', qty: qty + 1, currency: 'xu' })).status, 400);
  assert.deepEqual(f.state(), after);
});

test('seed daily budgets are independent per currency, persisted and reset on the real Vietnam day', async t => {
  const f = farm(t, state => { state.wallet.gold = 3000; }, config => {
    config.bundle.gameConfig.seedShop.goldDailyUnitLimitPerCrop = 2;
    config.bundle.gameConfig.seedShop.xuDailyUnitLimitPerCrop = 2;
  });
  const quote = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(quote.goldDailyRemaining, 2);
  assert.equal(quote.xuDailyRemaining, 2);
  await f.ok('/shop/seeds/buy', { cropId: 'lua', qty: 2, currency: 'gold' });
  const limits = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(limits.goldDailyRemaining, 0);
  assert.equal(limits.xuDailyRemaining, 2);
  const before = f.state();
  assert.equal((await f.request('/shop/seeds/buy', { cropId: 'lua', qty: 1, currency: 'gold' })).status, 400);
  assert.deepEqual(f.state(), before);
  await f.ok('/shop/seeds/buy', { cropId: 'lua', qty: 2, currency: 'xu' });
  f.reload();
  const used = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(used.goldDailyRemaining, 0);
  assert.equal(used.xuDailyRemaining, 0);
  f.advance(86400000);
  const fresh = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(fresh.goldDailyRemaining, 2);
  assert.equal(fresh.xuDailyRemaining, 2);
  await f.ok('/shop/seeds/buy', { cropId: 'lua', qty: 1, currency: 'gold' });
});

test('failed seed storage insertion does not consume currency or daily purchase allowance', async t => {
  const f = farm(t, state => { state.inventory = { lua: sourceConfig.bundle.storage.ham.capacity.start }; });
  await f.get('/shop/seeds');
  const before = f.state();
  const response = await f.request('/shop/seeds/buy', { cropId: 'lua', qty: 1, currency: 'gold' });
  assert.equal(response.data.error.code, 'STORAGE_FULL');
  assert.deepEqual(f.state(), before);
  const quote = (await f.get('/shop/seeds')).seeds.find(seed => seed.cropId === 'lua');
  assert.equal(quote.goldDailyRemaining, f.config.bundle.gameConfig.seedShop.goldDailyUnitLimitPerCrop);
});
