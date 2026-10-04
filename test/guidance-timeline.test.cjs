'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureBoundary, projectTimeline, markdownContent } = require('../renderer/guidance-timeline');

const text = (content, key = 'text:answer', extra = {}) => ({ type: 'text', openCodeKey: key, content, ...extra });
const contents = segments => segments.map(segment => segment.filter(item => item.type === 'text').map(item => item.content).join(''));

test('capture records stable keys and independent lengths for text and thinking', () => {
  const source = [text('before'), { type: 'thinking', openCodeKey: 'reasoning:one', content: 'reason' },
    { type: 'tool_call', callId: 'read-1' }, { type: 'progress', content: 'working' }];
  const boundary = captureBoundary(source);
  assert.equal(boundary.version, 1);
  assert.deepEqual(boundary.keys, ['text:answer', 'reasoning:one', 'tool_call:read-1', 'progress:3']);
  assert.deepEqual({ ...boundary.textLengths }, { 'text:answer': 6, 'reasoning:one': 6 });
  source[0].content += ' later';
  assert.equal(boundary.textLengths['text:answer'], 6);
});

test('multiple guides split a single still-streaming part without loss or duplication', () => {
  const source = [text('one', 'text:answer', { streaming: true })];
  const first = captureBoundary(source);
  source[0].content += 'two';
  const second = captureBoundary(source);
  source[0].content += 'three';
  const projected = projectTimeline(source, [first, second]);
  assert.deepEqual(contents(projected), ['one', 'two', 'three']);
  assert.deepEqual(projected.map(segment => segment[0].streaming), [false, false, true]);
  assert.equal(projected.flat().map(item => item.content).join(''), source[0].content);
  assert.equal(source[0].streaming, true);
});

test('thinking parts use the same exact character boundary', () => {
  const source = [{ type: 'thinking', openCodeKey: 'reasoning:one', content: '此前思考', streaming: true }];
  const boundary = captureBoundary(source);
  source[0].content += '之后思考';
  const projected = projectTimeline(source, [boundary]);
  assert.deepEqual(projected.map(segment => segment[0].content), ['此前思考', '之后思考']);
  assert.equal(projected[0][0].streaming, false);
  assert.equal(projected[1][0].streaming, true);
});

test('a late text part stays after guidance even when inserted at the start of the native timeline', () => {
  const source = [{ type: 'progress', openCodeKey: 'loader:one', content: '' }, text('earlier', 'text:earlier')];
  const boundary = captureBoundary(source);
  source.splice(0, 1);
  source.unshift(text('late', 'text:late'));
  source[1].content += ' continued';
  const projected = projectTimeline(source, [boundary]);
  assert.deepEqual(contents(projected), ['earlier', 'late continued']);
  assert.deepEqual(projected[0].map(item => item.openCodeKey), ['text:earlier']);
});

test('a key that had no text at the boundary does not pull later text before guidance', () => {
  const boundary = captureBoundary([{ type: 'progress', openCodeKey: 'part:one', content: '' }]);
  assert.deepEqual(contents(projectTimeline([text('arrived later', 'part:one')], [boundary])), ['', 'arrived later']);
});

test('stable keys survive native timeline reorder and a removed loader', () => {
  const first = text('A', 'text:a');
  const second = text('B', 'text:b');
  const boundary = captureBoundary([{ type: 'progress', openCodeKey: 'loader' }, first, second]);
  const projected = projectTimeline([second, text('C', 'text:c'), first], [boundary]);
  assert.deepEqual(contents(projected), ['BA', 'C']);
});

test('a late tool result remains paired with the already started tool without duplicating its call', () => {
  const source = [{ type: 'tool_call', openCodeKey: 'call:read', callId: 'read', name: 'read', input: { path: 'a' } }];
  const boundary = captureBoundary(source);
  const result = { type: 'tool_result', openCodeKey: 'result:read', callId: 'read', name: 'read', ok: true, output: 'read finished' };
  source.push(result, text('next'));
  const projected = projectTimeline(source, [boundary]);
  assert.deepEqual(projected.map(segment => segment.map(item => item.type)), [['tool_call', 'tool_result'], ['text']]);
  assert.equal(projected[0][1].output, 'read finished');
  assert.equal(projected.flat().filter(item => item.type === 'tool_call').length, 1);
  assert.equal(projected.flat().filter(item => item.type === 'tool_result').length, 1);
  assert.notEqual(projected[0][1], result);
});

test('legacy tools without call IDs still pair by name across guidance', () => {
  const source = [{ type: 'tool_call', name: 'read' }, { type: 'tool_call', name: 'write' }];
  const first = captureBoundary(source);
  source.push({ type: 'tool_result', name: 'write', output: 'done' }, { type: 'tool_result', name: 'read', output: 'loaded' });
  const projected = projectTimeline(source, [first]);
  assert.equal(projected[0].length, 4);
  assert.equal(projected[1].length, 0);
});

