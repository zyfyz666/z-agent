'use strict';

// Keep renderer math and fonts local, including in packaged/offline builds.
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const packagePath = require.resolve('katex/package.json');
  const source = path.dirname(packagePath);
  const target = path.join(root, 'renderer/vendor/katex');
  await fs.mkdir(target, { recursive: true });
  for (const name of ['katex.min.js', 'katex.min.css']) {
    await fs.copyFile(path.join(source, 'dist', name), path.join(target, name));
  }
  await fs.cp(path.join(source, 'dist/fonts'), path.join(target, 'fonts'), { recursive: true });
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
  await fs.writeFile(path.join(target, 'VERSION'), `KaTeX ${require(packagePath).version}\n`);
  console.log('Bundled KaTeX and local fonts.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
