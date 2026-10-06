'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { _electron } = require('playwright');
const observation = require('../renderer/browser-page-observation');

let application, page, server, crossServer, root;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const closeServer = server => new Promise(resolve => server ? server.close(resolve) : resolve());
const evaluate = script => page.evaluate(source => (0, eval)(source), script);

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-browser-observation-'));
  crossServer = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<p>CROSS_ORIGIN_SENTINEL_NOT_READABLE</p><button>Cross frame private control</button>');
  });
  const crossOrigin = await listen(crossServer);
  server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/same-frame') response.end('<p>Same origin frame paragraph.</p><button aria-label="Frame action">Frame button</button><input type="password" value="FRAME_PASSWORD_SENTINEL">');
    else response.end(fs.readFileSync(path.join(__dirname, 'fixtures/browser-page-observation.html'), 'utf8').replace('__CROSS_ORIGIN__', crossOrigin));
  });
  const origin = await listen(server);
  const main = path.join(root, 'electron-fixture.cjs');
  const profile = path.join(root, 'profile');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron');
    require('node:fs').mkdirSync(${JSON.stringify(profile)},{recursive:true});app.setPath('userData',${JSON.stringify(profile)});app.disableHardwareAcceleration();
    app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});w.loadURL(${JSON.stringify(origin)});});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [main],
    env });
  page = await application.firstWindow();
  await page.waitForFunction(() => document.querySelectorAll('#long-list button').length === 620
    && document.querySelector('iframe').contentDocument?.querySelector('button'));
  await page.waitForLoadState('load');
});

test.after(async () => {
  await application?.close();
  await Promise.all([closeServer(server), closeServer(crossServer)]);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-browser-observation-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('helper loads both as a browser UMD module and through CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/browser-page-observation.js'), 'utf8'), context);
  assert.equal(typeof context.ZBrowserPageObservation.snapshot, 'function');
  assert.equal(typeof context.ZBrowserPageObservation.waitCondition, 'function');
  assert.equal(typeof observation.readPage({ limit: 1 }), 'string');
});

test('snapshot covers all candidates, paginates exactly and masks passwords', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  const first = await evaluate(observation.snapshot({ startRef: 1, snapshotId: 'first', limit: 10 }));
  assert.ok(first.total > 620);
  assert.equal(first.items.length, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 10);
  assert.ok(first.items.every(item => item.inViewport));
  const password = first.items.find(item => item.name === 'Password');
  assert.equal(password.state.hasValue, true);
  assert.equal(password.state.value, undefined);
  assert.equal(first.items.find(item => item.name === 'Disabled through fieldset').state.disabled, true);
  assert.doesNotMatch(JSON.stringify(first), /PASSWORD_SENTINEL|FRAME_PASSWORD_SENTINEL|HIDDEN_SENTINEL|CROSS_ORIGIN_SENTINEL/);
  assert.equal(first.inaccessibleFrames.length, 1);
  assert.equal(first.inaccessibleFrames[0].reason, 'cross-origin');
  assert.ok(first.framesRead.some(frame => frame.title === 'Same origin frame'));
  const second = await evaluate(observation.snapshot({ startRef: 100, snapshotId: 'second', offset: 10, limit: 10 }));
  assert.equal(second.total, first.total);
  assert.equal(second.items[0].ref, 'e100');
  assert.equal(second.items[0].name, 'Row 4');
  assert.equal(second.nextOffset, 20);
});

test('a control after 620 candidates becomes first-page discoverable after scrolling', async () => {
  await page.evaluate(() => document.getElementById('late-control').scrollIntoView({ block: 'center' }));
  const result = await evaluate(observation.snapshot({ startRef: 1000, snapshotId: 'late', limit: 20 }));
  const late = result.items.find(item => item.name === 'Control after 620 candidates');
  assert.ok(late?.inViewport);
  assert.ok(result.items.find(item => item.name === 'Shadow action label'));
  const targeted = await evaluate(observation.snapshot({ query: 'after 620', role: 'button', limit: 1, startRef: 1100, snapshotId: 'target' }));
  assert.equal(targeted.total, 1);
  assert.equal(targeted.items[0].name, 'Control after 620 candidates');
  assert.equal(targeted.hasMore, false);
  const map = await page.evaluate(() => ({ size: window.__zBrowserRefs.size, id: window.__zBrowserSnapshotId, target: window.__zBrowserRefs.get('e1100')?.id }));
  assert.deepEqual(map, { size: 1, id: 'target', target: 'late-control' });
});

test('find filters headings, labels, case-sensitive exact names and same-origin/shadow controls', async () => {
  const heading = await evaluate(observation.find({ role: 'heading', text: 'Late section heading', exact: true, startRef: 1200, snapshotId: 'heading' }));
  assert.equal(heading.total, 1);
  assert.equal(heading.items[0].role, 'heading');
  assert.equal((await evaluate(observation.find({ role: 'heading', name: 'late section heading', exact: true }))).total, 0);
  assert.equal((await evaluate(observation.find({ role: 'textbox', label: 'Email address', exact: true }))).total, 1);
  const shadow = await evaluate(observation.find({ role: 'button', label: 'Shadow action label', exact: true }));
  assert.equal(shadow.total, 1);
  const frame = await evaluate(observation.find({ role: 'button', name: 'Frame action', exact: true }));
  assert.equal(frame.total, 1);
  assert.equal(frame.inaccessibleFrames[0].reason, 'cross-origin');
});

