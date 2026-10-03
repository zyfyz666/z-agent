#!/usr/bin/env node

// Apply Z's display branding to the bundled read-only viewer. Upstream package
// identity, source comments, copyright and third-party notices are untouched.
// Run after refreshing dist: node lib/understand-anything/viewer/rebrand.mjs
// Verify without writing:    node lib/understand-anything/viewer/rebrand.mjs --check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = Object.freeze([
  { language: 'en', name: 'Project Map', shortcut: 'Press ? for keyboard shortcuts' },
  { language: 'zh-CN', name: '项目地图', shortcut: '按 ? 查看键盘快捷键' },
  { language: 'zh-TW', name: '项目地图', shortcut: '按 ? 查看鍵盤快捷鍵' },
  { language: 'ja', name: 'Project Map', shortcut: '? を押してキーボードショートカットを表示' },
  { language: 'ko', name: 'Project Map', shortcut: '? 키를 눌러 키보드 단축키 보기' },
  { language: 'ru', name: 'Project Map', shortcut: 'Нажмите ? для горячих клавиш' }
]);

function replaceDisplayValue(text, original, branded, label) {
  const originalCount = text.split(original).length - 1;
  const brandedCount = text.split(branded).length - 1;
  if (originalCount + brandedCount !== 1) {
    throw new Error(`Unrecognized viewer build: expected one ${label}; found ${originalCount} upstream and ${brandedCount} branded matches. No files changed.`);
  }
  return originalCount ? text.replace(original, branded) : text;
}

export function planViewerBranding(viewerDirectory = HERE) {
  const dist = path.join(viewerDirectory, 'dist');
  const htmlFile = path.join(dist, 'index.html');
  const htmlBefore = fs.readFileSync(htmlFile);
  const html = htmlBefore.toString('utf8');
  const entries = [...html.matchAll(/<script type="module" crossorigin src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"><\/script>/g)];
  if (entries.length !== 1) throw new Error('Unrecognized viewer build: expected one main module entry. No files changed.');
  const bundleFile = path.join(dist, entries[0][1].slice(1));
  const bundleBefore = fs.readFileSync(bundleFile);
  let bundle = bundleBefore.toString('utf8');
  if ([...bundle.matchAll(/\bappName:/g)].length !== LOCALES.length) {
    throw new Error('Unrecognized viewer build: appName locale count changed. No files changed.');
  }
  for (const { language, name, shortcut } of LOCALES) {
    const suffix = `,pressKeyboard:${JSON.stringify(shortcut)}`;
    bundle = replaceDisplayValue(bundle,
      `appName:"Understand Anything"${suffix}`,
      `appName:${JSON.stringify(name)}${suffix}`,
      `${language} display name`);
  }
  const htmlAfter = replaceDisplayValue(html,
    '<title>Understand Anything</title>', '<title>Z · 项目地图</title>', 'document title');
  const appAssets = path.resolve(viewerDirectory, '../../../renderer/assets');
  // Plan and validate every read before the first write, so an upstream layout
  // change cannot leave a partially rebranded set of assets.
  return [
    { file: bundleFile, before: bundleBefore, after: Buffer.from(bundle) },
    { file: htmlFile, before: htmlBefore, after: Buffer.from(htmlAfter) },
    { file: path.join(dist, 'favicon.svg'), before: fs.readFileSync(path.join(dist, 'favicon.svg')),
      after: fs.readFileSync(path.join(appAssets, 'z-mark.svg')) },
    { file: path.join(dist, 'favicon.ico'), before: fs.readFileSync(path.join(dist, 'favicon.ico')),
      after: fs.readFileSync(path.join(appAssets, 'z-icon.ico')) }
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--check')) throw new Error('Usage: node rebrand.mjs [--check]');
    const changes = planViewerBranding().filter(change => !change.before.equals(change.after));
    if (args.includes('--check')) {
      if (changes.length) throw new Error(`Viewer branding needs updating: ${changes.map(change => path.relative(HERE, change.file)).join(', ')}`);
      console.log('Project Map branding verified: 6 locale labels, title and Z icons.');
    } else {
      for (const change of changes) fs.writeFileSync(change.file, change.after);
      console.log(`Project Map branding ready: ${changes.length} file(s) updated.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
