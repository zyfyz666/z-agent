'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const mathMarkdown = require('../renderer/math-markdown');

// Exercise the production Markdown renderer in isolation, like markdown-quote-escape.test.cjs.
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
const codeKind = html => html.match(/<span class="md-code-kind">([^<]*)<\/span>/)?.[1];

test('ordered lists keep their numbers instead of nesting a bullet list', () => {
  assert.equal(render('1. 第一处\n2. 第二处'), '<ol><li>第一处</li> <li>第二处</li></ol>');
  assert.equal(render('1. `npm install` 之后\n2) 第二处'), '<ol><li><code>npm install</code> 之后</li> <li>第二处</li></ol>');
});

test('bullet lists are unchanged', () => {
  assert.equal(render('- a\n- b'), '<ul><li>a</li>\n<li>b</li></ul>');
  assert.equal(render('* a\n* b'), '<ul><li>a</li>\n<li>b</li></ul>');
});

test('emphasis needs non-space next to both stars', () => {
  assert.equal(render('这是*强调*文字'), '<p>这是<em>强调</em>文字</p>');
  assert.equal(render('*a b*'), '<p><em>a b</em></p>');
  assert.equal(render('a * b * c'), '<p>a * b * c</p>');
  assert.equal(render('* *重要* 事项\n* 其他'), '<ul><li><em>重要</em> 事项</li>\n<li>其他</li></ul>');
  assert.equal(render('**粗体**'), '<p><strong>粗体</strong></p>');
});

test('an ordered list followed by a bullet list renders two separate lists', () => {
  assert.equal(render('1. x\n2. y\n\n- a\n- b'), '<ol><li>x</li> <li>y</li></ol>\n<ul><li>a</li>\n<li>b</li></ul>');
  assert.equal(render('1. x\n- a'), '<ol><li>x</li></ol>\n<ul><li>a</li></ul>');
});

test('a paragraph before a numbered list stays its own paragraph', () => {
  assert.equal(render('检查完了：\n\n1. a\n2. b'), '<p>检查完了：</p>\n<ol><li>a</li> <li>b</li></ol>');
});

test('fenced code blocks show the language from the info string', () => {
  assert.equal(codeKind(render('```bash\nnpm install\n```')), 'bash');
  assert.equal(codeKind(render('~~~js\nconst a = 1;\n~~~')), 'js');
  assert.equal(codeKind(render('``` python \nprint(1)\n```')), 'python');
  assert.equal(codeKind(render('```c++ main.cpp\nint x;\n```')), 'c++');
  assert.equal(codeKind(render('```\nplain\n```')), '纯文本');
  assert.ok(render('```bash\nnpm install\n```').includes('<pre><code>npm install</code></pre>'));
});

test('code block languages are labelled per block', () => {
  const html = render('```bash\nls\n```\n\n```\nx\n```\n\n```json\n{}\n```');
  assert.deepEqual([...html.matchAll(/<span class="md-code-kind">([^<]*)<\/span>/g)].map(m => m[1]), ['bash', '纯文本', 'json']);
});

test('markup in the info string never reaches the label', () => {
  for (const info of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '{python}']) {
    const html = render('```' + info + '\ncode\n```');
    assert.equal(codeKind(html), '纯文本', info);
    assert.doesNotMatch(html, /<(?:img|script)\b/, info);
  }
});
