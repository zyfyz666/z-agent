const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zQuickInput', {
  submit: (text) => ipcRenderer.send('quick-input:submit', String(text || '')),
  close: () => ipcRenderer.send('quick-input:close')
});
