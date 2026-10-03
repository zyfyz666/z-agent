'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const splash = path.join(root, 'renderer', 'splash');

// The Z startup page is plain HTML/CSS and is shipped directly. Keep this
// build entry point so existing packaging commands validate its local assets.
const html = fs.readFileSync(path.join(splash, 'index.html'), 'utf8');
for (const relativePath of ['./z-splash.css', '../assets/z-mark.svg']) {
  if (!html.includes(relativePath)) throw new Error(`Startup asset is not linked: ${relativePath}`);
  if (!fs.statSync(path.resolve(splash, relativePath)).isFile()) throw new Error(`Startup asset is missing: ${relativePath}`);
}
if (/<script\b/i.test(html)) throw new Error('The Z startup page must remain script-free');
console.log('Z startup page is ready for packaging');
