const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  openDm: call('dm:open'),
  dmIncoming: call('dm:incoming'),
  notify: call('notify'),
  toastClick: call('toast:click'),
  onGoto: (handler) => ipcRenderer.on('goto', (_e, target) => handler(target)),
  pickFiles: call('file:pick'),
  registerDropped: (file) => ipcRenderer.invoke('file:register', webUtils.getPathForFile(file)),
  pathOf: (file) => webUtils.getPathForFile(file),
  savePasted: call('file:savePasted'),
  localFile: call('file:local'),
  readFile: call('file:read'),
  saveStart: call('file:saveStart'),
  saveChunk: call('file:saveChunk'),
  saveEnd: call('file:saveEnd'),
  saveAbort: call('file:saveAbort'),
  openFile: call('file:open'),
  showFile: call('file:show'),
  copyText: call('clipboard:write'),
  getTheme: call('theme:get'),
  setTheme: call('theme:set'),
});
