// D87 P3-0 spike: the preview shell page's only channel to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  report: (type, data) => ipcRenderer.send('spike:report', { type, data }),
  onCommand: (cb) => ipcRenderer.on('spike:command', (_e, cmd) => cb(cmd)),
});
