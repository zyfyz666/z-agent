'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extract, restore } = require('../renderer/math-markdown');

function render(source) {
  const result = extract(source);
  return { ...result, html: restore(result.text, result.expressions) };
}

test('extracts inline and display math without changing TeX syntax', () => {
  const source = String.raw`行内 $E=mc^2$ 和 \(a_1 + a_2\)。

$$\frac{1}{2}$$

\[\begin{pmatrix}a & b \\ c & d\end{pmatrix}\]`;
  const { text, expressions, html } = render(source);
  assert.deepEqual(expressions.map(item => item.displayMode), [false, false, true, true]);
  assert.deepEqual(expressions.map(item => item.tex), [
    'E=mc^2', String.raw`a_1 + a_2`, String.raw`\frac{1}{2}`,
    String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`
  ]);
  assert.deepEqual(expressions.map(item => item.source), [
    '$E=mc^2$', String.raw`\(a_1 + a_2\)`, String.raw`$$\frac{1}{2}$$`,
    String.raw`\[\begin{pmatrix}a & b \\ c & d\end{pmatrix}\]`
  ]);
  assert.match(text, /\u0000MATH0\u0000/);
  assert.match(text, /\u0000MATHBLOCK2\u0000/);
  assert.doesNotMatch(html, /\u0000MATH/);
  assert.equal((html.match(/class="katex"/g) || []).length, 4);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<mtable/);
  assert.match(html, /encoding="application\/x-tex"/);
});

test('preserves currency, escaped delimiters, and unfinished model output', () => {
  for (const source of [
    '价格 $5，另一个 $10。',
    String.raw`美元 \$5 与 \$10，转义 \$x\$。`,
    String.raw`转义的分隔符 \\(x\\) 和 \\[x\\]。`,
    'unfinished $x + y',
    'unfinished $$x + y',
    String.raw`unfinished \(x + y`,
    String.raw`unfinished \[x + y`
  ]) {
    const result = extract(source);
    assert.equal(result.text, source, source);
    assert.equal(result.expressions.length, 0, source);
  }
  const mixed = render(String.raw`费用 \$5；公式 $x+1$，另一项费用 $10。`);
  assert.equal(mixed.expressions.length, 1);
  assert.equal(mixed.expressions[0].tex, 'x+1');
});

test('numeric expressions render without being mistaken for currency', () => {
  const result = render('$2+2=4$ 和 $x$');
  assert.deepEqual(result.expressions.map(item => item.tex), ['2+2=4', 'x']);
  assert.equal((result.html.match(/class="katex"/g) || []).length, 2);
});

test('display math keeps line breaks and matrix separators intact', () => {
  const source = String.raw`\[
\begin{aligned}
f(x) &= x^2 \\
f'(x) &= 2x
\end{aligned}
\]`;
  const result = render(source);
  assert.equal(result.expressions.length, 1);
  assert.match(result.expressions[0].tex, /f\(x\) &= x\^2/);
  assert.match(result.html, /<mtable/);
  assert.doesNotMatch(result.html, /katex-error|&amp;amp;/);
});

test('invalid formulas fall back to escaped readable source', () => {
  const source = String.raw`\(\frac{1}{<img src=x onerror=alert(1)>\)`;
  const result = render(source);
  assert.equal(result.expressions.length, 1);
  assert.doesNotMatch(result.html, /<img\b|<script\b|class="katex-error"/i);
  assert.match(result.html, /&lt;img/);
  assert.match(result.html, /\\frac\{1\}/);
});

test('math cannot create trusted links, image requests, or HTML event handlers', () => {
  for (const source of [
    String.raw`\(\href{javascript:alert(1)}{click}\)`,
    String.raw`\(\includegraphics{https://example.invalid/track.png}\)`,
    String.raw`\(\htmlClass{unsafe}{x}\)`
  ]) {
    const { html } = render(source);
    assert.doesNotMatch(html, /<(?:a|img|script|iframe)\b/i, source);
    assert.doesNotMatch(html, /\son(?:error|load|click)\s*=/i, source);
    assert.doesNotMatch(html, /class="unsafe"/, source);
  }
});

test('recursive macros and oversized formulas degrade without blocking rendering', { timeout: 2000 }, () => {
  const recursive = render(String.raw`\(\def\a{\a}\a\)`);
  assert.doesNotMatch(recursive.html, /class="katex"/);
  assert.match(recursive.html, /\\def/);
  const oversized = render('\\(' + 'x'.repeat(10_001) + '\\)');
  assert.doesNotMatch(oversized.html, /class="katex"/);
  assert.ok(oversized.html.includes('x'.repeat(10_001)));
  assert.match(render('$x+1$').html, /class="katex"/);
});

test('large unfinished answers have bounded math scanning and preserve their text', () => {
  const { performance } = require('node:perf_hooks');
  for (const source of [String.raw`\(`.repeat(50000), '$x $ '.repeat(20000)]) {
    const started = performance.now();
    const result = extract(source);
    assert.equal(result.text, source);
    assert.equal(result.expressions.length, 0);
    assert.ok(performance.now() - started < 2000, 'unfinished math must not freeze the renderer');
  }
  assert.match(render('$x+1$').html, /class="katex"/);
});