test('different tool calls on both sides of guidance keep their own result and segment', () => {
  const source = [{ type: 'tool_call', callId: 'a', name: 'read' }];
  const boundary = captureBoundary(source);
  source.push({ type: 'tool_call', callId: 'b', name: 'read' },
    { type: 'tool_result', callId: 'b', output: 'B' }, { type: 'tool_result', callId: 'a', output: 'A' });
  const projected = projectTimeline(source, [boundary]);
  assert.deepEqual(projected.map(segment => segment.map(item => item.callId)), [['a', 'a'], ['b', 'b']]);
});

test('back-to-back guidance preserves empty slots and freezes the already-visible text', () => {
  const source = [text('visible', 'text:one', { streaming: true })];
  const boundary = captureBoundary(source);
  const projected = projectTimeline(source, [boundary, boundary, boundary]);
  assert.equal(projected.length, 4);
  assert.deepEqual(contents(projected), ['visible', '', '', '']);
  assert.equal(projected[0][0].streaming, false);
  assert.deepEqual(projectTimeline([], [captureBoundary([]), captureBoundary([])]), [[], [], []]);
});

test('missing stable keys and malformed boundary data remain safe and never drop current content', () => {
  const source = [{ type: 'text', content: 'old' }, { type: 'text', content: 'new' }];
  const boundary = captureBoundary(source.slice(0, 1));
  assert.deepEqual(contents(projectTimeline(source, [boundary])), ['old', 'new']);
  assert.deepEqual(contents(projectTimeline(source, [null, { keys: ['text:0'], textLengths: { 'text:0': Infinity } }])), ['', '', 'oldnew']);
  assert.deepEqual(projectTimeline(null, null), [[]]);
});

test('shrinking native content and regressing or excessive lengths cannot duplicate or lose text', () => {
  const source = [text('abcdef')];
  const first = captureBoundary(source);
  source[0].content = 'abc';
  const second = captureBoundary(source);
  source[0].content = 'abcdefgh';
  assert.deepEqual(contents(projectTimeline(source, [first, second])), ['abcdef', '', 'gh']);
  source[0].content = 'ab';
  assert.deepEqual(contents(projectTimeline(source, [first, second])), ['ab', '', '']);
});

test('projection never changes source timeline, boundaries, or nested tool payloads', () => {
  const source = [text('before', 'text:one', { streaming: true }), { type: 'tool_call', callId: 'a', input: { path: '/a' } }];
  const boundary = captureBoundary(source);
  source[0].content += 'after';
  source.push({ type: 'tool_result', callId: 'a', output: { body: 'ok' } });
  const prior = JSON.stringify({ source, boundary });
  const freeze = object => { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } };
  freeze(source); freeze(boundary);
  assert.doesNotThrow(() => projectTimeline(source, [boundary]));
  assert.equal(JSON.stringify({ source, boundary }), prior);
  assert.deepEqual(projectTimeline(source, []), [source]);
});

test('reserved object property names are safe as native part keys', () => {
  const source = [text('a', '__proto__'), text('b', 'constructor')];
  const boundary = captureBoundary(source);
  source[0].content += 'A'; source[1].content += 'B';
  const roundTripped = JSON.parse(JSON.stringify(boundary));
  assert.deepEqual(contents(projectTimeline(source, [roundTripped])), ['ab', 'AB']);
});

function splitText(chunks) {
  const source = [text(chunks[0], 'text:formatted', { streaming: true })];
  const boundaries = [];
  for (const chunk of chunks.slice(1)) {
    boundaries.push(captureBoundary(source));
    source[0].content += chunk;
  }
  source[0].streaming = false;
  const before = JSON.stringify(source);
  const segments = projectTimeline(source, boundaries);
  assert.equal(JSON.stringify(source), before);
  assert.equal(segments.flat().map(item => item.content).join(''), chunks.join(''));
  return segments.map(segment => segment.map(markdownContent).join(''));
}

// Exercise the production Markdown parser so a syntactically plausible
// continuation cannot silently turn into ordinary prose or literal math.
function markdownRenderer() {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const start = source.indexOf('function renderMarkdown(text)');
  const end = source.indexOf('\nfunction toast(', start);
  assert.ok(start >= 0 && end > start);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return vm.runInNewContext(source.slice(start, end) + '\nrenderMarkdown;', {
    escapeHtml, renderMarkdownTables: value => value, ICONS: { copy: '' },
    window: { ZMathMarkdown: require('../renderer/math-markdown') },
    AGENT_MARKDOWN_IMAGE_PATTERN: /(?!)/g, AGENT_MARKDOWN_LINK_PATTERN: /(?!)/g,
    AGENT_URL_PATTERN: /(?!)/g, AGENT_LOCAL_PATH_PATTERN: /(?!)/g
  });
}

