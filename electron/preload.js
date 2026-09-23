'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getState: () => ipcRenderer.invoke('settings:getState'),
  setTrackedHeroes: (characterNames) => ipcRenderer.invoke('settings:setTrackedHeroes', characterNames),
  setComboLayout: (layout) => ipcRenderer.invoke('settings:setComboLayout', layout),
  addHero: (hero) => ipcRenderer.invoke('settings:addHero', hero),
  setHeroColor: (characterName, color) => ipcRenderer.invoke('settings:setHeroColor', characterName, color),
  removeHero: (characterName) => ipcRenderer.invoke('settings:removeHero', characterName),
  getDiagnostics: () => ipcRenderer.invoke('settings:getDiagnostics'),
  setOverlayPort: (port) => ipcRenderer.invoke('settings:setOverlayPort', port),
  setLogsDir: (dir) => ipcRenderer.invoke('settings:setLogsDir', dir),
  browseLogsDir: () => ipcRenderer.invoke('settings:browseLogsDir'),
  sendTestCast: (characterName) => ipcRenderer.invoke('settings:sendTestCast', characterName),
  onDebugEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('debug:event', handler);
    return () => ipcRenderer.removeListener('debug:event', handler);
  },
  getLaunchAtLogin: () => ipcRenderer.invoke('app:getLaunchAtLogin'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('app:setLaunchAtLogin', enabled),
  getAppVersion: () => ipcRenderer.invoke('updates:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
});
