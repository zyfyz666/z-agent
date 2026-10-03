'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'z-visible-brand-e2e-'));
const outputDir = path.join(appRoot, 'output', 'z-workbench');
const env = { ...process.env, YAN_E2E_MODE: '1', YAN_E2E_USER_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;
const report = { ok: false, pageErrors: [], surfaces: [], screenshots: [] };
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  let application;
  let page;
  const scan = async (selector, name, filename, surface = page) => {
    const visible = await surface.locator(selector).evaluate(root => {
      const text = [];
      const visibleElement = element => element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
        && !element.closest('script,style,pre,code,.capability-file-path');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) if (visibleElement(walker.currentNode.parentElement)) text.push(walker.currentNode.nodeValue);
      const images = [];
      for (const element of [root, ...root.querySelectorAll('*')]) {
        if (!visibleElement(element)) continue;
        for (const attribute of ['title', 'aria-label', 'alt']) if (element.getAttribute(attribute)) text.push(element.getAttribute(attribute));
        if (element.tagName === 'IMG') images.push({ src: element.getAttribute('src'), alt: element.getAttribute('alt') });
      }
      return { text: text.join('\n'), images };
    });
    report.surfaces.push({ name, ...visible });
    const file = path.join(outputDir, filename);
    await page.screenshot({ path: file });
    report.screenshots.push(file);
    assert.doesNotMatch(visible.text, /\bYan\b|YAgent|YanAgent|Yanxi|WD\s+Agent/i, name + ' must use current product branding');
    return visible;
  };
  try {
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
    page = await application.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userData));

    await page.locator('[data-nav="skills"]').click();
    await page.locator('#pageSkills').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#skillMarketGrid .skill-card').length > 0);
    await scan('#pageSkills', 'Skill market', 'skills-z.png');
    report.skillCount = await page.locator('#skillMarketGrid .skill-card').count();

    await page.locator('[data-nav="mcp"]').click();
    await page.locator('#pageMcp').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#mcpPageList .mcp-card').length > 0);
    await scan('#pageMcp', 'MCP services', 'mcp-z.png');
    report.mcpCount = await page.locator('#mcpPageList .mcp-card').count();

    await page.locator('#newTaskNavBtn').click();
    await page.locator('#pageChat').waitFor({ state: 'visible' });
    await page.locator('[data-window-view="project-map"]').click();
    assert.equal(await page.evaluate(() => currentWindowView), 'main', 'empty workspace is guarded before generating a project map');
    // Also inspect the viewer's own empty state without creating a project,
    // invoking code analysis, or using a model.
    await page.evaluate(() => window.YanUnderstandAnything.open(''));
    await page.locator('#understandAnythingLayer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#understandAnythingStatus').innerText(), '请先选择工作区');
    await scan('#understandAnythingLayer', 'Project map empty state', 'project-map-empty-z.png');
    await page.evaluate(() => window.YanUnderstandAnything.close({ silent: true }));

    assert.equal(await page.locator('[data-window-view="work-gui"]').count(), 0, 'removed visual workspace has no navigation entry');
    assert.equal(await page.locator('#pageWorkGui').count(), 0, 'removed visual workspace has no page container');
    assert.deepEqual(await page.evaluate(() => ({
      workGui: typeof window.YanWorkGui,
      palaceHost: typeof window.YanTiangongHost,
      palaceSubmit: typeof window.YanPalaceSubmit,
    })), { workGui: 'undefined', palaceHost: 'undefined', palaceSubmit: 'undefined' }, 'removed visual workspace has no global bridges');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('script[src],link[href]')]
      .map(element => element.getAttribute('src') || element.getAttribute('href'))
      .filter(resource => /work-gui|palace|(?:^|\/)three(?:[.\/-]|$)/i.test(resource))), [], 'removed visual workspace resources are not loaded');
    assert.deepEqual(await page.evaluate(async () => {
      await showWindowView('work-gui');
      return { view: currentWindowView, page: currentMainPage };
    }), { view: 'main', page: 'chat' }, 'old visual workspace route falls back to normal chat');
    await page.locator('#pageChat').waitFor({ state: 'visible' });
    await page.locator('#composerInput').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#composerInput').isEditable(), 'normal chat remains editable');
    await page.locator('#wdMonitorNavBtn').click();
    await page.locator('#rs-watchdog .wd-monitor').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => activeRightSidebarTab), 'watchdog', 'WD monitor still opens');
    await scan('body', 'Normal workbench with WD', 'z-final-workbench.png');
    assert.deepEqual(report.pageErrors, []);
    report.ok = true;
    console.log(JSON.stringify({ ok: true, skillCount: report.skillCount, mcpCount: report.mcpCount,
      surfaces: report.surfaces.map(item => item.name), screenshots: report.screenshots, pageErrors: report.pageErrors }));
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(outputDir, 'visible-brand-failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(outputDir, 'visible-brand-report.json'), JSON.stringify(report, null, 2));
    await application?.close().catch(() => {});
    const resolved = path.resolve(userData);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-visible-brand-e2e-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
