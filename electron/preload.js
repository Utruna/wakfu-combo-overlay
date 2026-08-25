'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getState: () => ipcRenderer.invoke('settings:getState'),
  setTrackedHeroes: (indexes) => ipcRenderer.invoke('settings:setTrackedHeroes', indexes),
  setComboLayout: (layout) => ipcRenderer.invoke('settings:setComboLayout', layout),
  getDiagnostics: () => ipcRenderer.invoke('settings:getDiagnostics'),
  sendTestCast: (heroIndex) => ipcRenderer.invoke('settings:sendTestCast', heroIndex),
  onDebugEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('debug:event', handler);
    return () => ipcRenderer.removeListener('debug:event', handler);
  },
});
