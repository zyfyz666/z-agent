'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findObsoleteBrand } = require('./helpers/obsolete-brand.cjs');

const root = path.resolve(__dirname, '..');

// Only third-party or generated content, plus LICENSE (line 3 is the original
// author's copyright notice, which the MIT license requires us to keep). Each
// entry covers files whose third-party text contains words that begin with
// the same three letters (locale strings, minified identifiers, font names,
// the upstream author's surname and handle).
const EXCLUDED = [
  /\.bundle\.(?:mjs|cjs)$/, // esbuild output: inlined zod locales and npm dependencies
  /(?:^|\/)dist\//, // prebuilt third-party viewer assets (minified ELK layout engine)
  /^lib\/vendor\//, // vendored upstream sources (dsh-code-review, thrash-watchdog)
  /^lib\/skills\/ui-ux-pro-max\/data\//, // third-party skill data: Google Fonts catalogue
  /^renderer\/work-gui\/palace\/assets\/[^/]+-data\.js$/, // base64 texture and star-field blobs
  /^renderer\/dsh-review-THIRD_PARTY_LICENSE\.txt$/, // upstream MIT notice for dsh-code-review
  /^LICENSE$/
];
// First-party files cite the upstream repository `<owner>/dsh-code-review`;
// the owner's handle is not product branding, so it is masked before scanning.
const UPSTREAM_OWNER = /[\w.-]+(?=\/dsh-code-review\b)/g;
const CODE_POINT_BUILD = /fromCodePoint\(\s*121\b/;

function repositoryFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  return [...new Set(output.split('\0').filter(Boolean))]
    .filter(file => !EXCLUDED.some(pattern => pattern.test(file)));
}

function readText(file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  const buffer = fs.readFileSync(absolute);
  // Same heuristic git uses: a NUL byte near the start means binary content.
  if (buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString('utf8');
}

test('tracked sources never contain the obsolete product name', () => {
  const hits = [];
  for (const file of repositoryFiles()) {
    const text = readText(file);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      const tokens = findObsoleteBrand(line.replace(UPSTREAM_OWNER, ''));
      if (tokens.length || CODE_POINT_BUILD.test(line)) {
        hits.push(`${file}:${index + 1} ${tokens.length ? [...new Set(tokens)].join(',') : 'code points'}`);
      }
    });
  }
  assert.deepEqual(hits, [], `obsolete product name found:\n${hits.join('\n')}`);
});
