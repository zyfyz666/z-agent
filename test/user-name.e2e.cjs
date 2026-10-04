'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { LEGACY_NAMESPACE, LEGACY_STORAGE } = require('../lib/legacy-compat');
const legacyDefaultName = `${LEGACY_NAMESPACE.title}xi`;

const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-user-name-e2e-'));
const outputDir = path.join(appRoot, 'output', 'z-workbench');
const screenshotPath = path.join(outputDir, 'user-name-z.png');
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.join(userDataDir, LEGACY_STORAGE.stableDataDir), { recursive: true });
// Exercise an old profile's default name without reading a real user profile.
fs.writeFileSync(path.join(userDataDir, LEGACY_STORAGE.stableDataDir, 'config.json'), JSON.stringify({ userName: legacyDefaultName, language: 'zh-CN' }));
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

    assert.equal(await page.evaluate(async () => (await window.z.getConfig()).userName), legacyDefaultName,
      'the existing profile is loaded and its stored name is preserved until the user edits it');
    assert.equal(await page.locator('#greeting').textContent(), '下一步，交给 Z。');
    assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(legacyDefaultName, 'i'));
    await page.locator('#settingsBtn').click();
    await page.locator('#userNameInput').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#userNameInput').inputValue(), '', 'the legacy default must not appear as a personal name');
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

    console.log(JSON.stringify({ ok: true, screenshotPath, legacyDefaultHidden: true, personalNamePersisted: true, pageErrors }));
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
