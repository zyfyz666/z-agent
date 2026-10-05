'use strict';
// Observer eye: every expression renders inside the panel without overlapping the
// header or status card, the eye node survives re-renders, and a live reminder
// makes it speak and then return to watching. Isolated profile, no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'z-observer-eye-e2e-'));
const output = path.join(root, 'output/observer-eye');
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, states: {}, errors: [] };
let app, page;

const now = Date.now();
const snap = (extra = {}) => ({ enabled: true, phase: 'observing', judgeEvery: 6, observedSteps: 14, judgedSteps: 12,
  checks: 2, interventions: 0, observations: 1, updatedAt: now, events: [], ...extra });
const remind = id => ({ id, ts: now, step: 12, action: 'remind', rules: ['R1_loop'], advisories: [],
  message: '连续三次读取同一文件，结论没有变化。', delivery: 'delivered' });
const STATES = {
  resting: { mode: 'empty', status: 'idle', snapshot: null },
  watching: { mode: 'live', status: 'working', key: 'run:a', sessionId: 's', snapshot: snap() },
  pondering: { mode: 'live', status: 'working', key: 'run:a', sessionId: 's',
    snapshot: snap({ model: { name: 'GLM', modelId: 'glm', phase: 'reviewing', checks: 1 } }) },
  closed: { mode: 'history', status: 'done', key: 'run:b', sessionId: 's', snapshot: snap({ phase: 'completed', outcome: 'completed' }) },
  alarmed: { mode: 'live', status: 'working', key: 'run:c', sessionId: 's', snapshot: snap({ phase: 'error' }) }
};

async function main() {
  const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile, Z_E2E_PARENT_PID: String(process.pid),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && window.ZWdMonitor);
  // One fixture host per expression, laid out like the real right-sidebar panel.
  await page.evaluate(names => {
    const board = document.createElement('div');
    board.id = 'eyeBoard';
    board.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;grid-template-columns:repeat(3,380px);gap:12px;padding:12px;background:var(--bg);overflow:hidden';
    for (const name of names) {
      const host = document.createElement('section');
      host.className = 'wd-panel'; host.id = `eye-${name}`;
      host.style.cssText = 'display:block;height:420px;overflow:hidden;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)';
      board.append(host);
    }
    document.body.append(board);
  }, [...Object.keys(STATES), 'speaking']);
  const draw = (id, selection) => page.evaluate(([id, selection]) =>
    window.ZWdMonitor.render(document.getElementById(`eye-${id}`), selection), [id, selection]);
  const measure = id => page.evaluate(id => {
    const host = document.getElementById(`eye-${id}`);
    const box = selector => { const r = host.querySelector(selector)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return { eye: host.querySelector('.wd-oracle')?.dataset.eye, host: box('.wd-monitor'), header: box('.wd-header'),
      oracle: box('.wd-oracle'), svg: box('.wd-eye'), status: box('.wd-status'), scrollX: host.scrollWidth - host.clientWidth };
  }, id);
  for (const [name, selection] of Object.entries(STATES)) await draw(name, selection);
  // Speaking: the same live run gains a reminder after the first render.
  await draw('speaking', { ...STATES.watching, key: 'run:s' });
  await draw('speaking', { ...STATES.watching, key: 'run:s', snapshot: snap({ interventions: 1, events: [remind('r1')] }) });
  await page.waitForTimeout(700);
  for (const name of [...Object.keys(STATES), 'speaking']) {
    const m = report.states[name] = await measure(name);
    assert.equal(m.eye, name, `${name}: data-eye`);
    assert.ok(m.header.bottom <= m.oracle.top + 0.5, `${name}: header overlaps eye`);
    assert.ok(m.oracle.bottom <= m.status.top + 0.5, `${name}: eye overlaps status card`);
    assert.ok(m.svg.left >= m.host.left - 0.5 && m.svg.right <= m.host.right + 0.5, `${name}: eye exceeds panel width`);
    assert.equal(m.scrollX, 0, `${name}: horizontal overflow`);
  }
  await page.screenshot({ path: path.join(output, 'states-dark.png') });
  await page.screenshot({ path: path.join(output, 'resting-closed-dark-zoom.png'), clip: { x: 12, y: 12, width: 380, height: 740 }, scale: 'device' });
  // The eye node survives re-renders; a snapshot that already has a reminder does not flare.
  report.persistent = await page.evaluate(() => {
    const host = document.getElementById('eye-watching');
    host.querySelector('.wd-oracle').dataset.probe = 'kept';
    window.ZWdMonitor.render(host, { mode: 'live', status: 'working', key: 'run:a', sessionId: 's', snapshot: { enabled: true, phase: 'observing', checks: 3, events: [] } });
    return host.querySelector('.wd-oracle').dataset.probe === 'kept';
  });
  assert.equal(report.persistent, true, 'eye node recreated on re-render');
  await draw('closed', { ...STATES.watching, key: 'run:fresh', snapshot: snap({ events: [remind('old')] }) });
  assert.equal((await measure('closed')).eye, 'watching', 'existing reminder flared on first render');
  await draw('closed', STATES.closed);
  // Blink: within a few seconds the watching eye closes briefly at least once.
  report.blinked = await page.evaluate(() => new Promise(resolve => {
    const oracle = document.querySelector('#eye-watching .wd-oracle');
    const started = Date.now();
    const poll = setInterval(() => {
      if (oracle.dataset.blink) { clearInterval(poll); resolve(true); }
      else if (Date.now() - started > 9000) { clearInterval(poll); resolve(false); }
    }, 25);
  }));
  assert.equal(report.blinked, true, 'watching eye never blinked');
  await page.waitForTimeout(2200);
  assert.equal((await measure('speaking')).eye, 'watching', 'speaking did not return to watching');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await draw('speaking', { ...STATES.watching, key: 'run:s', snapshot: snap({ interventions: 2, events: [remind('r1'), remind('r2')] }) });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(output, 'states-light.png') });
  await page.screenshot({ path: path.join(output, 'watching-light-zoom.png'), clip: { x: 404, y: 12, width: 380, height: 300 }, scale: 'device' });
  assert.deepEqual(report.errors, []);
}

main().then(() => {
  report.ok = true;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}).catch(error => {
  report.errors.push(error.stack || String(error));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await app?.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
});
