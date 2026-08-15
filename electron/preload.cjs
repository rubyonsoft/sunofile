const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sunoBackup', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveConfig: (changes) => ipcRenderer.invoke('config:save', changes),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openDownloadFolder: () => ipcRenderer.invoke('folder:open'),
  launchLogin: () => ipcRenderer.invoke('auth:login'),
  startJob: (options) => ipcRenderer.invoke('job:start', options),
  stopJob: () => ipcRenderer.invoke('job:stop'),
  onJobEvent: (callback) => subscribe('job:event', callback),
});
