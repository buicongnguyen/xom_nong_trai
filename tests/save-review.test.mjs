import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../src/backend.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'));
function newFarm(t) {
  const prefix = path.join(os.tmpdir(), 'xnt-save-review-');
  const dataDir = fs.mkdtempSync(prefix);
  t.after(() => {
    const absolute = path.resolve(dataDir);
    assert.ok(absolute.startsWith(path.resolve(prefix)), 'cleanup stays inside the named test directory');
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return dataDir;
}
async function request(backend, route, body) {
  let status, data;
  await backend.handle({ method: body ? 'POST' : 'GET', url: '/api' + route }, {
    writeHead(code) { status = code; }, setHeader() {}, end(value) { data = JSON.parse(value); },
  }, '/api' + route, body || {});
  return { status, data };
}

test('offline game time is continuous through reload, save, and reopen', t => {
  let time = 1710000000000;
    const wallTime = () => time;
    const dataDir = newFarm(t);
    let backend = createBackend({ dataDir, config, gameSpeed: 30, wallTime });
    const start = time;
    time += 1000;
    assert.equal(Date.parse(backend.getServerTime()), start + 30000);
    backend = createBackend({ dataDir, config, gameSpeed: 30, wallTime });
    for (let i = 0; i < 10; i++) {
      backend.reload();
      assert.equal(Date.parse(backend.getServerTime()), start + 30000, 'reloading cannot add elapsed time twice');
    }
    time += 2000;
    backend.reload();
    assert.equal(Date.parse(backend.getServerTime()), start + 90000);
    backend.save();
    time += 4000;
    backend = createBackend({ dataDir, config, gameSpeed: 30, wallTime });
    assert.equal(Date.parse(backend.getServerTime()), start + 210000);
});

test('a speed migration persists once and keeps the new clock through ordinary reloads', t => {
  const dataDir = newFarm(t);
  let time = 1710000000000;
  const wallTime = () => time;
  const start = time;
  createBackend({ dataDir, config, gameSpeed: 1, wallTime });
  time += 1000;
  const backend = createBackend({ dataDir, config, gameSpeed: 30, wallTime });
  assert.equal(Date.parse(backend.getServerTime()), start + 1000);
  time += 1000;
  backend.reload();
  assert.equal(Date.parse(backend.getServerTime()), start + 31000);
  time += 1000;
  backend.reload();
  assert.equal(Date.parse(backend.getServerTime()), start + 61000);
});

test('a failed durable save rolls back gameplay and emits no mutation event', async t => {
  const dataDir = newFarm(t);
  const events = [];
  const backend = createBackend({ dataDir, config, gameSpeed: 1, onMutation: event => events.push(event) });
  const before = backend.getState();
  const diskBefore = fs.readFileSync(path.join(dataDir, 'farm.json'), 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('Test save failure'), { code: 'ENOSPC' }); };
  try {
    const response = await request(backend, '/storage/sell-npc', { itemId: 'lua', qty: 1 });
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, 'SAVE_FAILED');
    assert.deepEqual(backend.getState().wallet, before.wallet);
    assert.deepEqual(backend.getState().inventory, before.inventory);
    assert.equal(fs.readFileSync(path.join(dataDir, 'farm.json'), 'utf8'), diskBefore);
    assert.equal(events.length, 0);
  } finally { fs.renameSync = rename; }
});

test('notification errors cannot roll back a committed mutation', async t => {
  const dataDir = newFarm(t);
  const backend = createBackend({ dataDir, config, gameSpeed: 1, onMutation() { throw new Error('Test notification failure'); } });
  const before = backend.getState();
  const response = await request(backend, '/storage/sell-npc', { itemId: 'lua', qty: 1 });
  assert.equal(response.status, 200);
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'farm.json'), 'utf8'));
  assert.equal(backend.getState().inventory.lua, before.inventory.lua - 1);
  assert.deepEqual(backend.getState().inventory, disk.inventory);
  assert.deepEqual(backend.getState().wallet, disk.wallet);
});

test('a version-one farm recovers purchased-field quest progress without changing possessions', async t => {
  const dataDir = newFarm(t);
  const wallTime = () => 1710000000000;
  const backend = createBackend({ dataDir, config, gameSpeed: 1, wallTime });
  const bought = await request(backend, '/fields/buy', { x: 34, y: 36 });
  assert.equal(bought.status, 200, JSON.stringify(bought.data));
  const legacy = backend.getState();
  legacy.version = 1;
  delete legacy.counters.BUY_FIELD;
  delete legacy.questProgress.m03;
  const savePath = path.join(dataDir, 'farm.json');
  fs.writeFileSync(savePath, JSON.stringify(legacy));

  const restored = createBackend({ dataDir, config, gameSpeed: 1, wallTime });
  const migrated = restored.getState();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.counters.BUY_FIELD, 1);
  assert.equal(migrated.questProgress.m03, 1);
  assert.deepEqual(migrated.wallet, legacy.wallet);
  assert.deepEqual(migrated.inventory, legacy.inventory);
  assert.deepEqual(migrated.objects, legacy.objects);
  const disk = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  assert.equal(disk.version, 2);
  assert.equal(disk.questProgress.m03, 1, 'migration is durably saved');
});
