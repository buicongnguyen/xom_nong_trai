const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
// Optional browser QA: install Playwright, or set XNT_PLAYWRIGHT_MODULE to it.
const { chromium } = require(process.env.XNT_PLAYWRIGHT_MODULE || 'playwright');
const target = path.resolve(__dirname, '..');
const runtimeSource = path.join(target, 'browser/pages-entry.mjs');
const sourceRoot = target;
const report = { cases: [] };

(async () => {
  const config = fs.readFileSync(path.join(sourceRoot, 'config/game.json'));
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/xom_nong_trai/pages-runtime.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(runtimeSource, 'utf8').replace("'../src/backend.mjs'", "'./src/backend.mjs'"));
    } else if (/^\/xom_nong_trai\/src\/(?:backend|tutorial)\.mjs$/.test(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(sourceRoot, 'src', path.basename(req.url)), 'utf8')
        .replace("'node:fs'", "'../browser/browser-fs.mjs'")
        .replace("'node:path'", "'../browser/browser-path.mjs'")
        .replace("'node:crypto'", "'../browser/browser-crypto.mjs'"));
    } else if (/^\/xom_nong_trai\/browser\/browser-(?:fs|path|crypto)\.mjs$/.test(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      const staged = path.join(sourceRoot, 'browser', path.basename(req.url));
      res.end(fs.readFileSync(fs.existsSync(staged) ? staged : path.join(target, 'browser', path.basename(req.url))));
    } else if (req.url === '/xom_nong_trai/config/game.json') {
      res.setHeader('Content-Type', 'application/json'); res.end(config);
    } else if (req.url === '/xom_nong_trai/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<script type="module">
import {bootPagesRuntime} from './pages-runtime.js';
window.__backend = await bootPagesRuntime();
window.messages=[];window.ws=new WebSocket(new URL('ws', location.href).href.replace(/^http/,'ws'));
ws.onmessage=event=>messages.push(JSON.parse(event.data));
window.ready=true;
</script>`);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/xom_nong_trai/`;
  const browser = await chromium.launch({
    ...(process.env.XNT_CHROME_PATH ? { executablePath: process.env.XNT_CHROME_PATH } : {}), headless: true,
  });
  const open = async context => { const page = await context.newPage(); await page.goto(url); await page.waitForFunction(() => window.ready && messages.some(x => x.t === 'hello')); return page; };
  const api = (page, route, body, method = body ? 'POST' : 'GET') => page.evaluate(async ({ route, body, method }) => {
    const response = await fetch('/api' + route, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    return { status: response.status, data: await response.json() };
  }, { route, body, method });
  const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.endsWith(':farm/farm.json')))));
  const run = async (name, fn) => {
    const context = await browser.newContext();
    try { await fn(context); report.cases.push({ name, pass: true }); }
    catch (error) { report.cases.push({ name, pass: false, error: String(error) }); }
    finally { await context.close(); }
  };
  try {
    await run('unloading a stale tab cannot erase a completed harvest', async context => {
      const a = await open(context), b = await open(context);
      const before = await saved(a); const ripe = before.objects.find(o => o.field?.state === 'MATURE');
      assert.equal((await api(a, '/fields/harvest', { objIds: [ripe.id] })).status, 200);
      const committed = await saved(a);
      assert.equal(committed.objects.find(o => o.id === ripe.id).field.state, 'EMPTY');
      await b.goto('about:blank');
      const after = await saved(a);
      assert.equal(after.objects.find(o => o.id === ripe.id).field.state, 'EMPTY', 'stale tab restored a harvested field to MATURE');
      assert.equal(after.inventory.lua, committed.inventory.lua);
      assert.deepEqual(after.wallet, committed.wallet);
    });
    await run('alternating tab mutations keep both inventory sales', async context => {
      const a = await open(context), b = await open(context);
      const before = await saved(a);
      const item = JSON.parse(config).bundle.items.items.find(i => i.id === 'lua');
      assert.ok(before.inventory.lua >= 2);
      assert.equal((await api(a, '/storage/sell-npc', { itemId: 'lua', qty: 1 })).status, 200);
      assert.equal((await api(b, '/storage/sell-npc', { itemId: 'lua', qty: 1 })).status, 200);
      const after = await saved(a);
      assert.equal(after.inventory.lua, before.inventory.lua - 2, 'second tab overwrote first sale');
      assert.equal(after.wallet.gold, before.wallet.gold + 2 * item.sellPrice);
    });
    await run('simultaneous tab transactions keep every sale', async context => {
      const pages = await Promise.all(Array.from({ length: 4 }, () => open(context)));
      const before = await saved(pages[0]);
      const results = await Promise.all(pages.map(p => api(p, '/storage/sell-npc', { itemId: 'lua', qty: 1 })));
      for (const response of results) assert.equal(response.status, 200);
      const after = await saved(pages[0]);
      assert.equal(after.inventory.lua, before.inventory.lua - pages.length, 'concurrent tabs lost successful transactions');
    });
    await run('other tabs receive a changed field without requesting its world', async context => {
      const a = await open(context), b = await open(context);
      const ripe = (await saved(a)).objects.find(o => o.field?.state === 'MATURE');
      assert.equal((await api(a, '/fields/harvest', { objIds: [ripe.id] })).status, 200);
      await b.waitForFunction(id => messages.some(m => m.t === 'world_delta' && m.p.objects.some(o => o.id === id && o.field?.state === 'EMPTY')), ripe.id, { timeout: 3000 });
    });
    await run('passive timer completion emits a construction removal', async context => {
      const a = await open(context);
      const state = await saved(a), object = state.objects.find(o => o.kind === 'factory');
      const time = await a.evaluate(() => Date.parse(__backend.getServerTime()));
      object.construction = { startedAt: new Date(time).toISOString(), endsAt: new Date(time + 300).toISOString() };
      await a.evaluate(state => {
        const key = Object.keys(localStorage).find(k => k.endsWith(':farm/farm.json'));
        localStorage.setItem(key, JSON.stringify(state));
      }, state);
      await a.reload(); await a.waitForFunction(() => window.ready && messages.some(x => x.t === 'hello'));
      await a.waitForFunction(id => messages.some(m => m.t === 'world_delta' && m.p.objects.some(o => o.id === id && !o.construction)), object.id, { timeout: 4000 });
    });
    await run('resetting browser storage prevents old tabs from resurrecting a farm', async context => {
      const a = await open(context), b = await open(context);
      const previous = await saved(a);
      await a.evaluate(() => localStorage.clear());
      const response = await api(b, '/storage/sell-npc', { itemId: 'lua', qty: 1 });
      assert.equal(response.status, 409);
      assert.equal(response.data.error.code, 'SAVE_RESET');
      await b.locator('#xnt-local-save-reset').waitFor({ state: 'visible' });
      assert.equal(await saved(a), null);
      await b.goto('about:blank');
      assert.equal(await saved(a), null, 'closing stale tab recreated cleared save');
      await a.reload(); await a.waitForFunction(() => window.ready && messages.some(x => x.t === 'hello'));
      assert.notEqual((await saved(a)).user.id, previous.user.id, 'explicit reload creates a new farm');
    });
    await run('a stale tab cannot mutate a replacement farm after a quick reset', async context => {
      const a = await open(context), b = await open(context);
      const replacement = await saved(a);
      replacement.user.id = '747f47a4-b8b8-4db5-960a-02f9000137a0';
      await a.evaluate(state => {
        const key = Object.keys(localStorage).find(k => k.endsWith(':farm/farm.json'));
        localStorage.setItem(key, JSON.stringify(state));
      }, replacement);
      const response = await api(b, '/storage/sell-npc', { itemId: 'lua', qty: 1 });
      assert.equal(response.status, 409);
      assert.equal(response.data.error.code, 'SAVE_RESET');
      assert.deepEqual((await saved(a)).inventory, replacement.inventory);
      assert.deepEqual((await saved(a)).wallet, replacement.wallet);
    });
  } finally {
    const output = path.join(target, '.local', 'review-qa');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'browser-save-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser.close(); await new Promise(resolve => server.close(resolve));
    if (report.cases.some(result => !result.pass)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