test('one fenced code block remains code across two guidance boundaries', () => {
  const displays = splitText(['Before\n\n```js\nconst first = 1;', '\nconst second = 2;', '\nconst third = 3;\n```\nAfter']);
  const render = markdownRenderer();
  displays.forEach((display, index) => {
    const html = render(display);
    assert.match(html, /<pre><code>/);
    assert.match(html, new RegExp(`const ${['first', 'second', 'third'][index]} = ${index + 1};`));
    assert.doesNotMatch(html, /```/);
  });
  assert.match(render(displays[0]), /Before/);
  assert.match(render(displays[2]), /After/);
});

test('long backtick fences, tildes, and CRLF preserve their code continuation', () => {
  const render = markdownRenderer();
  for (const fence of ['````', '~~~']) {
    const displays = splitText([`${fence}text\r\nfirst`, '\r\n``` literal shorter fence', `\r\nlast\r\n${fence}\r\nProse`]);
    displays.forEach(display => assert.match(render(display), /<pre><code>/));
    assert.match(render(displays[1]), /``` literal shorter fence/);
    assert.match(render(displays[2]), /Prose/);
  }
});

test('display LaTeX keeps math rendering across multiple guides for both delimiters', () => {
  const render = markdownRenderer();
  for (const [opening, closing] of [['$$', '$$'], ['\\[', '\\]']]) {
    const displays = splitText([`Formula ${opening}x^2`, ' + y^2', ` = z^2${closing} End`]);
    displays.forEach(display => {
      const html = render(display);
      assert.match(html, /class="katex"/);
      assert.doesNotMatch(html, /class="math-source"/);
    });
    assert.match(render(displays[0]), /Formula/);
    assert.match(render(displays[2]), /End/);
  }
});

test('delimiter-only fragments do not leak partial fences or math markers into prose', () => {
  const render = markdownRenderer();
  const code = splitText(['Before\n\n``', '`js\nline', '\n``', '`\nAfter']);
  assert.match(render(code[1]), /<pre><code>line/);
  assert.doesNotMatch(code.map(render).join(''), /```/);
  assert.match(render(code.at(-1)), /After/);
  for (const [opening, closing] of [['$$', '$$'], ['\\[', '\\]']]) {
    const math = splitText([`Before ${opening[0]}`, `${opening[1]}x^2`, closing[0], `${closing[1]} After`]);
    assert.match(render(math[1]), /class="katex"/);
    assert.match(render(math.at(-1)), /After/);
  }
});

test('math-like delimiters within code remain literal code, including after a guidance boundary', () => {
  const displays = splitText(['```tex\n$$x', ' + y$$\n\\[z', '\\]\n```']);
  const render = markdownRenderer();
  displays.forEach(display => {
    const html = render(display);
    assert.match(html, /<pre><code>/);
    assert.doesNotMatch(html, /class="katex"/);
  });
  const literals = splitText(['`$$inline$$` and \\$\\$escaped', ' ordinary prose']);
  assert.equal(literals[0], '`$$inline$$` and \\$\\$escaped');
  assert.equal(literals[1], ' ordinary prose');
});

test('ordinary text and unsplit complete Markdown keep their original display source', () => {
  assert.deepEqual(splitText(['normal text', ' continuation']), ['normal text', ' continuation']);
  const source = [text('```js\nwhole();\n```\n\n$$x^2$$')];
  const projected = projectTimeline(source, [captureBoundary(source)]);
  assert.equal(projected[0][0].guidanceMarkdown, undefined);
  assert.equal(markdownContent(projected[0][0]), source[0].content);
  assert.equal(markdownContent(null), '');
});

test('transient agent loaders appear once only in the current tail, never in a frozen prefix', () => {
  const source = [{ type: 'progress', variant: 'agent-loader', openCodeKey: 'model-wait', content: '' }, text('before')];
  const first = captureBoundary(source);
  source.push({ type: 'progress', variant: 'agent-loader', openCodeKey: 'later-wait', content: '' });
  const second = captureBoundary(source);
  const original = JSON.stringify(source);
  const projected = projectTimeline(source, [first, second]);
  assert.deepEqual(projected.map(segment => segment.filter(item => item.variant === 'agent-loader').length), [0, 0, 1]);
  assert.equal(projected.at(-1).find(item => item.variant === 'agent-loader').openCodeKey, 'later-wait');
  assert.equal(JSON.stringify(source), original);
});
