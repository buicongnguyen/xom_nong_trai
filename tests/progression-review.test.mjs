import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const sourceConfig = JSON.parse(fs.readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'));

function fixture(t, { configure = () => {}, prepare = () => {}, random = () => 0.5 } = {}) {
  const config = structuredClone(sourceConfig);
  configure(config);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xom-progress-review-'));
  let wall = Date.parse('2026-10-12T03:00:00Z');
  const options = { dataDir, config, gameSpeed: 1, wallTime: () => wall, random };
  let backend = createBackend(options);
  const initial = backend.getState();
  prepare(initial, config);
  fs.writeFileSync(path.join(dataDir, 'farm.json'), JSON.stringify(initial));
  backend = createBackend(options);
  t.after(() => {
    for (const name of ['farm.json', 'farm.json.tmp']) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dataDir);
  });
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    let status, data;
    const url = '/api' + route;
    const handled = await backend.handle({ url, method }, {
      setHeader() {}, writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); },
    }, new URL(url, 'http://localhost').pathname, body || {});
    assert.equal(handled, true, `Expected supported route ${route}`);
    return { status, data };
  }
  async function ok(route, body, method) {
    const response = await request(route, body, method);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  return {
    config, request, ok,
    state: () => backend.getState(),
    advance: milliseconds => { wall += milliseconds; },
    quest: async id => {
      const quests = await ok('/quests');
      return [...quests.main, ...quests.daily].find(quest => quest.id === id);
    },
  };
}

test('buying a field completes and rewards the first expansion quest', async t => {
  const f = fixture(t, { prepare: state => { state.claimedQuests = ['m01', 'm02']; } });
  await f.ok('/fields/buy', { x: 34, y: 34 });
  const quest = await f.quest('m03');
  assert.equal(quest.progress, quest.count);
  assert.equal(quest.locked, false);
  const balance = f.state().wallet.gold;
  await f.ok('/quests/m03/claim', {});
  assert.equal(f.state().wallet.gold, balance + quest.reward.gold);
});

test('starting and collecting factory jobs updates the production quests', async t => {
  const f = fixture(t, { prepare: state => { state.wallet.level = 2; state.wallet.exp = 50; } });
  const factory = f.state().objects.find(object => object.defId === 'may_cam');
  const recipe = f.config.bundle.recipes.recipes.find(recipe => recipe.id === 'cam_ga');
  await f.ok(`/factories/${factory.id}/enqueue`, { recipeId: recipe.id });
  assert.equal((await f.quest('m08')).progress, 1);
  f.advance(recipe.seconds * 1000 + 1);
  await f.ok(`/factories/${factory.id}/collect`, {});
  assert.equal((await f.quest('m09')).progress, 1);
  assert.equal(f.state().inventory[recipe.id], f.config.bundle.gameConfig.startingState.items[recipe.id] + recipe.outputQty);
});

test('tutorial construction requires the requested building rather than any placement', async t => {
  const f = fixture(t, { prepare: state => {
    state.user.tutorialStep = 10;
    state.wallet.level = 3;
    state.wallet.exp = 200;
  } });
  await f.ok('/fields/buy', { x: 34, y: 34 });
  assert.equal(f.state().user.tutorialStep, 10);
  await f.ok('/world/place', { defId: 'nha_xay_xat', from: 'shop', x: 38, y: 38, rot: 0 });
  assert.equal(f.state().user.tutorialStep, 11);
});

test('tutorial fertilized harvest rejects an unrelated mature field', async t => {
  const f = fixture(t, { prepare: state => { state.user.tutorialStep = 3; } });
  const field = f.state().objects.find(object => object.field?.state === 'MATURE');
  await f.ok('/fields/harvest', { objIds: [field.id] });
  assert.equal(f.state().user.tutorialStep, 3);
  await f.ok('/fields/plant', { items: [{ objId: field.id, cropId: 'lua' }] });
  await f.ok(`/fields/${field.id}/fertilize`, { itemId: 'phan_nhanh' });
  f.advance(31_000);
  await f.ok('/fields/harvest', { objIds: [field.id] });
  assert.equal(f.state().user.tutorialStep, 4);
});

test('tutorial actions performed below the tutorial level do not advance', async t => {
  const f = fixture(t, { prepare: state => { state.user.tutorialStep = 17; } });
  const dog = f.config.bundle.gameConfig.dogs.find(dog => dog.unlockLevel === 1);
  await f.ok('/shop/dogs/buy', { dogId: dog.id });
  assert.equal(f.state().wallet.level, 1);
  assert.equal(f.state().user.tutorialStep, 17);
});

