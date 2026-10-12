const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.XNT_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const target = process.env.XNT_QA_URL || 'http://127.0.0.1:5173/';
  const out = path.resolve(__dirname, '../.local/review-qa/frontend-menu');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.XNT_CHROME_PATH ? { executablePath: process.env.XNT_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN' });
  const page = await context.newPage();
  const report = { target, errors: [], consoleErrors: [], cases: [] };
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  async function setup() {
    await page.goto(target); await page.waitForFunction(() => document.querySelector('[data-testid="login-play"]') || document.querySelector('#root canvas'));
    if (await page.getByTestId('login-play').isVisible()) await page.getByTestId('login-play').click();
    await page.locator('canvas').first().waitFor(); await page.waitForTimeout(750);
    if (await page.getByTestId('tutorial-skip').isVisible()) await page.getByTestId('tutorial-skip').click();
    await page.evaluate(() => {
      window.failedAPI = []; const original = window.fetch;
      window.fetch = async (...args) => { const response = await original(...args); if (!response.ok) { let data; try { data = await response.clone().json(); } catch {} failedAPI.push({ url: String(args[0]), status: response.status, data }); } return response; };
    });
  }
  try {
    await setup(); await page.getByTestId('hud-menu').click();
    report.menuButtons = await page.locator('button,a').evaluateAll(elements => elements.filter(e => e.getBoundingClientRect().width && e.closest('[data-testid="hud-menu-sheet"]')).map(e => ({ id: e.dataset.testid, text: e.innerText, actionId: e.dataset.actionId, action: e.dataset.action, online: e.dataset.xntOnline, href: e.getAttribute('href') })));
    // Menu sheet's exact test ID is optional; preserve every action-bearing menu control.
    report.visibleActions = await page.locator('button,a').evaluateAll(elements => elements.filter(e => e.getBoundingClientRect().width).map(e => ({ id: e.dataset.testid, text: e.innerText, actionId: e.dataset.actionId, action: e.dataset.action, online: e.dataset.xntOnline, href: e.getAttribute('href') })));
    for (const id of ['dock-hamlet', 'dock-explore', 'dock-leaderboard', 'dock-marketLevels', 'dock-watch', 'dock-reputation', 'dock-fair', 'dock-feedbackFame']) {
      await setup(); await page.getByTestId('hud-menu').click();
      const control = page.getByTestId(id);
      const attributes = await control.evaluate(e => ({ id: e.dataset.testid, text: e.innerText, actionId: e.dataset.actionId, action: e.dataset.action, online: e.dataset.xntOnline, disabled: e.disabled }));
      if (!attributes.disabled) await control.click();
      await page.waitForTimeout(650);
      const state = await page.evaluate(() => ({ notice: !!document.querySelector('[data-testid="local-availability"]'), failedAPI, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(e => e.dataset.testid), text: document.body.innerText.slice(-1800) }));
      const image = path.join(out, 'menu-' + id + '.png'); await page.screenshot({ path: image });
      report.cases.push({ ...attributes, ...state, image });
      console.log(JSON.stringify({ id, ...attributes, notice: state.notice, failedAPI: state.failedAPI, dialogs: state.dialogs }));
    }
    for (const item of report.cases) {
      assert.equal(item.notice, true, `${item.id} must show an availability explanation`);
      assert.deepEqual(item.failedAPI, [], `${item.id} must not dispatch unsupported API requests`);
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    report.pass = true;
  } catch (error) { report.error = String(error); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ target, pass: !!report.pass, cases: report.cases.length, errors: report.errors, consoleErrors: report.consoleErrors, output: out, ...(report.error ? { error: report.error } : {}) })); await browser.close(); }
})();
