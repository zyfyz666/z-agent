'use strict';

const fs = require('fs');
const path = require('path');

// The chat interface does not need GPU acceleration. Set this before app.ready
// to avoid relying on hardware compositing alongside GPU-heavy applications.
function configureSoftwareRendering(app) {
  app.disableHardwareAcceleration();
}

function createRendererHealthLog(directory, { maxBytes = 1024 * 1024 } = {}) {
  const file = path.join(directory, 'renderer-health.jsonl');
  return {
    file,
    write(event, details = {}) {
      const entry = { time: new Date().toISOString(), event: String(event).slice(0, 80) };
      // Only operational metadata is recorded, never messages, URLs or config.
      for (const key of ['reason', 'exitCode', 'type', 'name', 'pid', 'attempt', 'code']) {
        if (details[key] !== undefined) entry[key] = typeof details[key] === 'number'
          ? details[key] : String(details[key]).slice(0, 120);
      }
      try {
        fs.mkdirSync(directory, { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
          const previous = `${file}.1`;
          if (fs.existsSync(previous)) fs.unlinkSync(previous);
          fs.renameSync(file, previous);
        }
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch { /* Diagnostics must never cause another crash. */ }
    }
  };
}

function attachProcessHealthLogging(app, log) {
  app.on('child-process-gone', (_event, details = {}) => {
    log.write('child-process-gone', details);
  });
}

const RECOVERY_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<title>Z · 恢复界面</title><style>
html{color-scheme:dark;background:#1a1a1a;color:#e6e6e6;font:16px/1.7 'Segoe UI','Microsoft YaHei',sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;-webkit-app-region:drag}
main{max-width:560px;padding:40px;-webkit-app-region:no-drag}h1{font-size:24px;font-weight:600}
p{color:#b7b7b7}nav{display:flex;gap:12px;margin-top:28px}a{color:#e6e6e6;border:1px solid #606060;border-radius:7px;padding:8px 16px;text-decoration:none}a:focus,a:hover{background:#353535;outline:2px solid #999;outline-offset:2px}
</style></head><body><main><h1>Z 的界面暂时无法恢复</h1>
<p>界面连续加载失败，已暂停自动重试。重试只会重新打开界面，不会重复发送消息。</p>
<p>你也可以打开诊断日志，查看渲染进程退出的原因。</p>
<nav><a href="z-recovery://retry">重试打开界面</a><a href="z-recovery://logs">打开诊断日志</a></nav>
</main></body></html>`;

function attachRendererRecovery(window, {
  loadInterface, log, shell, dialog, isQuitting = () => false,
  onAvailabilityChange = () => {}, onShowRecovery = () => {},
  retryDelayMs = 750, loadTimeoutMs = 20000, maxRetries = 2, retryWindowMs = 60000,
  now = Date.now
}) {
  const contents = window.webContents;
  let retryTimer = null;
  let loadTimer = null;
  let disposed = false;
  let recovering = false;
  let fallback = false;
  let nativeShown = false;
  let attempts = [];
  let loadGeneration = 0;
  const available = () => !disposed && !isQuitting() && !window.isDestroyed() && !contents.isDestroyed();
  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(loadTimer);
    retryTimer = loadTimer = null;
  };
  const write = (event, details) => log?.write(event, details);
  const openLogs = () => {
    Promise.resolve(shell?.openPath(log.file)).catch(() => {});
  };
  const showNativeFailure = () => {
    if (!available() || nativeShown) return;
    nativeShown = true;
    write('recovery-page-failed');
    onShowRecovery();
    if (!dialog?.showMessageBox) return;
    Promise.resolve(dialog.showMessageBox(window, {
      type: 'error', title: 'Z 界面恢复失败',
      message: 'Z 暂时无法显示界面',
      detail: '自动恢复已暂停。可以重试打开界面或查看诊断日志；重试不会重复发送消息。',
      buttons: ['重试打开界面', '打开诊断日志', '稍后再试'],
      defaultId: 0, cancelId: 2, noLink: true
    })).then(result => {
      if (!available()) return;
      if (result.response === 0) retryManually();
      else if (result.response === 1) openLogs();
    }).catch(() => {});
  };
  const showRecoveryPage = reason => {
    if (!available()) return;
    clearTimers();
    recovering = false;
    fallback = true;
    loadGeneration++;
    onAvailabilityChange(false);
    write('automatic-recovery-stopped', { reason });
    onShowRecovery();
    loadTimer = setTimeout(showNativeFailure, loadTimeoutMs);
    Promise.resolve(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(RECOVERY_PAGE)}`))
      .catch(showNativeFailure);
  };
  const scheduleRecovery = reason => {
    if (!available() || retryTimer) return;
    clearTimers();
    loadGeneration++;
    onAvailabilityChange(false);
    if (fallback) return showNativeFailure();
    attempts = attempts.filter(time => now() - time < retryWindowMs);
    if (attempts.length >= maxRetries) return showRecoveryPage(reason);
    recovering = true;
    attempts.push(now());
    const generation = loadGeneration;
    write('renderer-recovery-scheduled', { reason, attempt: attempts.length });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!available() || generation !== loadGeneration) return;
      loadTimer = setTimeout(() => {
        if (generation === loadGeneration) scheduleRecovery('load-timeout');
      }, loadTimeoutMs);
      try {
        // Reattach the view to the existing task engine. Never restart the app,
        // kill a worker, or resubmit a user turn here.
        Promise.resolve(loadInterface()).catch(error => {
          if (generation !== loadGeneration || !available()) return;
          write('renderer-reload-failed', { code: error?.code || error?.name });
          scheduleRecovery('load-failed');
        });
      } catch (error) {
        write('renderer-reload-failed', { code: error?.code || error?.name });
        scheduleRecovery('load-failed');
      }
    }, retryDelayMs);
  };
  const retryManually = () => {
    if (!available() || retryTimer || recovering) return;
    fallback = false;
    nativeShown = false;
    attempts = [];
    write('renderer-manual-retry');
    scheduleRecovery('manual-retry');
  };
  const onGone = (_event, details = {}) => {
    write('renderer-process-gone', details);
    if (details.reason === 'clean-exit' || !available()) return;
    scheduleRecovery(details.reason || 'renderer-exited');
  };
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) onAvailabilityChange(false);
  };
  const onLoaded = () => {
    clearTimeout(loadTimer);
    loadTimer = null;
    if (fallback) { onShowRecovery(); return; }
    if (recovering) write('renderer-recovered');
    recovering = false;
    onAvailabilityChange(true);
  };
  const onLoadFailure = (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !available()) return;
    write('renderer-load-failed', { code });
    if (fallback) showNativeFailure();
    else scheduleRecovery('load-failed');
  };
  const onRecoveryNavigation = (event, url) => {
    if (!url.startsWith('z-recovery://')) return;
    event.preventDefault();
    if (!fallback) return;
    if (url === 'z-recovery://retry') retryManually();
    else if (url === 'z-recovery://logs') openLogs();
  };
  const dispose = () => {
    disposed = true;
    loadGeneration++;
    clearTimers();
  };
  contents.on('render-process-gone', onGone);
  contents.on('did-start-navigation', onNavigation);
  contents.on('did-finish-load', onLoaded);
  contents.on('did-fail-load', onLoadFailure);
  contents.on('will-navigate', onRecoveryNavigation);
  window.on('unresponsive', () => write('renderer-unresponsive'));
  window.on('responsive', () => write('renderer-responsive'));
  window.once('closed', dispose);
  return { dispose, retry: retryManually, isRecoveryPage: () => fallback };
}

module.exports = { configureSoftwareRendering, createRendererHealthLog, attachProcessHealthLogging, attachRendererRecovery };
