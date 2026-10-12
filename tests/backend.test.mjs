import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const configPath = process.argv[2] || new URL('../config/game.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

test('local backend persists a real farming, animal, and production loop', async () => {
  const prefix = path.join(os.tmpdir(), 'xom-nong-trai-backend-');
  const dataDir = fs.mkdtempSync(prefix);
  const speed = 100000;
  let backend = createBackend({ dataDir, config, gameSpeed: speed });
  const events = [];
  backend.setOnMutation(event => events.push(event));
  const pause = () => new Promise(resolve => setTimeout(resolve, 2));
  async function request(route, body, method = body ? 'POST' : 'GET') {
    let status, data;
    const url = `/api${route}`;
    const pathname = new URL(url, 'http://localhost').pathname;
    const handled = await backend.handle({ url, method }, {
      setHeader() {}, writeHead(value) { status = value; }, end(value) { data = JSON.parse(value); },
    }, pathname, body || {});
    assert.equal(handled, true, `route ${route} must be implemented`);
    return { status, data };
  }
  async function ok(route, body, method) {
    const response = await request(route, body, method);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  try {
    const guest = await ok('/auth/guest', { deviceId: 'local-test-device' });
    assert.equal(guest.user.isNpc, false);
    assert.equal(typeof guest.accessToken, 'string');
    const profile = await ok('/users/me');
    assert.equal(profile.user.id, guest.user.id);
    assert.equal(profile.wallet.level, 1);
    const initial = await ok('/world');
    assert.equal(initial.owner.id, guest.user.id);
    assert.equal(initial.zones.unlocked.length, 4);
    const ripe = initial.objects.find(obj => obj.field?.state === 'MATURE');
    assert.ok(ripe, 'the first tutorial must have a mature rice field');
    const rice = config.bundle.crops.crops.find(crop => crop.id === ripe.field.cropId);
    const inventoryBefore = backend.getState().inventory[rice.id];
    const harvested = await ok('/fields/harvest', { objIds: [ripe.id] });
    assert.deepEqual(harvested.done, [ripe.id]);
    assert.equal(harvested.objects[0].field.state, 'EMPTY');
    assert.equal(backend.getState().inventory[rice.id], inventoryBefore + rice.yieldPerField);
    assert.ok(harvested.wallet.exp > 0);

    const empty = (await ok('/world')).objects.find(obj => obj.field?.state === 'EMPTY');
    const snapshot = backend.getState();
    const rejected = await request('/fields/plant', { items: [
      { objId: empty.id, cropId: rice.id }, { objId: empty.id, cropId: 'nonexistent_crop' },
    ] });
    assert.equal(rejected.status, 400);
    assert.deepEqual(backend.getState().inventory, snapshot.inventory, 'failed batches roll back seed consumption');
    assert.equal(backend.getState().objects.find(obj => obj.id === empty.id).field.state, 'EMPTY');

    const planted = await ok('/fields/plant', { items: [{ objId: ripe.id, cropId: rice.id }] });
    assert.equal(planted.objects[0].field.state, 'GROWING');
    assert.ok(Date.parse(planted.objects[0].field.matureAt) > Date.parse(planted.objects[0].field.plantedAt));
    await pause();
    assert.equal((await ok('/world')).objects.find(obj => obj.id === ripe.id).field.state, 'MATURE');
    await ok('/fields/harvest', { objIds: [ripe.id] });
    for (let i = 0; backend.getState().wallet.level < 2 && i < 50; i++) {
      await ok('/fields/plant', { items: [{ objId: ripe.id, cropId: rice.id }] });
      await pause();
      await ok('/fields/harvest', { objIds: [ripe.id] });
    }
    assert.equal(backend.getState().wallet.level, 2, 'XP advances to the next configured level');
    const leveled = await ok('/users/me');
    assert.ok(leveled.wallet.exp >= config.bundle.levels.levels[1].cumExp, 'wallet XP is cumulative');
    assert.ok(leveled.wallet.expToNext > 0);

    const world = await ok('/world');
    const pen = world.objects.find(obj => obj.kind === 'pen');
    const animal = config.bundle.animals.animals.find(def => def.pen === pen.defId && def.unlockLevel <= 2);
    assert.ok(animal);
    const bought = await ok(`/pens/${pen.id}/buy-animal`, { animalDef: animal.id });
    const animalId = bought.objects[0].pen.animals[0].id;
    const feedBefore = backend.getState().inventory[animal.feed];
    const fed = await ok(`/pens/${pen.id}/feed`, { animalIds: [animalId] });
    assert.equal(fed.objects[0].pen.animals[0].state, 'GROWING');
    assert.equal(backend.getState().inventory[animal.feed], feedBefore - animal.feedQty);
    await pause();
    const collected = await ok(`/pens/${pen.id}/collect`, { animalIds: [animalId] });
    assert.equal(collected.objects[0].pen.animals[0].state, 'HUNGRY');
    assert.equal(backend.getState().inventory[animal.product], animal.productQty);

    const factory = world.objects.find(obj => obj.kind === 'factory');
    const recipe = config.bundle.recipes.recipes.find(def => def.building === factory.defId && def.unlockLevel <= 2 &&
      Object.entries(def.inputs).every(([id, qty]) => (backend.getState().inventory[id] || 0) >= qty));
    assert.ok(recipe);
    const productsBefore = backend.getState().inventory[recipe.id] || 0;
    const queued = await ok(`/factories/${factory.id}/enqueue`, { recipeId: recipe.id });
    assert.equal(queued.objects[0].factory.queue[0].recipeId, recipe.id);
    await pause();
    const produced = await ok(`/factories/${factory.id}/collect`, {});
    assert.deepEqual(produced.objects[0].factory.output, []);
    assert.equal(backend.getState().inventory[recipe.id], productsBefore + recipe.outputQty);
    const beforeSell = backend.getState();
    await ok('/storage/sell-npc', { itemId: recipe.id, qty: 1 });
    assert.equal(backend.getState().inventory[recipe.id], beforeSell.inventory[recipe.id] - 1);
    assert.ok(backend.getState().wallet.gold > beforeSell.wallet.gold);

    const beforeClaim = backend.getState().wallet.gold;
    const checkin = await ok('/checkin/claim', {});
    assert.ok(checkin.reward.gold > 0);
    assert.ok(backend.getState().wallet.gold > beforeClaim);
    assert.equal((await request('/checkin/claim', {})).status, 400, 'daily rewards cannot be claimed twice');
    const invalidSale = await request('/storage/sell-npc', { itemId: rice.id, qty: 999999 });
    assert.equal(invalidSale.status, 400);
    assert.equal(invalidSale.data.error.code, 'NOT_ENOUGH_ITEMS');

    const goldBeforeCollision = backend.getState().wallet.gold;
    const house = backend.getWorld().objects.find(obj => obj.defId === 'nha');
    assert.equal((await request('/fields/buy', { x: house.x, y: house.y })).status, 400);
    assert.equal(backend.getState().wallet.gold, goldBeforeCollision, 'invalid placement does not charge money');
    const built = await ok('/fields/buy', { x: 34, y: 36 });
    assert.equal(built.objects[0].kind, 'field');
    const builtId = built.objects[0].id;
    await ok('/world/layout', { changes: [{ objId: builtId, x: 36, y: 36, rot: 0 }] });
    assert.equal(backend.getState().objects.find(obj => obj.id === builtId).x, 36);
    const storable = backend.getWorld().objects.find(obj => config.bundle.objects.objects.find(def => def.id === obj.defId)?.storable);
    assert.ok(storable);
    await ok('/world/layout', { changes: [{ objId: storable.id, store: true }] });
    assert.ok(backend.getState().objects.find(obj => obj.id === storable.id).stored);
    assert.ok((await ok('/storage')).bag.some(item => item.itemId === storable.defId && item.qty === 1));
    await ok('/world/place', { defId: storable.defId, from: 'bag', x: 38, y: 20, rot: 0 });
    assert.equal(backend.getState().objects.find(obj => obj.id === storable.id).stored, false);
    assert.ok(!(await ok('/storage')).bag.some(item => item.itemId === storable.defId));

    // Use normal time for a speed-up quote so the timer cannot finish between API calls.
    backend = createBackend({ dataDir, config, gameSpeed: 1 });
    await ok('/fields/plant', { items: [{ objId: builtId, cropId: rice.id }] });
    const quoted = await ok(`/speed-up/quote?objId=${builtId}`);
    assert.ok(quoted.remainingMs > 0);
    const xuBefore = backend.getState().wallet.xu;
    const accelerated = await ok('/speed-up', { target: { objId: builtId }, expectedXu: quoted.xuCost });
    assert.equal(accelerated.objects[0].field.state, 'MATURE');
    assert.equal(backend.getState().wallet.xu, xuBefore - quoted.xuCost);

    const saved = backend.getState();
    backend = createBackend({ dataDir, config, gameSpeed: 1 });
    assert.deepEqual(backend.getState().inventory, saved.inventory);
    assert.deepEqual(backend.getState().wallet, saved.wallet);
    assert.equal(backend.getState().user.id, saved.user.id);
    assert.ok(events.some(event => event.tutorialStep > event.previousTutorialStep), 'tutorial updates are emitted');
    const restored = await ok('/auth/refresh', {});
    assert.equal(typeof restored.accessToken, 'string');
    const stock = await ok('/storage');
    assert.ok(stock.storage.ham.used <= stock.storage.ham.capacity);
    assert.ok(stock.storage.kho.used <= stock.storage.kho.capacity);
  } finally {
    const absolute = path.resolve(dataDir);
    assert.ok(absolute.startsWith(path.resolve(prefix)), 'cleanup target stays inside the named temporary test directory');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
