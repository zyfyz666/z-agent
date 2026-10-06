'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const mathMarkdown = require('../renderer/math-markdown');

// Exercise the production renderer without starting the user's app or reading
// a profile. The copied source ranges include link, path, code and math handling.
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const context = vm.createContext({
  window: { ZMathMarkdown: mathMarkdown },
  state: { currentSession: { workspace: 'C:\\workspace' } },
  URL,
  ICONS: { copy: '' }
});
vm.runInContext(
  source.slice(source.indexOf('function escapeHtml(s)'), source.indexOf('async function copyMarkdownCode'))
  + source.slice(source.indexOf('function renderMarkdownTables(t)'), source.indexOf('\nfunction toast(msg)')),
  context
);
const render = value => context.renderMarkdown(value);
const htmlText = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

test('plain quotes remain unchanged while escaped prose quotes lose exactly one layer', () => {
  for (const quote of ['"', "'"]) {
    for (let count = 0; count <= 8; count++) {
      const boundary = '\\'.repeat(count) + quote;
      const input = `A **${boundary}representative examples${boundary}**.`;
      const visibleBoundary = '\\'.repeat(Math.floor(count / 2)) + quote;
      const expected = `<p>A <strong>${htmlText(visibleBoundary)}representative examples${htmlText(visibleBoundary)}</strong>.</p>`;
      assert.equal(render(input), expected, `${count} slashes before ${quote}`);
      assert.equal(render(input), expected, 'rendering the same history does not decode another layer');
    }
  }
});

test('bare slash runs and incomplete UNC paths never become file links', () => {
  for (const input of [
    '\\'.repeat(3), '\\'.repeat(8),
    String.raw`\\server`, String.raw`\\server` + '\\',
    String.raw`\\\server\share`, String.raw`\\\\server\share`
  ]) {
    assert.doesNotMatch(render(input), /agent-output-link|file:/, input);
  }
});

test('long incomplete slash runs stay literal without repeated rescanning', { timeout: 1000 }, () => {
  const slashes = '\\'.repeat(100_000);
  assert.equal(render(slashes), `<p>${slashes}</p>`);
});

test('valid UNC paths retain their source spelling and remain clickable', () => {
  for (const input of [
    String.raw`\\server\share`, String.raw`\\server-name\share\report.txt`,
    String.raw`\\192.168.2.1\data\report.txt`, String.raw`\\服务器\共享\报告.txt`
  ]) {
    const html = render(input);
    assert.match(html, /class="agent-output-link"/);
    assert.ok(html.includes(`>${htmlText(input)}</a>`), input);
    assert.ok(html.includes(`href="${htmlText(`file:${input.replace(/\\/g, '/')}`)}"`), input);
  }
});

test('quoted Windows paths keep a trailing backslash and URL targets remain intact', () => {
  for (const input of [String.raw`C:\temp` + '\\', String.raw`\\server\share` + '\\']) {
    const html = render(`Open "${input}".`);
    assert.ok(html.includes(`>${htmlText(input)}</a>&quot;`), input);
  }
  const url = 'https://example.invalid/a%22b?query=%5C%22&other=%27';
  assert.ok(render(`[reference](${url})`).includes(`href="${htmlText(url)}"`));
  assert.ok(render(url).includes(`>${htmlText(url)}</a>`));
});

test('inline and fenced code preserve every quote escape', () => {
  const code = String.raw`const value = "\\\"quoted\\\" and \'literal\'";`;
  assert.equal(render('`' + code + '`'), `<p><code>${htmlText(code)}</code></p>`);
  for (const fence of ['```', '~~~']) {
    const html = render(fence + 'js\n' + code + '\n' + fence);
    assert.ok(html.includes(`<pre><code>${htmlText(code)}</code></pre>`));
  }
});

test('TeX quote commands and matrix separators remain untouched', () => {
  for (const input of [String.raw`\(\text{\"o}\)`, String.raw`\[\begin{matrix}a & b \\ c & d\end{matrix}\]`]) {
    const extracted = mathMarkdown.extract(input);
    assert.equal(extracted.expressions.length, 1);
    const expected = mathMarkdown.restore(extracted.text, extracted.expressions);
    assert.ok(render(input).includes(expected));
    assert.match(expected, /class="katex"/);
  }
});

test('quote escape handling does not make HTML or event attributes executable', () => {
  const html = render(String.raw`\"<img src=x onerror=alert(1)>\" and \'<script>alert(1)</script>\'`);
  assert.doesNotMatch(html, /<(?:img|script)\b/);
  assert.ok(html.includes('&quot;&lt;img src=x onerror=alert(1)&gt;&quot;'));
  assert.ok(html.includes('&#39;&lt;script&gt;alert(1)&lt;/script&gt;&#39;'));
});
