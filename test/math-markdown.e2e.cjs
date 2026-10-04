'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appRoot = path.resolve(__dirname, '..');
const output = path.join(appRoot, 'output', 'math-markdown');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'z-math-e2e-'));
const env = { ...process.env, Z_E2E_MODE: '1', Z_E2E_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(output, { recursive: true });
const report = { ok: false, checks: [], screenshots: [], errors: [] };
let application, page;

async function screenshot(name) {
  const file = path.join(output, name + '.png');
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}

(async () => {
  try {
    application = await electron.launch({ executablePath: require('electron'), args: [appRoot], cwd: appRoot, env });
    page = await application.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    // No provider setup or model request is needed: replay an assistant answer
    // inside an isolated profile, with all HTTP requests blocked in this page.
    await page.route(/^https?:\/\//, route => route.abort());
    page.setDefaultTimeout(15_000);
    await page.waitForFunction(() => typeof renderMarkdown === 'function' && typeof quickInputHandlerReady !== 'undefined' && quickInputHandlerReady && state.currentSession);
    assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));

    const answer = String.raw`**数学公式显示**

行内公式 $E=mc^2$ 与 \(a^2+b^2=c^2\)。

$$\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

\[\begin{pmatrix}a & b \\ c & d\end{pmatrix}\]

| 项目 | 公式 |
| --- | --- |
| 绝对值 | $\lvert x \rvert$ |

价格 \$5，另一项 $10。`;
    const rendered = await page.evaluate(content => {
      clearMessages();
      state.currentSession.messages = [];
      const agentRun = { runId: 'math-replay', status: 'done', summaryStarted: true, durationMs: 10, timeline: [{ type: 'text', stage: 'summary', content }] };
      state.currentSession.messages.push({ role: 'assistant', content, ts: Date.now(), agentRun });
      setEmptyState(false);
      appendMessage('assistant', content, [], false, -1, Date.now(), 10, agentRun);
      const body = document.querySelector('#messages .msg.assistant .msg-body');
      return {
        math: body.querySelectorAll('.katex').length,
        display: body.querySelectorAll('.katex-display').length,
        fraction: !!body.querySelector('mfrac'),
        matrix: !!body.querySelector('mtable'),
        tableMath: !!body.querySelector('td .katex'),
        bold: !!body.querySelector('strong'),
        rawTokens: body.innerHTML.includes('\u0000MATH'),
        globalAvailable: typeof window.katex?.renderToString === 'function' && !!window.ZMathMarkdown
      };
    }, answer);
    assert.deepEqual(rendered, { math: 5, display: 2, fraction: true, matrix: true, tableMath: true, bold: true, rawTokens: false, globalAvailable: true });
    report.checks.push('completed assistant answers render inline/display fractions, matrices, and table math');

    const protectedCode = await page.evaluate(() => {
      const examples = [
        '```latex\n\\[x^2\\]\n```',
        '~~~python\nvalue = "$x^2$"\n~~~',
        '``$x$ and `nested` text``',
        '`\\(x+1\\)`',
        '```latex\n$x^2$',
        '~~~~latex\n$$x^2$$\n~~~~'
      ];
      return examples.map(source => {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown(source);
        return { math: host.querySelectorAll('.katex').length, code: host.querySelector('code')?.textContent || '', copy: host.querySelectorAll('.md-code-copy').length };
      });
    });
    for (const item of protectedCode) { assert.equal(item.math, 0); assert.ok(item.code); }
    assert.equal(protectedCode[0].code, '\\[x^2\\]');
    assert.equal(protectedCode[0].copy, 1);
    assert.equal(protectedCode[2].code, '$x$ and `nested` text');
    report.checks.push('fenced, tilde, unfinished, and nested inline code stays literal and copyable');

    const streaming = await page.evaluate(() => {
      const element = buildWorkNarrationElement('');
      document.body.appendChild(element);
      const initial = { type: 'text', content: '公式 \\(\\frac{1}{', streaming: true };
      updateAgentTimelinePartElement(element, initial, null, 'running');
      const firstTextNode = agentElementRenderState.get(element).tailTextNode;
      const content = '公式 \\(\\frac{1}{2}\\)';
      updateAgentTimelinePartElement(element, { ...initial, content }, null, 'running');
      const beforeFinish = { sameNode: firstTextNode === agentElementRenderState.get(element).tailTextNode, text: element.textContent, math: element.querySelectorAll('.katex').length };
      updateAgentTimelinePartElement(element, { ...initial, content, streaming: false }, null, 'done');
      const result = { beforeFinish, math: element.querySelectorAll('.katex').length, fraction: !!element.querySelector('mfrac'), cursor: !!element.querySelector('.stream-cursor') };
      element.remove();
      return result;
    });
    assert.deepEqual(streaming, { beforeFinish: { sameNode: true, text: '公式 \\(\\frac{1}{2}\\)', math: 0 }, math: 1, fraction: true, cursor: false });
    report.checks.push('streaming appends text incrementally and renders math when the answer completes');

    const security = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(String.raw`\(\href{javascript:alert(1)}{click}\) \(\includegraphics{https://example.invalid/track.png}\) \(\frac{1}{<img src=x onerror=alert(1)>\)`);
      return { executable: host.querySelectorAll('script,img,iframe,a,[onload],[onerror],[onclick]').length, readableInvalid: host.textContent.includes('\\frac{1}{<img'), errorBlocks: host.querySelectorAll('.katex-error').length };
    });
    assert.deepEqual(security, { executable: 0, readableInvalid: true, errorBlocks: 0 });
    report.checks.push('unsafe commands stay inert and invalid formulas retain readable source');

    const links = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown('[公式 $x^2$](https://example.invalid/$cash$)\n\n![图 $x^2$](https://example.invalid/img-$price$.png)\n\nhttps://example.invalid/$tag$\n\n外部公式 $y^2$');
      const attributes = [...host.querySelectorAll('*')].flatMap(node => [...node.attributes].map(attr => attr.value));
      return {
        hrefs: [...host.querySelectorAll('a')].map(node => node.getAttribute('href')),
        src: host.querySelector('img')?.getAttribute('src'),
        alt: host.querySelector('img')?.getAttribute('alt'),
        label: host.querySelector('a')?.textContent,
        math: host.querySelectorAll('.katex').length,
        corruptedAttributes: attributes.some(value => value.includes('<span') || value.includes('\u0000MATH'))
      };
    });
    assert.deepEqual(links, {
      hrefs: ['https://example.invalid/$cash$', 'https://example.invalid/img-$price$.png', 'https://example.invalid/$tag$'],
      src: 'https://example.invalid/img-$price$.png', alt: '图 $x^2$', label: '公式 $x^2$', math: 1, corruptedAttributes: false
    });
    report.checks.push('formula-looking link labels, image alt, and URLs preserve literal attributes');

    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => [...document.fonts].filter(font => /KaTeX/.test(font.family) && font.status === 'loaded').map(font => font.family));
    assert.ok(fonts.some(name => /KaTeX_Main/.test(name)), 'bundled KaTeX fonts loaded locally');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(async name => {
        applyTheme(name);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.querySelector('#chatScroll').scrollTop = 0;
      }, theme);
      await screenshot(theme);
    }
    report.checks.push('local KaTeX fonts load offline; dark and light theme screenshots captured');
    assert.deepEqual(report.errors, []);
    report.ok = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (application) await application.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('z-math-e2e-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
