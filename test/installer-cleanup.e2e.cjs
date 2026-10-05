'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../build/installer.nsh'), 'utf8');
const clear = source.match(/  Function un\.ZClearData\r?\n[\s\S]*?  FunctionEnd/)?.[0];
assert.ok(clear, 'the explicit data-cleanup function must exist');
assert.ok(clear.indexOf('SetShellVarContext current') < clear.indexOf('Push "$APPDATA'));
assert.match(source, /Call un\.ZClearData\s+\$\{If\} \$installMode == "all"\s+SetShellVarContext all/);
assert.match(source, /SetFont "Microsoft YaHei UI" 9/);
assert.match(source, /taskkill\.exe" \/F \/T \/IM "\$\{APP_EXECUTABLE_FILENAME\}"/);
assert.doesNotMatch(source, /\/IM "(?:Z Agent|z-agent)\.exe"/);
assert.deepEqual([...clear.matchAll(/Push "\$(APPDATA|LOCALAPPDATA)\\([^"\r\n]+)"/g)].map(match => [match[1], match[2]]), [
  ['APPDATA', 'Z'], ['LOCALAPPDATA', 'Z']
]);
assert.doesNotMatch(clear, /\$TEMP\b|z-agent|Z Agent|ZAgent/,
  'cleanup must not target upstream profiles or shared temporary files');

function findNsis() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis');
    if (fs.existsSync(cache)) for (const entry of fs.readdirSync(cache)) candidates.push(path.join(cache, entry, 'makensis.exe'));
  }
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
    candidates.push(path.join(base, 'NSIS', 'makensis.exe'));
  }
  if (process.platform === 'win32') {
    const located = spawnSync('where.exe', ['makensis.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (located.status === 0) candidates.push(...located.stdout.trim().split(/\r?\n/));
  }
  return candidates.find(file => fs.existsSync(file));
}

function runIsolatedFixture(nsis) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-uninstaller-test-'));
  const quoteNsis = value => value.replaceAll('$', '$$');
  const targetDirs = ['roaming/Z', 'local/Z'];
  const preservedDirs = [
    'roaming/z-agent', 'roaming/Z Agent', 'local/z-agent', 'local/Z Agent',
    'local/z-agent-updater', 'temp/ZAgent', 'temp/z-agent-update',
    'temp/z-dsh-code-review', 'workspace/project', 'roaming/OtherApp'
  ];
  const preservedFiles = ['temp/z-code-workspace.json'];
  // Never run the real uninstaller. Every filesystem root is redirected into
  // this fixture; process termination and PATH modification are not invoked.
  const isolated = source
    .replaceAll('$APPDATA', quoteNsis(root) + '\\roaming')
    .replaceAll('$LOCALAPPDATA', quoteNsis(root) + '\\local')
    .replaceAll('$TEMP', quoteNsis(root) + '\\temp')
    .replace('Call un.ZStopProcesses', 'DetailPrint "Test: no process termination"')
    .replaceAll('!insertmacro RunZPathUpdate "remove"', 'DetailPrint "Test: no PATH modification"');
  assert.doesNotMatch(isolated, /Call un\.ZStopProcesses|!insertmacro RunZPathUpdate "remove"/);
  const include = path.join(root, 'fixture.nsh');
  const script = `Unicode true
Name "Z uninstall regression fixture"
OutFile "${quoteNsis(root)}\\fixture.exe"
RequestExecutionLevel user
SilentInstall silent
!define BUILD_UNINSTALLER
!define APP_EXECUTABLE_FILENAME "Z.exe"
Var installMode
!include "${quoteNsis(include)}"
!insertmacro customHeader
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function un.onInit
 !insertmacro customUnInit
 StrCpy $installMode "all"
 SetShellVarContext all
FunctionEnd
Section
 WriteUninstaller "${quoteNsis(root)}\\uninstall.exe"
SectionEnd
Section "Uninstall"
 StrCpy $ZClearDataRequested "1"
 IfFileExists "${quoteNsis(root)}\\preserve-test" 0 +2
 StrCpy $ZClearDataRequested "0"
 IfFileExists "${quoteNsis(root)}\\lock-test" 0 +2
 System::Call 'Kernel32::CreateFileW(w "${quoteNsis(root)}\\roaming\\Z\\locked.txt", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r9'
 !insertmacro customUnInstall
 IfFileExists "${quoteNsis(root)}\\lock-test" 0 +2
 System::Call 'Kernel32::CloseHandle(p r9)'
SectionEnd
`;
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error) throw result.error;
    return result;
  };
  const assertPreserved = () => {
    for (const rel of preservedDirs) {
      assert.equal(fs.readFileSync(path.join(root, rel, 'keep-or-delete.txt'), 'utf8'), 'fixture', rel + ' must remain unchanged');
    }
    for (const rel of preservedFiles) assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'fixture', rel + ' must remain unchanged');
  };
  try {
    fs.writeFileSync(include, isolated);
    fs.writeFileSync(path.join(root, 'fixture.nsi'), script);
    const compile = run(nsis, ['/V2', path.join(root, 'fixture.nsi')]);
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    assert.equal(run(path.join(root, 'fixture.exe'), ['/S']).status, 0);
    for (const rel of [...targetDirs, ...preservedDirs]) {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
      fs.writeFileSync(path.join(root, rel, 'keep-or-delete.txt'), 'fixture');
    }
    for (const rel of preservedFiles) fs.writeFileSync(path.join(root, rel), 'fixture');
    const result = run(path.join(root, 'uninstall.exe'), ['/S', `_?=${root}`]);
    assert.equal(result.status, 0, JSON.stringify({ files: fs.readdirSync(root, { recursive: true }), status: result.status }));
    for (const rel of targetDirs) assert.equal(fs.existsSync(path.join(root, rel)), false, rel + ' must be removed');
    assertPreserved();
    assert.equal(run(path.join(root, 'uninstall.exe'), ['/S', `_?=${root}`]).status, 0, 'missing paths should not fail');
    const retained = path.join(root, 'roaming/Z');
    fs.mkdirSync(retained, { recursive: true });
    fs.writeFileSync(path.join(retained, 'locked.txt'), 'fixture');
    fs.writeFileSync(path.join(root, 'preserve-test'), '');
    assert.equal(run(path.join(root, 'uninstall.exe'), ['/S', `_?=${root}`]).status, 0);
    assert.ok(fs.existsSync(path.join(retained, 'locked.txt')), 'unchecked must preserve data');
    fs.unlinkSync(path.join(root, 'preserve-test'));
    fs.writeFileSync(path.join(root, 'lock-test'), '');
    assert.equal(run(path.join(root, 'uninstall.exe'), ['/S', `_?=${root}`]).status, 1, 'locked file must report failure');
    assert.ok(fs.existsSync(path.join(retained, 'locked.txt')));
    assertPreserved();
    console.log('NSIS fixture passed: both Z profiles removed; upstream profiles, shared caches and unrelated data preserved; unchecked retained, missing skipped, locked file reported failure.');
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('z-uninstaller-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const nsis = findNsis();
if (nsis) runIsolatedFixture(nsis);
else console.log('Static installer safety checks passed. SKIP: NSIS compiler is unavailable; no uninstaller was executed.');
