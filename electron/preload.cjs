const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiframeDesktop', {
  version: ipcRenderer.sendSync('app:get-version-sync'),
  displayVersion: ipcRenderer.sendSync('app:get-display-version-sync'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  getProjectFolder: (accountKey, projectId) => ipcRenderer.invoke('project:get-folder', { accountKey, projectId }),
  chooseProjectFolder: (accountKey, projectId, projectTitle) => ipcRenderer.invoke('project:choose-folder', { accountKey, projectId, projectTitle }),
  syncProjectAssets: payload => ipcRenderer.invoke('project:sync-assets', payload),
  markProjectCleaned: payload => ipcRenderer.invoke('project:mark-cleaned', payload),
});
