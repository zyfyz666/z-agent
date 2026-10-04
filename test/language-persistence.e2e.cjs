'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-language-persistence-e2e-'));

async function launch() {
  return electron.launch({
    executablePath: require('electron'),
    args: [appRoot],
    cwd: appRoot,
    env: {
      ...process.env,
      Z_E2E_MODE: '1',
      Z_E2E_USER_DATA_DIR: userDataDir
    }
  });
}

async function waitForRendererReady(page, language = '') {
  await page.waitForFunction(() => (
    document.readyState === 'complete'
      && typeof z !== 'undefined'
      && document.documentElement.dataset.language
  ));
  if (language) {
    await page.waitForFunction(expected => document.documentElement.dataset.language === expected, language);
  }
}

(async () => {
  let application;
  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.waitForFunction(() => typeof z !== 'undefined');
    await page.locator('#settingsBtn').click();
    await page.locator('[data-tab="general"]').click();
    await page.locator('#languageSegmented [data-lang="en"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.language === 'en');
    const saved = await page.evaluate(() => z.getConfig());
    assert.equal(saved.language, 'en');
    await page.reload();
    await waitForRendererReady(page, 'en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('html').getAttribute('data-language'), 'en');
    const config = await page.evaluate(() => z.getConfig());
    assert.equal(config.language, 'en');

    await page.locator('#languageSegmented [data-lang="en"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#languageSegmented [data-lang="en"]').getAttribute('aria-checked'), 'true');

    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await waitForRendererReady(page, 'en');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    console.log(JSON.stringify({ ok: true, language: 'en', persistedAcrossRestart: true }));
  } finally {
    await application?.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
