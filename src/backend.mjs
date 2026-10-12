import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { tutorial } from './tutorial.mjs';

// Independent single-player server for the public Xom Nong Trai web client.
// Game definitions are supplied from the reference configuration; all player data
// lives in dataDir and no requests are made to the original game server.
export function createBackend({ dataDir, config, gameSpeed = 1, onMutation = () => {}, wallTime = () => Date.now(), random = () => Math.random() }) {
  if (!config?.bundle) throw new Error('createBackend requires the complete configuration response.');
  fs.mkdirSync(dataDir, { recursive: true });
  const savePath = path.join(dataDir, 'farm.json');
  const bundle = config.bundle;
  const cfg = bundle.gameConfig;
  const chests = config.localRules?.chests || { extraCostXu: 5, table: [
    { weight: 60, reward: { gold: 100 } }, { weight: 30, reward: { gold: 250 } }, { weight: 10, reward: { xu: 5 } },
  ] };
  const definitions = new Map(bundle.objects.objects.map(def => [def.id, def]));
  const crops = new Map(bundle.crops.crops.map(def => [def.id, def]));
  const trees = new Map(bundle.crops.trees.map(def => [def.id, def]));
  const animals = new Map(bundle.animals.animals.map(def => [def.id, def]));
  const pens = new Map(bundle.animals.pens.map(def => [def.id, def]));
  const factories = new Map(bundle.buildings.buildings.map(def => [def.id, def]));
  const recipes = new Map(bundle.recipes.recipes.map(def => [def.id, def]));
  const items = new Map(bundle.items.items.map(def => [def.id, def]));
  const levels = bundle.levels.levels;
  const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  const iso = value => new Date(value).toISOString();
  const clone = value => structuredClone(value);
  let state;
  let token = randomUUID();
  let mutationLevelUp = null;
  let mutationEvents = [];

  function now() { return state.clock.gameAt + Math.max(0, wallTime() - state.clock.wallAt) * gameSpeed; }
  // Calendar rewards use the real Vietnam date, independently of fast demo timers.
  function today() { return new Date(wallTime() + 7 * 3600000).toISOString().slice(0, 10); }
  function save() {
    const temporary = savePath + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
      fs.renameSync(temporary, savePath);
    } catch {
      fail('SAVE_FAILED', 'The farm could not be saved. Free storage space and try again.', undefined, 503);
    }
  }
  function fail(code, message, details, status = 400) {
    throw Object.assign(new Error(message), { code, details, status });
  }
  function defFor(id) {
    const def = definitions.get(id);
    if (!def) fail('VALIDATION', `Unknown object: ${id}`);
    return def;
  }
  function object(id, kind) {
    const value = state.objects.find(obj => obj.id === integer(id));
    if (!value || value.stored) fail('NOT_FOUND', 'The object is not on your farm.', undefined, 404);
    if (kind && value.kind !== kind) fail('VALIDATION', `Expected a ${kind}.`);
    return value;
  }
  function storageKind(itemId) { return items.get(itemId)?.storage === 'ham' ? 'ham' : 'kho'; }
  function storage() {
    const output = {};
    for (const kind of ['ham', 'kho']) {
      const level = state.storageLevels[kind] || 1;
      const spec = bundle.storage[kind];
      const content = Object.entries(state.inventory).filter(([id, qty]) => qty > 0 && storageKind(id) === kind)
        .map(([itemId, qty]) => ({ itemId, qty }));
      const capacity = spec.capacity.start + (level - 1) * spec.capacity.perLevel;
      const upgrade = level < spec.capacity.maxLevel ? spec.materials.map(item => ({
        item, have: state.inventory[item] || 0,
        need: spec.qtyPerMaterial.base + level * spec.qtyPerMaterial.perUpgradeLevel,
      })) : null;
      output[kind] = { level, used: content.reduce((sum, item) => sum + item.qty, 0), capacity, items: content, nextUpgrade: upgrade };
    }
    return output;
  }
  function have(id) { return state.inventory[id] || 0; }
  function requireItems(input) {
    for (const [id, qty] of Object.entries(input)) {
      if (have(id) < qty) fail('NOT_ENOUGH_ITEMS', `Not enough ${items.get(id)?.name || id}.`, { itemId: id, need: qty, have: have(id) });
    }
  }
  function addItems(input) {
    const store = storage();
    for (const kind of ['ham', 'kho']) {
      const added = Object.entries(input).filter(([id]) => storageKind(id) === kind).reduce((sum, [, qty]) => sum + qty, 0);
      if (added > 0 && store[kind].used + added > store[kind].capacity) fail('STORAGE_FULL', 'Your storage is full.', { kind });
    }
    for (const [id, qty] of Object.entries(input)) state.inventory[id] = have(id) + qty;
  }
  function removeItems(input) { requireItems(input); for (const [id, qty] of Object.entries(input)) state.inventory[id] = have(id) - qty; }
  function pay(amount, currency = 'gold') {
    amount = Math.max(0, Math.ceil(Number(amount) || 0));
    if (state.wallet[currency] < amount) fail(currency === 'xu' ? 'NOT_ENOUGH_XU' : 'NOT_ENOUGH_GOLD', `Not enough ${currency}.`);
    state.wallet[currency] -= amount;
  }
  function requireLevel(level) {
    if (state.wallet.level < level) fail('LEVEL_TOO_LOW', `Reach level ${level} first.`, { level });
  }
  function wallet() {
    const row = levels.find(level => level.level === state.wallet.level);
    const next = levels.find(level => level.level === state.wallet.level + 1);
    return { ...state.wallet, expToNext: next ? Math.max(0, next.cumExp - state.wallet.exp) : 0 };
  }
  function publicUser() {
    return { id: state.user.id, displayName: state.user.displayName, avatar: state.user.avatar || 'farmer', level: state.wallet.level, isNpc: false };
  }
  function addExp(amount) {
    amount = Math.max(0, integer(amount));
    state.wallet.exp += amount;
    let row = levels.find(level => level.level === state.wallet.level);
    while (state.wallet.level < 200 && state.wallet.exp >= (levels.find(level => level.level === state.wallet.level + 1)?.cumExp ?? Infinity)) {
      state.wallet.level++;
      row = levels.find(level => level.level === state.wallet.level);
      const reward = row?.reward || { gold: cfg.level.levelUpReward.goldPerLevel || 100, xu: 0 };
      state.wallet.gold += reward.gold || 0;
      state.wallet.xu += reward.xu || 0;
      const unlocks = row?.unlocks || {};
      mutationLevelUp = { level: state.wallet.level, unlocks: {
        objects: [...(unlocks.buildings || []), ...(unlocks.pens || []), ...(unlocks.trees || []), ...(unlocks.decor || [])],
        crops: unlocks.crops || [], recipes: unlocks.recipes || [], features: unlocks.features || [], titles: unlocks.titles || [],
      }, reward };
    }
    return amount;
  }
  function reward(value = {}) {
    state.wallet.gold += integer(value.gold);
    state.wallet.xu += integer(value.xu);
    addExp(value.exp);
    if (value.items) addItems(Array.isArray(value.items) ? Object.fromEntries(value.items.map(item => Array.isArray(item) ? item : [item.itemId, item.qty])) : value.items);
  }
  function record(event, count = 1, meta = {}) {
    mutationEvents.push({ event, meta });
    state.counters[event] = (state.counters[event] || 0) + count;
    for (const quest of [...(bundle.quests.main || []), ...(bundle.quests.dailyPool || [])]) {
      if (quest.goal.event !== event) continue;
      if (quest.goal.filter && Object.entries(quest.goal.filter).some(([key, value]) =>
        key === 'defIdIn' ? !value.includes(meta.defId) : meta[key] !== value)) continue;
      state.questProgress[quest.id] = (state.questProgress[quest.id] || 0) + count;
    }
  }
  function resetDailyQuests() {
    const day = today();
    if (state.dailyQuestDay === day) return;
    const daily = new Set(bundle.quests.dailyPool.map(quest => quest.id));
    for (const id of daily) delete state.questProgress[id];
    state.claimedQuests = state.claimedQuests.filter(id => !daily.has(id));
    state.dailyQuestDay = day;
  }
  function normalizeTutorial() {
    state.user.tutorialStep = Math.min(tutorial.length, Math.max(0, integer(state.user.tutorialStep)));
    while (tutorial[state.user.tutorialStep]?.skip) state.user.tutorialStep++;
    // A short demo construction timer can finish before the speed-up prompt opens.
    if (state.user.tutorialStep === 16 && state.objects.some(obj => obj.defId === 'lo_duong' && !obj.construction)) state.user.tutorialStep++;
    const step = tutorial[state.user.tutorialStep];
    if (step?.gift && !(state.user.tutorialGifts || []).includes(state.user.tutorialStep)) {
      if (!have(step.gift)) addItems({ [step.gift]: 1 });
      (state.user.tutorialGifts ||= []).push(state.user.tutorialStep);
    }
  }
  function emptyField(cycleNo = 0, soilTier = 0) {
    return { state: 'EMPTY', soilTier, problems: [], fertilizedThisCycle: false, cycleNo };
  }
  function makeObject(id, x, y, rot = 0) {
    const def = defFor(id);
    const value = { id: state.nextObjectId++, defId: id, kind: def.kind, x: integer(x), y: integer(y), rot: rot === 1 ? 1 : 0, level: 1, stored: false };
    if (def.kind === 'field') value.field = emptyField();
    if (def.kind === 'tree') {
      const tree = trees.get(id);
      value.tree = { state: 'GROWING', readyAt: iso(now() + tree.cycleSeconds * 1000), harvestsDone: 0, cyclesBeforeWither: tree.cyclesBeforeWither, fruitRemaining: tree.fruitPerCycle, revivers: [] };
    }
    if (def.kind === 'pen') value.pen = { capacity: pens.get(id)?.capacity[0] || 4, animals: [] };
    if (def.kind === 'factory') value.factory = { slots: factories.get(id)?.queueSlots.start || 2, workers: 1, queue: [], output: [] };
    if (def.kind === 'obstacle') value.obstacle = { tool: def.tool, toolQty: def.toolQty, exp: def.exp };
    return value;
  }
  function initialize() {
    const firstProvince = bundle.provinces.provinces.find(province => province.region === 'bac') || bundle.provinces.provinces[0];
    const region = firstProvince.region;
    const layoutId = bundle.expansion.regionStartingLayouts?.[region]?.[0];
    const layout = bundle.expansion.startingLayouts.find(value => value.id === layoutId) || bundle.expansion.startingLayouts[0];
    state = { version: 2, clock: { gameAt: wallTime(), wallAt: wallTime(), speed: gameSpeed }, user: {
      id: randomUUID(), displayName: 'Nông dân', settings: { sound: true, music: true }, providers: [], username: null,
      tutorialStep: 0, tutorialSnoozed: false, createdAt: iso(wallTime()),
    }, wallet: { gold: cfg.startingState.gold, xu: cfg.startingState.xu, level: 1, exp: 0 },
    inventory: { ...cfg.startingState.items }, storageLevels: { ham: 1, kho: 1 },
    home: { provinceId: firstProvince.id, villageId: null, homeChangedAt: null, freeChangeUsed: false, peacefulMode: false, skinRegion: region, lotIdx: null, nextChangeAllowedAt: null },
    region, layoutTemplate: layout.id, objects: [], nextObjectId: 1, nextAnimalId: 1,
    unlocked: [], counters: {}, questProgress: {}, claimedQuests: [], claimedAchievements: [],
    checkinDay: null, streakDay: 0, chestDay: null, chestsToday: 0, bag: [], orders: [], logs: [], };
    const zoneSize = bundle.expansion.map.zoneSize;
    const columns = bundle.expansion.map.size[0] / zoneSize;
    const start = bundle.expansion.map.startZone;
    for (let zy = Math.floor(start.y / zoneSize); zy < Math.ceil((start.y + start.h) / zoneSize); zy++)
      for (let zx = Math.floor(start.x / zoneSize); zx < Math.ceil((start.x + start.w) / zoneSize); zx++) state.unlocked.push(zy * columns + zx);
    const starting = layout.objects?.length ? layout.objects : cfg.startingState.objects;
    state.objects = starting.map(obj => makeObject(obj.def, obj.x, obj.y, obj.rot));
    // Start with one mature rice field, matching the first tutorial action.
    const field = state.objects.find(obj => obj.field);
    const rice = crops.get('lua') || [...crops.values()][0];
    if (field && rice) field.field = { ...emptyField(), state: 'MATURE', cropId: rice.id, stage: 2,
      stageEndsAt: iso(now()), matureAt: iso(now()), yieldExpected: rice.yieldPerField, yieldRemaining: rice.yieldPerField };
    for (const source of bundle.expansion.obstacleSpawn.startZone || [])
      if (definitions.has(source.def) && !state.objects.some(obj => obj.x === source.x && obj.y === source.y)) state.objects.push(makeObject(source.def, source.x, source.y));
    save();
  }
  function reload() {
    if (!fs.existsSync(savePath)) fail('SAVE_RESET', 'This farm was reset in another tab. Reload the game to start again.', undefined, 409);
    state = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    let migrated = false;
    if (state.clock.speed !== gameSpeed) {
      state.clock.gameAt += Math.max(0, wallTime() - state.clock.wallAt) * (state.clock.speed || gameSpeed);
      state.clock.wallAt = wallTime();
      state.clock.speed = gameSpeed;
      migrated = true;
    }
    if (state.version < 2) {
      const layout = bundle.expansion.startingLayouts.find(value => value.id === state.layoutTemplate);
      const startingFields = (layout?.objects || cfg.startingState.objects).filter(value => definitions.get(value.def)?.kind === 'field').length;
      const boughtFields = Math.max(0, state.objects.filter(value => value.kind === 'field').length - startingFields);
      state.counters.BUY_FIELD = Math.max(state.counters.BUY_FIELD || 0, boughtFields);
      for (const quest of [...bundle.quests.main, ...bundle.quests.dailyPool]) if (quest.goal.event === 'BUY_FIELD') state.questProgress[quest.id] = Math.max(state.questProgress[quest.id] || 0, boughtFields);
      state.version = 2;
      migrated = true;
    }
    return migrated;
  }
  if (fs.existsSync(savePath)) { if (reload()) save(); }
  else initialize();

  function tick() {
    resetDailyQuests();
    const time = now();
    for (const obj of state.objects) {
      const field = obj.field;
      if (field?.state === 'GROWING') {
        const mature = Date.parse(field.matureAt);
        for (const scheduled of field.problemSchedule || []) if (!scheduled.applied && time >= scheduled.at) {
          field.problems.push({ type: scheduled.type, source: 'natural', at: iso(scheduled.at) });
          scheduled.applied = true;
        }
        if (time >= mature) {
          field.state = 'MATURE'; field.stage = 2;
          const penalty = Math.min(cfg.problems.penaltyCap, field.problems.length * cfg.problems.penaltyPerProblem);
          field.yieldRemaining = Math.max(1, Math.floor(field.yieldExpected * (1 - penalty)));
        }
        else if (field.plantedAt) {
          const ends = field.stageEnds || [1, 2, 3].map(n => Date.parse(field.plantedAt) + (mature - Date.parse(field.plantedAt)) * n / 3);
          field.stage = Math.min(2, ends.filter(end => time >= end).length);
          field.stageEndsAt = iso(ends[field.stage]);
        }
      }
      if (obj.tree?.state === 'GROWING' && time >= Date.parse(obj.tree.readyAt)) obj.tree.state = 'MATURE';
      for (const animal of obj.pen?.animals || []) if (animal.state === 'GROWING' && time >= Date.parse(animal.readyAt)) animal.state = 'READY';
      if (obj.factory) {
        const finished = obj.factory.queue.filter(job => time >= Date.parse(job.endAt));
        for (const job of finished) {
          const recipe = recipes.get(job.recipeId);
          const output = obj.factory.output.find(item => item.itemId === recipe.id);
          if (output) output.qty += recipe.outputQty;
          else obj.factory.output.push({ itemId: recipe.id, qty: recipe.outputQty });
        }
        obj.factory.queue = obj.factory.queue.filter(job => time < Date.parse(job.endAt));
      }
      if (obj.construction && time >= Date.parse(obj.construction.endsAt)) delete obj.construction;
    }
    normalizeTutorial();
  }
  function zones() {
    const columns = bundle.expansion.map.size[0] / bundle.expansion.map.zoneSize;
    const count = columns * (bundle.expansion.map.size[1] / bundle.expansion.map.zoneSize);
    const unlocked = new Set(state.unlocked);
    const unlockable = Array.from({ length: count }, (_, id) => id).filter(id => !unlocked.has(id) &&
      [id - columns, id + columns, ...(id % columns > 0 ? [id - 1] : []), ...(id % columns < columns - 1 ? [id + 1] : [])].some(other => unlocked.has(other)));
    const n = Math.max(1, state.unlocked.length - 3);
    const cost = bundle.expansion.zoneCost;
    return { unlocked: state.unlocked, unlockable, nextCost: unlockable.length ? {
      gold: cost.gold.perZoneIndexQuadratic * n * n,
      materials: cost.materials.map(itemId => ({ itemId, qty: cost.qtyPerMaterial.perZoneIndex * n })),
      level: cost.level.base + cost.level.perZoneIndex * n,
    } : null, lotUses: state.lotUses || [] };
  }
  function world() { return { owner: publicUser(), objects: state.objects.filter(obj => !obj.stored), zones: zones(), dog: state.dog,
    bag: state.bag, serverTime: iso(now()), layoutTemplate: state.layoutTemplate, region: state.region }; }
  function mutation(objects = [], extras = {}) {
    const result = { ok: true, objects, wallet: wallet(), storage: storage(), ...extras };
    if (mutationLevelUp) result.levelUp = mutationLevelUp;
    return result;
  }
  function ensureSpace(def, x, y, rot = 0, ignoreId) {
    if (![0, 1].includes(rot)) fail('VALIDATION', 'Rotation must be 0 or 1.');
    const map = bundle.expansion.map;
    const size = rot === 1 ? [...def.footprint].reverse() : def.footprint;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + size[0] > map.size[0] || y + size[1] > map.size[1]) fail('CANNOT_PLACE', 'Place the object inside the farm.');
    const columns = map.size[0] / map.zoneSize;
    for (let cx = x; cx < x + size[0]; cx++) for (let cy = y; cy < y + size[1]; cy++)
      if (!state.unlocked.includes(Math.floor(cy / map.zoneSize) * columns + Math.floor(cx / map.zoneSize))) fail('CANNOT_PLACE', 'Unlock this land first.');
    for (const obj of state.objects.filter(obj => !obj.stored && obj.id !== ignoreId)) {
      const original = definitions.get(obj.defId)?.footprint || [1, 1];
      const other = obj.rot === 1 ? [...original].reverse() : original;
      if (x < obj.x + other[0] && obj.x < x + size[0] && y < obj.y + other[1] && obj.y < y + size[1]) fail('CANNOT_PLACE', 'Another object occupies that space.');
    }
  }
  function fieldPrice() {
    const count = state.objects.filter(obj => obj.kind === 'field').length;
    const price = cfg.fields.buyPrice;
    return { owned: count, price: Math.ceil(price.base + price.perOwned * count + price.perOwnedSquared * count * count),
      max: Math.min(cfg.fields.maxByLevel.cap, cfg.fields.maxByLevel.base + cfg.fields.maxByLevel.perLevel * state.wallet.level) };
  }
  function shopEntry(def) {
    const owned = state.objects.filter(obj => obj.defId === def.id).length;
    const tier = def.maxCountByLevel?.filter(row => row.level <= state.wallet.level).at(-1);
    return { defId: def.id, name: def.name, price: typeof def.price === 'number' ? def.price : 0, currency: def.currency || 'gold',
      unlockLevel: def.unlockLevel, footprint: def.footprint, owned, max: def.unique ? 1 : tier?.count ?? null,
      ...(pens.has(def.id) ? { capacity: pens.get(def.id).capacity, upgradeGold: pens.get(def.id).upgradeGold } : {}),
      ...(def.kind === 'decor' ? { season: def.season ?? null, expOnBuy: def.expOnBuy || 0 } : {}) };
  }
  function quests() {
    const convert = (def, kind) => {
      const progress = Math.min(def.goal.count, state.questProgress[def.id] || 0);
      const locked = state.wallet.level < def.minLevel || !!def.after && !state.claimedQuests.includes(def.after);
      return { id: def.id, kind, name: def.name, desc: def.desc, minLevel: def.minLevel, event: def.goal.event,
        count: def.goal.count, progress, reward: normalizeReward(def.reward), completedAt: progress >= def.goal.count ? iso(now()) : null,
        claimedAt: state.claimedQuests.includes(def.id) ? state.user.createdAt : null, locked, rerolled: false, targetDefId: def.goal.filter?.defId };
    };
    return { main: bundle.quests.main.map(def => convert(def, 'main')), daily: bundle.quests.dailyPool.slice(0, 5).map(def => convert(def, 'daily')), dailyRerollXu: cfg.quests.dailyRerollXu };
  }
  function normalizeReward(value = {}) { return { ...value, ...(value.items ? { items: value.items.map(item => Array.isArray(item) ? { itemId: item[0], qty: item[1] } : item) } : {}) }; }
  function checkin() { return { streakDay: state.streakDay, canClaimToday: state.checkinDay !== today(), rewards: cfg.dailyLogin.rewards.map(normalizeReward) }; }
  function truckOrders() {
    if (state.orders.length === 0) {
      const available = [...crops.values()].filter(crop => crop.unlockLevel <= state.wallet.level);
      state.orders = Array.from({ length: 3 }, (_, slot) => {
        const crop = available[slot % available.length];
        return { slot, status: 'open', lines: [{ itemId: crop.id, qty: 3 + slot }], rewardGold: Math.ceil(crop.value * (3 + slot) * 1.2), rewardExp: 8 + slot * 3 };
      });
    }
    for (const order of state.orders) if (order.status === 'cooldown' && now() >= Date.parse(order.availableAt)) { order.status = 'open'; delete order.availableAt; }
    return state.orders;
  }
  function me() { return { user: { ...publicUser(), settings: state.user.settings, tutorialStep: state.user.tutorialStep,
    tutorialSnoozed: state.user.tutorialSnoozed, createdAt: state.user.createdAt, providers: state.user.providers },
    wallet: wallet(), counters: state.counters, unread: { mailbox: 0, gifts: 0, friendRequests: 0, hamletChat: 0, stolen: 0, rewards: 0, materialRequests: 0, latestReward: null },
    account: { username: state.user.username, providers: state.user.providers } }; }
  function speedTarget(target = {}) {
    const obj = target.objId ? object(target.objId) : state.objects.find(value => value.pen?.animals.some(animal => animal.id === integer(target.animalId)));
    if (!obj) fail('NOT_FOUND', 'Choose something that is still growing or being built.');
    let owner, key, index;
    if (target.animalId) { owner = obj.pen?.animals.find(value => value.id === integer(target.animalId)); key = 'readyAt'; }
    else if (obj.construction) { owner = obj.construction; key = 'endsAt'; }
    else if (obj.factory?.queue.length) { index = integer(target.jobIndex); owner = obj.factory.queue[index]; key = 'endAt'; }
    else if (obj.field?.state === 'GROWING') { owner = obj.field; key = 'matureAt'; }
    else if (obj.tree?.state === 'GROWING') { owner = obj.tree; key = 'readyAt'; }
    if (!owner?.[key]) fail('NOT_READY', 'This object has no active timer.');
    // A waiting job can lose its own duration, but cannot jump ahead of earlier jobs.
    const earliest = index !== undefined ? Math.max(now(), Date.parse(owner.startAt)) : now();
    const remainingMs = Math.max(0, Date.parse(owner[key]) - earliest);
    if (!remainingMs) fail('NOT_READY', 'This timer has already finished.');
    const xuCost = Math.max(1, Math.ceil(remainingMs / 300000));
    return { obj, owner, key, index, remainingMs, xuCost, goldCost: xuCost * (cfg.speedUpGold?.fallbackGoldPerXu || 24) };
  }
  function reduceTimer(target, milliseconds) {
    const reduction = Math.min(target.remainingMs, milliseconds);
    target.owner[target.key] = iso(Date.parse(target.owner[target.key]) - reduction);
    if (target.obj.field && target.key === 'matureAt') {
      const field = target.obj.field;
      field.stageEnds = (field.stageEnds || [1, 2, 3].map(n => Date.parse(field.plantedAt) + (Date.parse(field.matureAt) + reduction - Date.parse(field.plantedAt)) * n / 3))
        .map(end => Math.max(now(), end - reduction));
    }
    if (target.index !== undefined) for (const job of target.obj.factory.queue.slice(target.index + 1)) {
      job.startAt = iso(Date.parse(job.startAt) - reduction); job.endAt = iso(Date.parse(job.endAt) - reduction);
    }
    tick();
  }
  function send(res, value, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Server-Time': iso(now()), 'X-Game-Speed': String(gameSpeed) });
    res.end(JSON.stringify(value));
  }
  async function handle(req, res, pathname, body = {}) {
    if (!pathname.startsWith('/api')) return false;
    const url = new URL(req.url, 'http://localhost');
    const route = pathname.slice(4) || '/';
    const method = req.method === 'HEAD' ? 'GET' : req.method || 'GET';
    mutationLevelUp = null;
    mutationEvents = [];
    const before = clone(state);
    let committed = false;
    try {
      const reads = new Set(['/config', '/world', '/storage', '/map/national', '/shop', '/shop/seeds', '/quests', '/achievements', '/titles', '/speed-up/quote',
        '/orders/truck', '/orders/boat', '/events', '/flags', '/ads/status', '/affiliate/links', '/chat/global/messages', '/chat/summary', '/dm/threads',
        '/giftcode/announcements', '/leaderboards/spotlight', '/pass/current', '/hamlets/me/help', '/hamlets/me', '/friends', '/friends/requests', '/mailbox', '/logs', '/health']);
      const allowed = route === '/users/me' ? ['GET', 'PATCH'] : ['/checkin', '/chests', '/home'].includes(route) ? ['GET', 'POST'] : reads.has(route) || /^\/map\/provinces\//.test(route) ? ['GET'] : ['POST'];
      if (!allowed.includes(method)) fail('METHOD_NOT_ALLOWED', 'This API does not accept that request method.', undefined, 405);
      tick();
      let result;
      if (route === '/config') result = config;
      else if (route === '/auth/guest' || route === '/auth/login') {
        if (route === '/auth/login' && state.user.username) {
          const hash = scryptSync(String(body.password || ''), state.user.passwordSalt, 32);
          if (body.username !== state.user.username || !timingSafeEqual(hash, Buffer.from(state.user.passwordHash, 'hex'))) fail('UNAUTHENTICATED', 'Incorrect username or password.', undefined, 401);
        }
        token = randomUUID();
        res.setHeader('Set-Cookie', 'xnt_local_session=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000');
        result = { accessToken: token, user: publicUser(), isNew: false };
      } else if (route === '/auth/refresh') result = { accessToken: token };
      else if (route === '/auth/logout') result = { ok: true };
      else if (route === '/auth/register') {
        if (!/^[a-z0-9_.]{4,20}$/.test(body.username || '') || String(body.password || '').length < 8) fail('VALIDATION', 'Use a username of 4–20 characters and a password of at least 8.');
        state.user.username = body.username; state.user.passwordSalt = randomUUID();
        state.user.passwordHash = scryptSync(body.password, state.user.passwordSalt, 32).toString('hex');
        result = { account: { username: state.user.username, providers: [] } };
      } else if (route === '/users/me' && method === 'GET') result = me();
      else if (route === '/users/me' && method === 'PATCH') {
        if (body.displayName) state.user.displayName = String(body.displayName).slice(0, 16);
        if (body.avatar) state.user.avatar = String(body.avatar).slice(0, 64);
        if (body.settings) state.user.settings = { ...state.user.settings, ...body.settings };
        result = { user: me().user };
      } else if (route === '/users/me/tutorial') { state.user.tutorialStep = Math.min(tutorial.length, Math.max(0, integer(body.step))); normalizeTutorial(); result = { tutorialStep: state.user.tutorialStep }; }
      else if (route === '/users/me/tutorial/snooze') { state.user.tutorialSnoozed = !!body.snoozed; result = { tutorialSnoozed: state.user.tutorialSnoozed }; }
      else if (route === '/users/me/tutorial/ack') {
        const step = tutorial[state.user.tutorialStep];
        if (!step || step.event !== null || state.wallet.level < step.level) fail('NOT_READY', 'Complete this tutorial action first.');
        state.user.tutorialStep++; normalizeTutorial(); result = { tutorialStep: state.user.tutorialStep };
      }
      else if (route === '/world') result = world();
      else if (route === '/home' && method === 'GET') result = { home: state.home };
      else if ((route === '/home' || route === '/home/choose') && method === 'POST') {
        const province = bundle.provinces.provinces.find(value => value.id === body.provinceId);
        if (!province) fail('VALIDATION', 'Choose a province.');
        state.home.provinceId = province.id; state.home.skinRegion = province.region; state.region = province.region; result = { home: state.home };
      } else if (route === '/map/national') result = { provinces: bundle.provinces.provinces.map(province => ({ ...province, playerCount: province.id === state.home.provinceId ? 1 : 0 })) };
      else if (/^\/map\/provinces\//.test(route)) { const province = bundle.provinces.provinces.find(value => value.id === route.split('/').at(-1)); result = { ...province, villages: [] }; }
      else if (route === '/storage') result = { storage: storage(), bag: state.bag };
      else if (route === '/storage/sell-npc') {
        const qty = integer(body.qty); if (qty < 1) fail('VALIDATION', 'Choose a quantity.');
        const item = items.get(body.itemId); if (!item) fail('VALIDATION', 'Unknown item.');
        removeItems({ [item.id]: qty }); state.wallet.gold += item.sellPrice * qty;
        record('SELL_NPC', qty, { itemId: item.id }); result = mutation();
      } else if (route === '/storage/upgrade' || /^\/storage\/(ham|kho)\/upgrade$/.test(route)) {
        const kind = route === '/storage/upgrade' ? body.kind : route.split('/')[2]; if (!['ham', 'kho'].includes(kind)) fail('VALIDATION', 'Choose a store.');
        const upgrade = storage()[kind].nextUpgrade; if (!upgrade) fail('MAX_LEVEL', 'Storage is fully upgraded.');
        removeItems(Object.fromEntries(upgrade.map(value => [value.item, value.need]))); state.storageLevels[kind]++; result = mutation();
      } else if (route === '/fields/plant') {
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 80) fail('VALIDATION', 'Choose 1–80 fields.');
        const changed = [];
        for (const input of body.items || []) {
          const obj = object(input.objId, 'field'); const crop = crops.get(input.cropId);
          if (!crop) fail('VALIDATION', 'Choose a crop.'); requireLevel(crop.unlockLevel);
          if (obj.field.state !== 'EMPTY') fail('FIELD_NOT_EMPTY', 'This field is already planted.');
          if (obj.field.soilTier < crop.minSoilTier) fail('SOIL_TOO_LOW', 'Upgrade the soil for this crop.');
          removeItems({ [crop.id]: crop.sowCost });
          const duration = crop.growSeconds * 1000 * (cfg.soil[obj.field.soilTier]?.timeMul || 1);
          obj.field = { ...emptyField(obj.field.cycleNo + 1, obj.field.soilTier), state: 'GROWING', cropId: crop.id,
            stage: 0, plantedAt: iso(now()), stageEndsAt: iso(now() + duration / 3), matureAt: iso(now() + duration),
            stageEnds: [1, 2, 3].map(n => now() + duration * n / 3),
            yieldExpected: Math.floor(crop.yieldPerField * (cfg.soil[obj.field.soilTier]?.yieldMul || 1)),
            yieldRemaining: Math.floor(crop.yieldPerField * (cfg.soil[obj.field.soilTier]?.yieldMul || 1)), problemSchedule: [] };
          if (crop.growSeconds >= cfg.problems.onlyIfGrowSecondsAtLeast) for (const type of cfg.problems.types) {
            const [min, max] = cfg.problems.natural[type];
            const count = Math.min(cfg.problems.maxPerTypePerField, min + Math.floor(random() * (max - min + 1)));
            const [early, late] = cfg.problems.windowRatio;
            for (let i = 0; i < count; i++) obj.field.problemSchedule.push({ type, at: now() + duration * (early + random() * (late - early)), applied: false });
          }
          addExp(cfg.exp.plant); changed.push(obj); record('PLANT', 1, { cropId: crop.id });
        }
        result = mutation(changed);
      } else if (route === '/fields/harvest') {
        if (!Array.isArray(body.objIds) || body.objIds.length < 1 || body.objIds.length > 80) fail('VALIDATION', 'Choose 1–80 fields.');
        const changed = []; const done = []; let exp = 0;
        for (const id of body.objIds || []) {
          const obj = object(id, 'field'); if (obj.field.state !== 'MATURE') continue;
          const crop = crops.get(obj.field.cropId); addItems({ [crop.id]: obj.field.yieldRemaining || crop.yieldPerField });
          exp += addExp(crop.expPerHarvest); record('HARVEST_FIELD', 1, { cropId: crop.id, fertilizedThisCycle: obj.field.fertilizedThisCycle });
          obj.field = emptyField(obj.field.cycleNo, obj.field.soilTier); changed.push(obj); done.push(obj.id);
        }
        result = mutation(changed, { done, exp });
      } else if (/^\/fields\/\d+\/care$/.test(route)) {
        const obj = object(route.split('/')[2], 'field');
        if (!cfg.problems.types.includes(body.type)) fail('VALIDATION', 'Choose a valid crop problem.');
        const problem = obj.field.problems.find(problem => problem.type === body.type);
        if (!problem) fail('NO_PROBLEM', 'This field does not have that problem.');
        removeItems({ [cfg.problems.fixTool[body.type]]: 1 }); pay(cfg.problems.fixCostGold);
        obj.field.problems = obj.field.problems.filter(value => value !== problem);
        if (obj.field.state === 'MATURE') {
          const penalty = Math.min(cfg.problems.penaltyCap, obj.field.problems.length * cfg.problems.penaltyPerProblem);
          obj.field.yieldRemaining = Math.max(1, Math.floor(obj.field.yieldExpected * (1 - penalty)));
        }
        const exp = addExp(cfg.exp.fixProblem); record('CARE', 1, { type: body.type }); record('FIX_PROBLEM', 1, { type: body.type }); result = mutation([obj], { exp });
      } else if (/^\/fields\/\d+\/fertilize$/.test(route)) {
        const obj = object(route.split('/')[2], 'field'); if (obj.field.state !== 'GROWING') fail('NOT_GROWING', 'Only growing fields can be fertilized.');
        if (obj.field.fertilizedThisCycle) fail('ALREADY_FERTILIZED', 'This crop was already fertilized.');
        const fertilizer = cfg.fertilizer.find(value => value.id === body.itemId); if (!fertilizer) fail('VALIDATION', 'Unknown fertilizer.');
        removeItems({ [body.itemId]: 1 }); obj.field.fertilizedThisCycle = true;
        if (fertilizer.effect === 'finishNow') reduceTimer(speedTarget({ objId: obj.id }), Date.parse(obj.field.matureAt) - now());
        else {
          const field = obj.field;
          const ends = field.stageEnds || [1, 2, 3].map(n => Date.parse(field.plantedAt) + (Date.parse(field.matureAt) - Date.parse(field.plantedAt)) * n / 3);
          const reduction = Math.min((fertilizer.value || 0) * 1000, Math.max(0, Date.parse(field.stageEndsAt) - now()) * cfg.fertilizerRule.maxCutRatio);
          field.stageEnds = ends.map((end, index) => index >= field.stage ? end - reduction : end);
          field.matureAt = iso(ends[2] - reduction);
        }
        tick(); record('FERTILIZE', 1, { cropId: obj.field.cropId }); result = mutation([obj]);
      } else if (/^\/fields\/\d+\/soil$/.test(route)) {
        const obj = object(route.split('/')[2], 'field'); const tier = integer(body.tier);
        const soil = cfg.soil.find(value => value.tier === tier);
        if (!soil?.upgrade || tier !== obj.field.soilTier + 1) fail('VALIDATION', 'Upgrade to the next soil tier.');
        if (obj.field.state !== 'EMPTY') fail('FIELD_NOT_EMPTY', 'Harvest this field before upgrading its soil.');
        requireLevel(soil.upgrade.level); pay(soil.upgrade.gold); if (soil.upgrade.xu) pay(soil.upgrade.xu, 'xu');
        obj.field.soilTier = tier; record('SOIL_UPGRADE', 1, { tier }); result = mutation([obj]);
      } else if (route === '/fields/buy' || route === '/world/place') {
        const def = defFor(route === '/fields/buy' ? 'field' : body.defId); requireLevel(def.unlockLevel);
        ensureSpace(def, body.x, body.y, body.rot);
        let obj;
        if (body.from === 'bag') {
          obj = state.objects.find(value => value.stored && value.defId === def.id); if (!obj) fail('NOT_ENOUGH_ITEMS', 'No stored object of this type.');
          Object.assign(obj, { x: body.x, y: body.y, rot: body.rot || 0, stored: false });
          const entry = state.bag.find(value => value.itemId === def.id); if (entry) entry.qty--;
          state.bag = state.bag.filter(value => value.qty > 0);
        } else {
          if (def.unique && state.objects.some(value => value.defId === def.id)) fail('ALREADY_OWNED', 'You already own this building.');
          const limit = shopEntry(def);
          if (limit.max !== null && limit.owned >= limit.max) fail('MAX_OBJECTS', 'Reach a higher level to buy more of this object.');
          const factory = factories.get(def.id);
          if (factory?.buildSeconds > 0 && state.objects.filter(value => value.construction).length >= cfg.construction.maxConcurrent) fail('CONSTRUCTION_LIMIT', 'Finish the current construction first.');
          if (def.kind === 'field') { const info = fieldPrice(); if (info.owned >= info.max) fail('MAX_FIELDS', 'Reach a higher level to buy more fields.'); pay(info.price); }
          else pay(def.price, def.currency);
          obj = makeObject(def.id, body.x, body.y, body.rot);
          if (factory?.buildSeconds > 0) obj.construction = { startedAt: iso(now()), endsAt: iso(now() + factory.buildSeconds * 1000) };
          state.objects.push(obj); record('BUILD_PLACE', 1, { defId: def.id });
          if (def.kind === 'field') { addExp(cfg.exp.buyField); record('BUY_FIELD'); }
          if (def.kind === 'decor') addExp(def.expOnBuy || 0);
        }
        result = mutation([obj], { bag: state.bag });
      } else if (route === '/world/layout') {
        const changed = [];
        const changes = body.changes;
        if (!Array.isArray(changes) || !changes.length || changes.length > 80 || new Set(changes.map(change => change.objId)).size !== changes.length) fail('VALIDATION', 'Choose distinct objects to move.');
        for (const change of changes) {
          const obj = object(change.objId); const def = defFor(obj.defId);
          if (!def.movable) fail('CANNOT_MOVE', 'This object cannot be moved.');
          if (change.store) {
            if (!def.storable) fail('CANNOT_STORE', 'This object cannot be stored.');
            obj.stored = true; const entry = state.bag.find(value => value.itemId === def.id);
            if (entry) entry.qty++; else state.bag.push({ itemId: def.id, qty: 1 });
          } else Object.assign(obj, { x: change.x, y: change.y, rot: change.rot ?? 0 });
          changed.push(obj);
        }
        // Validate the final layout, allowing atomic swaps of occupied positions.
        for (const obj of changed.filter(obj => !obj.stored)) ensureSpace(defFor(obj.defId), obj.x, obj.y, obj.rot, obj.id);
        result = mutation(changed.filter(obj => !obj.stored), { removed: changed.filter(obj => obj.stored).map(obj => obj.id), bag: state.bag });
      } else if (/^\/world\/objects\/\d+\/clear$/.test(route)) {
        const obj = object(route.split('/')[3], 'obstacle'); removeItems({ [obj.obstacle.tool]: obj.obstacle.toolQty });
        const exp = addExp(obj.obstacle.exp); state.objects = state.objects.filter(value => value.id !== obj.id); record('CLEAR_OBSTACLE'); result = mutation([], { removed: [obj.id], exp });
      } else if (/^\/world\/objects\/\d+\/upgrade$/.test(route)) {
        const obj = object(route.split('/')[3]);
        if (obj.defId === bundle.house.nha.object) {
          const tier = bundle.house.nha.tiers.find(value => value.level === (obj.level || 1) + 1);
          if (!tier?.upgrade) fail('MAX_LEVEL', 'Your house is fully upgraded.');
          requireLevel(tier.unlockLevel); pay(tier.upgrade.gold); removeItems(tier.upgrade.materials); obj.level = tier.level;
        } else if (obj.kind === 'pen') {
          const def = pens.get(obj.defId); const next = obj.level || 1;
          if (next >= def.capacity.length) fail('MAX_LEVEL', 'Your pen is fully upgraded.');
          pay(def.upgradeGold[next]); obj.level = next + 1; obj.pen.capacity = def.capacity[next];
        } else fail('VALIDATION', 'This object has no building upgrade.');
        record('UPGRADE_BUILDING', 1, { defId: obj.defId }); result = mutation([obj]);
      } else if (/^\/world\/objects\/\d+\/sell$/.test(route)) {
        const obj = object(route.split('/')[3]); const def = defFor(obj.defId);
        if (!def.sellable && def.kind !== 'decor') fail('CANNOT_SELL', 'This object cannot be sold.');
        state.wallet[def.currency || 'gold'] += Math.floor(def.price * cfg.shop.sellBackRatio); state.objects = state.objects.filter(value => value.id !== obj.id); result = mutation([], { removed: [obj.id] });
      } else if (/^\/world\/zones\/\d+\/unlock$/.test(route)) {
        const id = integer(route.split('/')[3]); const info = zones(); if (!info.unlockable.includes(id)) fail('CANNOT_UNLOCK', 'Unlock adjoining land first.');
        requireLevel(info.nextCost.level); pay(info.nextCost.gold); removeItems(Object.fromEntries(info.nextCost.materials.map(value => [value.itemId, value.qty])));
        state.unlocked.push(id); record('UNLOCK_ZONE'); result = mutation([], { zones: zones() });
      } else if (/^\/pens\/\d+\/buy-animal$/.test(route)) {
        const obj = object(route.split('/')[2], 'pen'); const animal = animals.get(body.animalDef);
        if (!animal || animal.pen !== obj.defId) fail('VALIDATION', 'This animal needs a different pen.'); requireLevel(animal.unlockLevel);
        if (obj.pen.animals.length >= obj.pen.capacity) fail('PEN_FULL', 'The pen is full.'); pay(animal.price);
        obj.pen.animals.push({ id: state.nextAnimalId++, def: animal.id, state: 'HUNGRY', productStolen: false, cycleNo: 0, problems: [] }); record('BUY_ANIMAL', 1, { animalId: animal.id }); result = mutation([obj]);
      } else if (/^\/pens\/\d+\/feed$/.test(route)) {
        const obj = object(route.split('/')[2], 'pen'); const selected = obj.pen.animals.filter(value => value.state === 'HUNGRY' && (!body.animalIds || body.animalIds.includes(value.id)));
        for (const value of selected) { const animal = animals.get(value.def); removeItems({ [animal.feed]: animal.feedQty });
          value.state = 'GROWING'; value.readyAt = iso(now() + animal.cycleSeconds * 1000); value.cycleNo++; addExp(cfg.exp.feed); record('FEED_ANIMAL', 1, { animalId: animal.id }); }
        result = mutation([obj], { animals: obj.pen.animals });
      } else if (/^\/pens\/\d+\/collect$/.test(route)) {
        const obj = object(route.split('/')[2], 'pen'); const selected = obj.pen.animals.filter(value => value.state === 'READY' && (!body.animalIds || body.animalIds.includes(value.id)));
        if (selected.length === 0) fail('NOTHING_TO_COLLECT', 'The animals are still growing.'); let exp = 0;
        for (const value of selected) { const animal = animals.get(value.def); addItems({ [animal.product]: animal.productQty });
          exp += addExp(animal.expPerCollect); value.state = 'HUNGRY'; delete value.readyAt; record('COLLECT_ANIMAL', 1, { animalId: animal.id }); }
        result = mutation([obj], { animals: obj.pen.animals, exp });
      } else if (/^\/pens\/\d+\/sell-animal$/.test(route)) {
        const obj = object(route.split('/')[2], 'pen'); const animal = obj.pen.animals.find(value => value.id === body.animalId);
        if (!animal) fail('NOT_FOUND', 'Animal not found.'); state.wallet.gold += Math.floor(animals.get(animal.def).price * cfg.animalSellRatio);
        obj.pen.animals = obj.pen.animals.filter(value => value !== animal); result = mutation([obj]);
      } else if (/^\/pens\/\d+\/care$/.test(route)) {
        const obj = object(route.split('/')[2], 'pen'); const animal = obj.pen.animals.find(value => value.id === body.animalId);
        if (!animal) fail('NOT_FOUND', 'Animal not found.'); animal.problems = animal.problems.filter(value => value.type !== body.type); result = mutation([obj]);
      } else if (/^\/factories\/\d+\/enqueue$/.test(route)) {
        const obj = object(route.split('/')[2], 'factory'); const recipe = recipes.get(body.recipeId);
        if (!recipe || recipe.building !== obj.defId) fail('VALIDATION', 'Choose a recipe for this factory.'); requireLevel(recipe.unlockLevel);
        if (obj.construction) fail('UNDER_CONSTRUCTION', 'Finish construction first.');
        if (obj.factory.queue.length >= obj.factory.slots) fail('QUEUE_FULL', 'The production queue is full.'); removeItems(recipe.inputs);
        const start = Math.max(now(), ...obj.factory.queue.map(job => Date.parse(job.endAt)));
        obj.factory.queue.push({ recipeId: recipe.id, startAt: iso(start), endAt: iso(start + recipe.seconds * 1000), w: 1 });
        record('ENQUEUE', 1, { recipeId: recipe.id, defId: obj.defId }); record('JOB_START', 1, { recipeId: recipe.id, defId: obj.defId }); result = mutation([obj]);
      } else if (/^\/factories\/\d+\/collect$/.test(route)) {
        const obj = object(route.split('/')[2], 'factory'); if (!obj.factory.output.length) fail('NOTHING_TO_COLLECT', 'Production is still running.');
        addItems(Object.fromEntries(obj.factory.output.map(value => [value.itemId, value.qty]))); const exp = addExp(obj.factory.output.reduce((sum, value) => sum + (recipes.get(value.itemId)?.exp || 0) * value.qty / (recipes.get(value.itemId)?.outputQty || 1), 0));
        for (const value of obj.factory.output) record('COLLECT_PRODUCT', value.qty, { itemId: value.itemId, recipeId: value.itemId, defId: obj.defId });
        obj.factory.output = []; record('COLLECT_FACTORY'); result = mutation([obj], { exp });
      } else if (/^\/factories\/\d+\/cancel$/.test(route)) {
        const obj = object(route.split('/')[2], 'factory'); const job = obj.factory.queue[body.jobIndex];
        if (!job) fail('NOT_FOUND', 'Job not found.');
        if (now() >= Date.parse(job.startAt)) fail('JOB_STARTED', 'A running production job cannot be cancelled.');
        const duration = Date.parse(job.endAt) - Date.parse(job.startAt);
        addItems(recipes.get(job.recipeId).inputs); obj.factory.queue.splice(body.jobIndex, 1);
        for (const queued of obj.factory.queue.slice(body.jobIndex)) {
          queued.startAt = iso(Date.parse(queued.startAt) - duration); queued.endAt = iso(Date.parse(queued.endAt) - duration);
        }
        result = mutation([obj]);
      } else if (/^\/factories\/\d+\/buy-slot$/.test(route)) {
        const obj = object(route.split('/')[2], 'factory'); const slots = factories.get(obj.defId).queueSlots;
        if (obj.factory.slots >= slots.max) fail('MAX_SLOTS', 'All queue slots are unlocked.'); pay(slots.xuPerSlot[obj.factory.slots - slots.start] || 5, 'xu'); obj.factory.slots++; result = mutation([obj]);
      } else if (/^\/factories\/\d+\/construction\/finish$/.test(route)) {
        const obj = object(route.split('/')[2], 'factory'); if (obj.construction) fail('NOT_READY', 'Construction is still in progress.'); result = mutation([obj]);
      } else if (/^\/trees\/\d+\/harvest$/.test(route)) {
        const obj = object(route.split('/')[2], 'tree'); const tree = trees.get(obj.defId);
        if (obj.tree.state !== 'MATURE') fail('NOT_MATURE', 'The fruit is not ripe yet.'); addItems({ [tree.product]: obj.tree.fruitRemaining || tree.fruitPerCycle });
        obj.tree.harvestsDone++; obj.tree.state = obj.tree.harvestsDone >= obj.tree.cyclesBeforeWither ? 'WITHERED' : 'GROWING'; obj.tree.readyAt = iso(now() + tree.cycleSeconds * 1000); obj.tree.fruitRemaining = tree.fruitPerCycle;
        const exp = addExp(tree.expPerHarvest); record('HARVEST_TREE', 1, { defId: tree.id }); result = mutation([obj], { exp });
      } else if (/^\/trees\/\d+\/revive-self$/.test(route)) {
        const obj = object(route.split('/')[2], 'tree'); if (obj.tree.state !== 'WITHERED') fail('VALIDATION', 'This tree has not withered.');
        pay(cfg.trees.reviveSelfXuCost, 'xu'); obj.tree.harvestsDone = 0; obj.tree.state = 'GROWING'; obj.tree.readyAt = iso(now() + trees.get(obj.defId).cycleSeconds * 1000); result = mutation([obj]);
      } else if (/^\/trees\/\d+\/chop$/.test(route)) {
        const obj = object(route.split('/')[2], 'tree'); removeItems({ riu: 1 }); state.objects = state.objects.filter(value => value.id !== obj.id); result = mutation([], { removed: [obj.id] });
      } else if (route === '/speed-up/quote') {
        const quote = speedTarget(Object.fromEntries(url.searchParams)); result = { remainingMs: quote.remainingMs, xuCost: quote.xuCost, goldCost: quote.goldCost };
      } else if (route === '/speed-up' || /^\/factories\/\d+\/construction\/speed-up$/.test(route)) {
        const target = speedTarget(body.target || { objId: integer(route.split('/')[2]), construction: true });
        const currency = body.pay === 'gold' ? 'gold' : 'xu'; const price = currency === 'gold' ? target.goldCost : target.xuCost;
        const expected = currency === 'gold' ? body.expectedGold : body.expectedXu;
        if (expected !== undefined && integer(expected) < price) fail('PRICE_CHANGED', 'The speed-up price changed. Request a new quote.');
        const construction = !!target.obj.construction;
        pay(price, currency); reduceTimer(target, target.remainingMs); record('SPEED_UP', 1, { defId: target.obj.defId, construction }); result = mutation([target.obj]);
      } else if (route === '/speed-up/item') {
        const item = cfg.itemSpeedUp.items[body.itemId]; if (!item) fail('VALIDATION', 'Choose a time reduction item.');
        const target = speedTarget(body.target); const construction = !!target.obj.construction;
        removeItems({ [body.itemId]: 1 }); reduceTimer(target, item.reduceSeconds * 1000); record('SPEED_UP', 1, { defId: target.obj.defId, construction }); result = mutation([target.obj]);
      } else if (route === '/shop') result = { tabs: {
        fields: fieldPrice(), buildings: [...definitions.values()].filter(def => def.kind === 'factory').map(shopEntry),
        pens: [...definitions.values()].filter(def => def.kind === 'pen').map(shopEntry), trees: [...definitions.values()].filter(def => def.kind === 'tree').map(shopEntry),
        decor: [...definitions.values()].filter(def => def.kind === 'decor').map(shopEntry),
        animals: [...animals.values()].map(def => ({ ...def, defId: def.id, currency: 'gold', ownedPens: state.objects.filter(obj => obj.defId === def.pen).length })),
        dogs: cfg.dogs.map(def => ({ ...def, owned: state.dog?.def === def.id })),
        consumables: [...items.values()].filter(def => def.shop).map(def => ({ itemId: def.id, name: def.name, ...def.shop, sellPrice: def.sellPrice })), xu: [],
      } };
      else if (route === '/shop/seeds') result = { seeds: [...crops.values()].filter(crop => crop.unlockLevel <= state.wallet.level).map(crop => ({
        cropId: crop.id, name: crop.name, have: have(crop.id), goldPrice: Math.max(1, Math.ceil((items.get(crop.id)?.sellPrice || crop.value) * 1.5)), xuPrice: 1,
        goldDailyRemaining: 999, xuDailyRemaining: 999, goldDailyLimit: 999, xuDailyLimit: 999,
      })) };
      else if (route === '/shop/seeds/buy') {
        const crop = crops.get(body.cropId); if (!crop) fail('VALIDATION', 'Choose a crop.'); requireLevel(crop.unlockLevel);
        const qty = integer(body.qty); if (qty < 1 || qty > 99) fail('VALIDATION', 'Choose 1–99 seeds.');
        const currency = body.pay === 'xu' ? 'xu' : 'gold'; pay(qty * (currency === 'xu' ? 1 : Math.max(1, Math.ceil((items.get(crop.id)?.sellPrice || crop.value) * 1.5))), currency);
        addItems({ [crop.id]: qty }); result = mutation();
      } else if (route === '/shop/consumables/buy') {
        const item = items.get(body.itemId); if (!item?.shop) fail('VALIDATION', 'This item is not for sale.');
        const qty = integer(body.qty); if (qty < 1 || qty > 20) fail('VALIDATION', 'Choose 1–20 items.'); pay(item.shop.price * qty, item.shop.currency); addItems({ [item.id]: qty }); result = mutation();
      } else if (route === '/shop/decor/buy') {
        const def = defFor(body.defId); if (def.kind !== 'decor') fail('VALIDATION', 'Choose decoration.'); requireLevel(def.unlockLevel);
        const qty = integer(body.qty); if (qty < 1 || qty > 10) fail('VALIDATION', 'Choose 1–10 decorations.'); pay(def.price * qty, def.currency);
        for (let i = 0; i < qty; i++) { const obj = makeObject(def.id, 0, 0); obj.stored = true; state.objects.push(obj); }
        addExp((def.expOnBuy || 0) * qty);
        const entry = state.bag.find(value => value.itemId === def.id); if (entry) entry.qty += qty; else state.bag.push({ itemId: def.id, qty }); result = mutation([], { bag: state.bag });
      } else if (route === '/shop/dogs/buy') {
        const dog = cfg.dogs.find(value => value.id === body.dogId); if (!dog) fail('VALIDATION', 'Choose a dog.'); requireLevel(dog.unlockLevel); pay(dog.price, dog.currency);
        state.dog = { def: dog.id, active: false, fedUntil: null, foodStackSeconds: 0 }; record('BUY_DOG'); result = mutation([], { dog: state.dog });
      } else if (route === '/quests') result = quests();
      else if (/^\/quests\/.+\/claim$/.test(route)) {
        const id = decodeURIComponent(route.split('/')[2]); const quest = [...quests().main, ...quests().daily].find(value => value.id === id);
        if (!quest || !quest.completedAt || quest.claimedAt || quest.locked) fail('NOT_CLAIMABLE', 'Complete the quest first.');
        reward(quest.reward); state.claimedQuests.push(id); result = mutation([], { questId: id, reward: quest.reward });
      } else if (/^\/achievements\/.+\/claim$/.test(route)) {
        const id = decodeURIComponent(route.split('/')[2]); const def = bundle.quests.achievements.find(value => value.id === id);
        const tier = integer(body.tier); const key = `${id}:${tier}`;
        if (!def || !def.tiers[tier - 1] || (state.counters[def.event] || 0) < def.tiers[tier - 1] || state.claimedAchievements.includes(key)) fail('NOT_CLAIMABLE', 'Complete the achievement first.');
        const prize = normalizeReward(def.rewardPerTier[tier - 1]); reward(prize); state.claimedAchievements.push(key); result = mutation([], { reward: prize, titleId: `${id}_${tier}` });
      } else if (route === '/achievements') result = { achievements: bundle.quests.achievements.map(def => ({ id: def.id, title: def.title, event: def.event,
        tiers: def.tiers.map((threshold, index) => ({ tier: index + 1, threshold, progress: Math.min(threshold, state.counters[def.event] || 0),
          reward: normalizeReward(def.rewardPerTier[index]), titleId: `${def.id}_${index + 1}`, completedAt: (state.counters[def.event] || 0) >= threshold ? iso(now()) : null,
          claimedAt: state.claimedAchievements.includes(`${def.id}:${index + 1}`) ? state.user.createdAt : null })) })) };
      else if (route === '/titles') result = { active: state.user.activeTitle || null, catalog: bundle.quests.achievements.flatMap(def =>
        def.tiers.map((_, index) => ({ id: `${def.id}_${index + 1}`, achievementId: def.id, tier: index + 1,
          name: `${def.title} ${index + 1}`, owned: state.claimedAchievements.includes(`${def.id}:${index + 1}`) }))) };
      else if (route === '/checkin' && method === 'GET') result = checkin();
      else if ((route === '/checkin' || route === '/checkin/claim') && method === 'POST') {
        if (state.checkinDay === today()) fail('ALREADY_CLAIMED', 'You already checked in today.');
        state.streakDay = state.streakDay % 7 + 1; state.checkinDay = today(); const value = normalizeReward(cfg.dailyLogin.rewards[state.streakDay - 1]); reward(value); result = mutation([], { reward: value, streakDay: state.streakDay });
      } else if (route === '/chests' && method === 'GET') result = { freeAvailable: state.chestDay !== today(), extraCostXu: chests.extraCostXu,
        openedToday: state.chestDay === today() ? state.chestsToday : 0, odds: chests.table.map(value => ({ pct: Math.round(100 * value.weight / chests.table.reduce((sum, entry) => sum + entry.weight, 0)), reward: normalizeReward(value.reward) })) };
      else if ((route === '/chests' || route === '/chests/open') && method === 'POST') {
        if (state.chestDay === today()) { if (!body.payWithXu) fail('ALREADY_CLAIMED', 'The free chest is already opened.'); pay(chests.extraCostXu, 'xu'); }
        else { state.chestDay = today(); state.chestsToday = 0; }
        const total = chests.table.reduce((sum, entry) => sum + entry.weight, 0); let point = random() * total;
        const prize = chests.table.find(entry => (point -= entry.weight) <= 0) || chests.table[0]; reward(prize.reward); state.chestsToday++; result = mutation([], { reward: normalizeReward(prize.reward), idx: state.chestsToday });
      } else if (route === '/orders/truck') result = { orders: truckOrders() };
      else if (/^\/orders\/truck\/\d+\/deliver$/.test(route)) {
        const order = truckOrders().find(value => value.slot === integer(route.split('/')[3])); if (!order || order.status !== 'open') fail('ORDER_NOT_READY', 'This order is not ready.');
        removeItems(Object.fromEntries(order.lines.map(value => [value.itemId, value.qty]))); state.wallet.gold += order.rewardGold; const exp = addExp(order.rewardExp);
        order.status = 'cooldown'; order.availableAt = iso(now() + 60000); record('TRUCK_DELIVER'); result = mutation([], { order, exp });
      } else if (/^\/orders\/truck\/\d+\/delete$/.test(route)) {
        const order = truckOrders().find(value => value.slot === integer(route.split('/')[3])); if (!order) fail('NOT_FOUND', 'Order not found.');
        order.status = 'cooldown'; order.availableAt = iso(now() + 30000); result = mutation([], { order });
      } else if (route === '/orders/boat') result = { boat: { id: null, status: 'none', crates: [], helpRequestsLeft: 0 } };
      else if (route === '/events') result = { events: [] };
      else if (route === '/flags') result = { flags: {} };
      else if (route === '/ads/status') result = { enabled: false, placements: [], provider: 'none', serverTime: iso(now()) };
      else if (route === '/affiliate/links') result = { links: [] };
      else if (route === '/chat/global/messages') result = { items: [], nextCursor: null, disabled: true };
      else if (route === '/chat/summary') result = { global: { key: 'global', disabled: true, latest: null }, province: null, village: null, hamlet: null, hiddenUserIds: [] };
      else if (route === '/dm/threads') result = { items: [], totalUnread: 0, disabled: true };
      else if (route === '/giftcode/announcements') result = { codes: [] };
      else if (route === '/leaderboards/spotlight') result = { generatedAt: iso(now()), boards: [] };
      else if (route === '/pass/current') result = { seasonId: state.user.id, premium: false, xp: 0, level: 0, claimedFree: [], claimedPremium: [] };
      else if (route === '/hamlets/me/help') result = { items: [] };
      else if (route === '/hamlets/me') result = { hamlet: null };
      else if (route === '/friends') result = { friends: [], requests: [], outgoing: [] };
      else if (route === '/friends/requests') result = { incoming: [], outgoing: [] };
      else if (route === '/mailbox') result = { items: [], count: 0, max: cfg.mailbox.maxItems };
      else if (route === '/logs') result = { items: state.logs, nextCursor: null, seenAt: iso(now()) };
      else if (route === '/analytics/events' || route === '/analytics' || route === '/telemetry/client') result = { ok: true };
      else if (route === '/health') result = { ok: true, serverTime: iso(now()), configVersion: config.version, build: 'dev', mode: 'local-single-player' };
      else return false;
      // Progress one matching step per action, with the original metadata and level gates.
      if (method !== 'GET' && !route.startsWith('/auth')) {
        const step = tutorial[state.user.tutorialStep];
        if (step?.event && before.wallet.level >= step.level && mutationEvents.some(value => value.event === step.event && Object.entries(step.filter || {}).every(([key, expected]) => value.meta[key] === expected))) {
          state.user.tutorialStep++; normalizeTutorial();
        }
      }
      if (state.user.tutorialStep !== before.user.tutorialStep && result && typeof result === 'object') result.tutorialStep = state.user.tutorialStep;
      if (JSON.stringify(state) !== JSON.stringify(before)) save();
      committed = true;
      // A disconnected update listener cannot turn a committed purchase into an error.
      try { onMutation({ route, result, tutorialStep: state.user.tutorialStep, previousTutorialStep: before.user.tutorialStep, serverTime: iso(now()), user: publicUser() }); } catch {}
      send(res, result);
    } catch (error) {
      if (!committed) state = before;
      send(res, { error: { code: error.code || 'VALIDATION', message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status || 400);
    }
    return true;
  }
  return { handle, reload, getState: () => clone(state), now: () => iso(now()), getServerTime: () => iso(now()),
    setOnMutation: callback => { onMutation = callback; }, getWorld: () => { tick(); return world(); }, save };
}
