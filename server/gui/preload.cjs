const { contextBridge, ipcRenderer } = require('electron');
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('srv', {
  getState: call('state:get'),
  getStatus: call('status:get'),
  start: call('server:start'),
  stop: call('server:stop'),
  saveSettings: call('settings:save'),
  recentLog: call('log:recent'),
  logDates: call('log:dates'),
  readLog: call('log:read'),
  pickUpdate: call('update:pick'),
  registerUpdate: call('update:register'),
  clearUpdate: call('update:clear'),
  openData: call('open:data'),
  openLogs: call('open:logs'),
  copy: call('copy'),
  onState: (handler) => ipcRenderer.on('state', (_e, s) => handler(s)),
  onLog: (handler) => ipcRenderer.on('log', (_e, entry) => handler(entry)),
});
