'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { findObsoleteBrand } = require('./helpers/obsolete-brand.cjs');

const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-user-name-e2e-'));
const outputDir = path.join(appRoot, 'output', 'z-workbench');
const screenshotPath = path.join(outputDir, 'user-name-z.png');
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.join(userDataDir, 'ZData'), { recursive: true });
// Seed a synthetic profile without a personal name; never read a real user profile.
fs.writeFileSync(path.join(userDataDir, 'ZData', 'config.json'), JSON.stringify({ language: 'zh-CN' }));
const pageErrors = [];

async function launch() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: userDataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    executablePath: require('electron'),
    args: [appRoot],
    cwd: appRoot,
    env
  });
  try {
    const page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady
      && window.ZProductContent && typeof normalizeUserName === 'function');
    const activeProfile = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(path.resolve(activeProfile), path.resolve(userDataDir));
    return { application, page };
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
}

(async () => {
  let application;
  try {
    let launched = await launch();
    application = launched.application;
    let page = launched.page;

    assert.equal(await page.evaluate(async () => (await window.z.getConfig()).userName || ''), '',
      'the seeded profile is loaded without a personal name');
    assert.equal(await page.locator('#greeting').textContent(), '下一步，交给 Z。');
    assert.deepEqual(findObsoleteBrand(await page.locator('body').innerText()), [], 'the page must not show the obsolete product name');
    await page.locator('#settingsBtn').click();
    await page.locator('#userNameInput').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#userNameInput').inputValue(), '', 'an empty profile shows no personal name');
    assert.equal(await page.locator('#tab-general #userNameInput').count(), 1, 'name is edited in General settings');

    await page.locator('#userNameInput').click();
    await page.locator('#userNameInput').fill('Alice');
    assert.equal(await page.locator('#greeting').textContent(), 'Alice，下一步做什么？');
    await page.locator('#userNameInput').press('Enter');
    await page.waitForFunction(async () => (await window.z.getConfig()).userName === 'Alice');

    const geometry = await page.evaluate(() => {
      const input = document.querySelector('#userNameInput').getBoundingClientRect();
      const card = document.querySelector('.general-user-card').getBoundingClientRect();
      return {
        inputLeft: input.left,
        inputRight: input.right,
        inputWidth: input.width,
        cardLeft: card.left,
        cardRight: card.right
      };
    });
    assert.ok(geometry.inputLeft >= geometry.cardLeft);
    assert.ok(geometry.inputRight <= geometry.cardRight);
    assert.ok(geometry.inputWidth >= 100, 'name field remains usable in its settings card');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await page.locator('#closeSettings').click();
    assert.equal(await page.locator('#greeting').innerText(), 'Alice，下一步做什么？');

    await application.close();
    application = null;

    launched = await launch();
    application = launched.application;
    page = launched.page;
    assert.equal(await page.locator('#greeting').innerText(), 'Alice，下一步做什么？');
    await page.locator('#settingsBtn').click();
    await page.locator('#userNameInput').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#userNameInput').inputValue(), 'Alice');
    assert.equal(await page.evaluate(async () => (await window.z.getConfig()).userName), 'Alice');
    assert.deepEqual(pageErrors, []);

    console.log(JSON.stringify({ ok: true, screenshotPath, emptyNameShown: true, personalNamePersisted: true, pageErrors }));
  } finally {
    await application?.close().catch(() => {});
    const resolved = path.resolve(userDataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-user-name-e2e-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
