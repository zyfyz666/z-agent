'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z-onboarding-e2e-'));
const outputDir = path.join(appRoot, 'output', 'z-workbench');
const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: userDataDir };
delete env.ELECTRON_RUN_AS_NODE;
const forbidden = /\bYan(?:[- ]?Agent)?\b|YAgent|Yanxi|WD\s+Agent|ViaTum|抖音群|QQ\s*群|994525685197/i;
const report = { ok: false, pageErrors: [], checkedSurfaces: [], screenshots: [] };
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  let application;
  let page;
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const screenshot = async name => {
    const file = path.join(outputDir, name);
    await page.screenshot({ path: file });
    report.screenshots.push(file);
  };
  const scan = async (selector, label) => {
    const text = await page.locator(selector).evaluate(root => {
      const strings = [root.innerText];
      for (const element of [root, ...root.querySelectorAll('*')]) {
        if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
        for (const name of ['title', 'aria-label', 'placeholder', 'alt', 'href']) {
          const value = element.getAttribute(name);
          if (value) strings.push(value);
        }
      }
      return strings.join('\n');
    });
    assert.doesNotMatch(text, forbidden, `${label} must not display the previous product or community`);
    report.checkedSurfaces.push(label);
    return text;
  };
  const guidePages = async (count, label, screenshotName) => {
    const dialog = page.locator('#visionRelayGuideDialog');
    await dialog.waitFor({ state: 'visible' });
    for (let index = 0; index < count; index += 1) {
      await page.waitForFunction(expected => document.querySelector('#visionRelayGuideStepLabel').textContent === expected, `${index + 1} / ${count}`);
      await settle();
      assert.ok((await page.locator('#visionRelayGuidePageTitle').innerText()).trim(), `${label} page title`);
      assert.ok((await page.locator('#visionRelayGuidePageCopy').innerText()).trim().length > 30, `${label} page content`);
      await scan('#visionRelayGuideDialog', `${label} ${index + 1}/${count}`);
      if (index === 0 && screenshotName) await screenshot(screenshotName);
      await page.locator('#visionRelayGuideNext').click();
    }
    await dialog.waitFor({ state: 'hidden' });
  };
  try {
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
    page = await application.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && window.ZProductContent);
    const profile = await application.evaluate(({ app }) => ({ name: app.getName(), path: app.getPath('userData') }));
    assert.equal(profile.name, 'Z');
    assert.equal(path.resolve(profile.path), path.resolve(userDataDir));
    report.isolatedProfile = true;

    assert.equal(await page.title(), 'Z');
    assert.equal(await page.locator('#greeting').innerText(), '下一步，交给 Z。');
    assert.equal(await page.locator('.z-hero-emblem').isVisible(), true);
    await scan('body', 'Z home');
    await page.locator('#guideBtn').click();
    assert.equal(await page.locator('#visionRelayGuideTitle').innerText(), 'Z 使用指南');
    await guidePages(7, 'Z guide', 'guide-z.png');

    await page.locator('#settingsBtn').click();
    await page.locator('#settingsSidebarNav [data-tab="about"]').click();
    await page.locator('#tab-about').waitFor({ state: 'visible' });
    const aboutText = await scan('#settingsOverlay', 'Z about');
    assert.match(aboutText, /关于\s*Z/);
    assert.equal(await page.locator('#aboutContactPicker, #aboutContactCopy, #aboutContactValue, [data-about-contact]').count(), 0,
      'upstream community controls must be removed');
    assert.equal(await page.locator('#aboutCheckUpdateBtn').count(), 0,
      'the previous product updater must not remain in Z');
    await screenshot('about-z.png');

    await page.locator('#aboutReleaseNotesBtn').click();
    assert.equal(await page.locator('#visionRelayGuideTitle').innerText(), 'Z 更新说明');
    await guidePages(3, 'Z release notes');

    await page.locator('#aboutErrorsBtn').click();
    await page.locator('#aboutErrorDialog').waitFor({ state: 'visible' });
    for (let index = 0; index < 6; index += 1) {
      assert.equal(await page.locator('#aboutErrorStepLabel').innerText(), `${index + 1} / 6`);
      assert.ok((await page.locator('#aboutErrorPageTitle').innerText()).trim());
      assert.ok((await page.locator('#aboutErrorPageCopy').innerText()).trim().length > 30);
      await scan('#aboutErrorDialog', `Z common errors ${index + 1}/6`);
      await page.locator('#aboutErrorNext').click();
    }
    await page.locator('#aboutErrorDialog').waitFor({ state: 'hidden' });
    await page.locator('#closeSettings').click();

    // Exercise the same local help in English without making a model request.
    await page.evaluate(() => applyLanguage('en'));
    await settle();
    assert.equal(await page.locator('#greeting').innerText(), 'Your next step, with Z.');
    await scan('body', 'Z home English');
    await page.locator('#guideBtn').click();
    await settle();
    assert.equal(await page.locator('#visionRelayGuideTitle').innerText(), 'Using Z');
    await guidePages(7, 'Z guide English');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) await screenshot('onboarding-failure.png').catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(outputDir, 'onboarding-report.json'), JSON.stringify(report, null, 2));
    await application?.close().catch(() => {});
    const resolved = path.resolve(userDataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-onboarding-e2e-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
