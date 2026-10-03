'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = require('../renderer/z-product-content');

function strings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}

test('Z onboarding covers the complete seven-step workflow with local guidance', () => {
  assert.equal(content.guide.pages.length, 7);
  assert.deepEqual(content.guide.pages.map(page => page.title), [
    '01 / 从目标开始', '02 / 连接你的模型', '03 / 工作区与权限', '04 / 认识观察者',
    '05 / 长任务与上下文', '06 / 查看改动与验证', '07 / 你的工作台'
  ]);
  for (const page of content.guide.pages) {
    assert.ok(page.paragraphs.length > 0);
    assert.ok(page.bullets.length > 0);
    assert.equal(page.link, undefined);
  }
  const wd = strings(content.guide.pages[3]).join('\n');
  assert.match(wd, /0 不代表答案正确/);
  assert.match(wd, /未知/);
  assert.match(wd, /已排队/);
  assert.match(wd, /已送达/);
});

test('product copy has no obsolete branding, contacts or release download promises', () => {
  const copy = strings([content.guide, content.releaseNotes, content.errors]).join('\n');
  assert.doesNotMatch(copy, /Yan|YAgent|ViaTumLab|抖音|QQ群|https?:\/\/|994525685197|1103989964|1420894553/);
  assert.equal(content.releaseNotes.title, 'Z 更新说明');
  assert.match(strings(content.releaseNotes).join('\n'), /已有监控器/);
  assert.match(strings(content.releaseNotes).join('\n'), /不改变模型推理、评分或已有工具能力/);
  assert.ok(Object.isFrozen(content.guide.pages));
});

test('all new Chinese copy has an English translation in the actual localization dictionary', () => {
  const window = { ZProductContent: content, location: { search: '' } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8');
  vm.runInNewContext(source, { window, URLSearchParams });
  const zhStrings = strings([content.guide, content.releaseNotes, content.errors]).filter(text => /[\u3400-\u9fff]/u.test(text));
  for (const text of zhStrings) {
    const translation = window.YanI18n.translate(text, 'en');
    assert.notEqual(translation, text, `Missing translation: ${text}`);
    assert.doesNotMatch(translation, /[\u3400-\u9fff]/u);
    assert.doesNotMatch(translation, /Yan|YAgent|ViaTumLab/);
  }
});

test('legacy default names disappear from presentation without changing custom names', () => {
  for (const name of ['', null, undefined, 'Yanxi', '  yanxi  ']) {
    assert.equal(content.normalizeUserName(name), '');
    assert.equal(content.greeting(name), '下一步，交给 Z。');
  }
  assert.equal(content.normalizeUserName('default'), 'default');
  assert.equal(content.normalizeUserName('小李'), '小李');
  assert.equal(content.greeting('小李'), '小李，下一步做什么？');
  assert.equal(content.greeting('Chris', 'en'), 'Chris, what comes next?');
  assert.equal(content.greeting('', 'en'), 'Your next step, with Z.');
});

test('the release-notes bridge exposes only the current Z release data', () => {
  const window = { ZProductContent: content };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/release-notes.js'), 'utf8'), { window });
  assert.equal(window.YanReleaseNotes, content.releaseNotes);
});

test('renderer uses the new guide and FAQ without old contact or updater actions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(source, /'yan-guide': window\.ZProductContent\.guide/);
  assert.match(source, /ABOUT_ERROR_PAGES = window\.ZProductContent\.errors/);
  assert.doesNotMatch(source, /ABOUT_CONTACTS|syncAboutContact|copyAboutContact|aboutContactPicker|aboutCheckUpdateBtn|checkForUpdatesFromAbout|updateInstall|updateDownload/);
});

test('the new about page and welcome prompts have complete English coverage', () => {
  const window = { ZProductContent: content, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf8'), { window, URLSearchParams });
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const areas = [
    html.match(/<section id="tab-about"[\s\S]*?<\/section>/)?.[0],
    html.match(/<button id="guideHint"[\s\S]*?<\/button>/)?.[0],
    html.match(/<div id="emptyHeader"[\s\S]*?(?=<div class="composer-wrap">)/)?.[0]
  ];
  assert.ok(areas.every(Boolean));
  for (const area of areas) {
    const values = [...area.matchAll(/>([^<>]+)</g)].map(match => match[1].trim());
    for (const value of values.filter(value => /[\u3400-\u9fff]/u.test(value))) {
      assert.doesNotMatch(window.YanI18n.translate(value, 'en'), /[\u3400-\u9fff]/u, `Missing shell translation: ${value}`);
    }
  }
});

test('config normalization leaves new names empty and preserves saved personal names', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const normalizeSource = source.slice(source.indexOf('function normalizeUserName(value)'), source.indexOf('function normalizeLanguage(value)'));
  const normalize = vm.runInNewContext(`${normalizeSource}; normalizeUserName;`);
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(''), '');
  assert.equal(normalize(' Alice '), 'Alice');
  assert.equal(normalize('Yanxi'), 'Yanxi', 'legacy saved values are not silently rewritten in storage');
  assert.equal(normalize('小李'), '小李');
});