test('single-player tutorial skips unavailable neighbor steps without deleting later indices', async t => {
  const f = fixture(t, { prepare: state => {
    state.user.tutorialStep = 12;
    state.wallet.level = 3;
    state.wallet.exp = 200;
  } });
  const profile = await f.ok('/users/me');
  assert.equal(profile.user.tutorialStep, 14);
  assert.equal(f.state().user.tutorialStep, 14);
});

test('daily quest progress and claims reset on a new Vietnam day while main progress persists', async t => {
  const f = fixture(t, {
    configure: config => {
      config.bundle.quests.dailyPool = [config.bundle.quests.dailyPool.find(quest => quest.goal.event === 'PLANT')];
      config.bundle.quests.dailyPick = 1;
    },
  });
  const fields = f.state().objects.filter(object => object.field?.state === 'EMPTY').slice(0, 2);
  await f.ok('/fields/plant', { items: fields.map(field => ({ objId: field.id, cropId: 'lua' })) });
  f.advance(31_000);
  await f.ok('/fields/harvest', { objIds: fields.map(field => field.id) });
  await f.ok('/fields/plant', { items: fields.map(field => ({ objId: field.id, cropId: 'lua' })) });
  f.advance(31_000);
  await f.ok('/fields/harvest', { objIds: fields.map(field => field.id) });
  await f.ok('/fields/plant', { items: fields.map(field => ({ objId: field.id, cropId: 'lua' })) });
  const daily = (await f.ok('/quests')).daily[0];
  assert.equal(daily.progress, daily.count);
  await f.ok(`/quests/${daily.id}/claim`, {});
  assert.ok((await f.quest(daily.id)).claimedAt);
  const mainProgress = (await f.quest('m01')).progress;
  f.advance(24 * 60 * 60 * 1000);
  const reset = await f.quest(daily.id);
  assert.equal(reset.progress, 0);
  assert.equal(reset.claimedAt, null);
  assert.equal((await f.quest('m01')).progress, mainProgress);
});

test('crop problems appear and valid care completes the care quest once', async t => {
  const f = fixture(t, {
    random: () => 0,
    configure: config => {
      const crop = config.bundle.crops.crops.find(crop => crop.id === 'ngo');
      crop.growSeconds = 120;
      const rules = config.bundle.gameConfig.problems;
      rules.onlyIfGrowSecondsAtLeast = 40;
      rules.natural = { weed: [1, 1], pest: [0, 0], dry: [0, 0] };
      rules.windowRatio = [0.2, 0.8];
    },
    prepare: state => { state.wallet.level = 2; state.wallet.exp = 50; },
  });
  const field = f.state().objects.find(object => object.field?.state === 'EMPTY');
  await f.ok('/fields/plant', { items: [{ objId: field.id, cropId: 'ngo' }] });
  f.advance(61_000);
  const growing = (await f.ok('/world')).objects.find(object => object.id === field.id);
  assert.ok(growing.field.problems.some(problem => problem.type === 'weed'), 'Configured crop problems must become actionable');
  const tool = f.config.bundle.gameConfig.problems.fixTool.weed;
  const inventory = f.state().inventory[tool];
  const exp = f.state().wallet.exp;
  await f.ok(`/fields/${field.id}/care`, { type: 'weed' });
  assert.equal(f.state().inventory[tool], inventory - 1);
  assert.ok(f.state().wallet.exp > exp);
  assert.equal((await f.quest('m04')).progress, 1);
  const after = f.state();
  const repeated = await f.request(`/fields/${field.id}/care`, { type: 'weed' });
  assert.equal(repeated.status, 400);
  assert.deepEqual(f.state().inventory, after.inventory);
  assert.equal(f.state().wallet.exp, after.wallet.exp);
});

test('care on a problem-free empty field cannot mint XP or quest progress', async t => {
  const f = fixture(t);
  const field = f.state().objects.find(object => object.field?.state === 'EMPTY');
  const before = f.state();
  const response = await f.request(`/fields/${field.id}/care`, { type: 'dry' });
  assert.equal(response.status, 400);
  assert.equal(f.state().wallet.exp, before.wallet.exp);
  assert.equal((await f.quest('m04')).progress, 0);
});