test('visible text remains distinct from accessible names in find, query and reference waits', async () => {
  const byText = await evaluate(observation.find({ role: 'button', text: 'Remove', exact: true }));
  assert.equal(byText.total, 1);
  assert.equal(byText.items[0].name, 'Delete row');
  assert.equal((await evaluate(observation.find({ query: 'Remove', role: 'button', exact: true }))).total, 1);
  assert.equal((await evaluate(observation.snapshot({ query: 'Remove', role: 'button', exact: true }))).total, 1);
  assert.equal((await evaluate(observation.find({ role: 'button', name: 'Delete row', text: 'Remove', exact: true }))).total, 1);
  assert.equal((await evaluate(observation.find({ role: 'button', name: 'Delete row', text: 'Delete row', exact: true }))).total, 0);
  assert.equal((await evaluate(observation.find({ role: 'button', query: 'wrong query', text: 'Remove', exact: true }))).total, 0);
  assert.equal((await evaluate(observation.find({ text: 'PASSWORD_SENTINEL_DO_NOT_EXPOSE' }))).total, 0);
  const found = await evaluate(observation.find({ role: 'button', name: 'Delete row', text: 'Remove', exact: true, snapshotId: 'different-name' }));
  const ref = found.items[0].ref;
  assert.equal((await evaluate(observation.waitCondition({ ref, text: 'Remove', exact: true }))).matched, true);
  assert.equal((await evaluate(observation.waitCondition({ ref, text: 'Delete row', exact: true }))).matched, false);
  assert.equal((await evaluate(observation.waitCondition({ role: 'button', text: 'Remove', name: 'Delete row', exact: true }))).matched, true);
  assert.equal((await evaluate(observation.waitCondition({ role: 'button', text: 'Delete row', exact: true }))).matched, false);
});

test('readPage preserves paragraphs, has complete character pagination and never reads cross-origin text', async () => {
  const first = await evaluate(observation.readPage({ offset: 0, limit: 500 }));
  assert.match(first.text, /First paragraph with important text\.\n\nSecond paragraph remains separate\./);
  assert.ok(first.totalChars > 16000);
  assert.equal(first.text.length, 500);
  assert.equal(first.nextOffset, 500);
  const second = await evaluate(observation.readPage({ offset: first.nextOffset, limit: 500 }));
  const combined = await evaluate(observation.readPage({ offset: 0, limit: 1000 }));
  assert.equal(first.text + second.text, combined.text);
  const clipped = await evaluate(observation.readPage({ limit: 999999 }));
  assert.equal(clipped.text.length, 16000);
  assert.match(clipped.text, /Shadow paragraph retained\./);
  assert.match(clipped.text, /Same origin frame paragraph\./);
  const last = await evaluate(observation.readPage({ offset: first.totalChars - 200, limit: 500 }));
  assert.equal(last.text.length, 200);
  assert.equal(last.nextOffset, null);
  assert.equal(last.hasMore, false);
  assert.doesNotMatch(JSON.stringify([first, second, clipped, last]), /PASSWORD_SENTINEL|CROSS_ORIGIN_SENTINEL|HIDDEN_SENTINEL/);
  assert.equal(first.inaccessibleFrames[0].reason, 'cross-origin');
});

test('reference reads stay local and become stale after a new snapshot', async () => {
  const found = await evaluate(observation.find({ role: 'paragraph', query: 'Local paragraph', snapshotId: 'local', startRef: 2000 }));
  assert.equal(found.total, 1);
  const local = await evaluate(observation.readPage({ ref: found.items[0].ref, snapshotId: 'local' }));
  assert.equal(local.text, 'Local paragraph for reference reading.');
  assert.equal(local.totalChars, local.text.length);
  assert.equal(await page.evaluate(() => window.__zBrowserSnapshotId), 'local');
  await evaluate(observation.snapshot({ snapshotId: 'new', startRef: 3000, limit: 1 }));
  assert.equal((await evaluate(observation.readPage({ ref: found.items[0].ref, snapshotId: 'local' }))).code, 'STALE_REF');
});

test('waitCondition rechecks current DOM without changing refs and combines ref plus text', async () => {
  const found = await evaluate(observation.find({ role: 'button', name: 'Control after 620 candidates', exact: true, snapshotId: 'waiting', startRef: 4000 }));
  const ref = found.items[0].ref;
  assert.equal((await evaluate(observation.waitCondition({ ref, text: 'wrong text', state: 'visible' }))).matched, false);
  assert.equal((await evaluate(observation.waitCondition({ ref, text: 'after 620', state: 'enabled' }))).matched, true);
  assert.equal((await evaluate(observation.waitCondition({ role: 'textbox', label: 'Email address', state: 'editable' }))).matched, true);
  assert.equal((await evaluate(observation.waitCondition({ label: 'Read only field', state: 'editable' }))).matched, false);
  assert.equal((await evaluate(observation.waitCondition({ label: 'Disabled through fieldset', state: 'enabled' }))).matched, false);
  assert.equal((await evaluate(observation.waitCondition({ text: 'Distributed phrase complete', state: 'visible' }))).matched, true);
  assert.equal(await page.evaluate(() => window.__zBrowserSnapshotId), 'waiting');
  assert.equal(await page.evaluate(ref => window.__zBrowserRefs.has(ref), ref), true);
  await page.evaluate(() => { document.getElementById('late-control').textContent = 'Ready to submit'; });
  assert.equal((await evaluate(observation.waitCondition({ ref, text: 'Ready to submit', exact: true }))).matched, true);
  await page.evaluate(() => { document.getElementById('late-control').style.display = 'none'; });
  assert.equal((await evaluate(observation.waitCondition({ ref, state: 'hidden' }))).matched, true);
  assert.equal((await evaluate(observation.waitCondition({ ref, state: 'visible' }))).matched, false);
});
