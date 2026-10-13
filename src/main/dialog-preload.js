const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback');
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Dialogs can only submit their own result or observe progress. The main process
// additionally checks the exact owning window and top-level frame for each result.
contextBridge.exposeInMainWorld('desktopDialog', {
  submitProjectName: projectName => ipcRenderer.send('project-name-result', { success: true, projectName }),
  cancelProjectName: () => ipcRenderer.send('project-name-result', { success: false }),
  confirm: confirmed => ipcRenderer.send('custom-confirm-result', { confirmed: confirmed === true }),
  closeProgress: () => ipcRenderer.send('close-progress-window'),
  onProgress: callback => subscribe('progress-update', callback),
  onLoadingStep: callback => subscribe('loading-step-update', callback)
});
