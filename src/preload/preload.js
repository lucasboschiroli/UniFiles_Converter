const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Everything the renderer is allowed to touch. No direct Node / file access
// from renderer code — it only ever calls these, which go through main.
contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, v) => cb(v)),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

    pickFiles: () => ipcRenderer.invoke('files:pick'),
    pickFilesFolder: () => ipcRenderer.invoke('files:pickFolder'),
    // Dropped File objects -> their paths on disk.
    describeDropped: (files) => ipcRenderer.invoke('files:describe', Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    thumb: (file) => ipcRenderer.invoke('files:thumb', file),

    pickFolder: (current) => ipcRenderer.invoke('folder:pick', current),
    showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
    openFile: (file) => ipcRenderer.invoke('shell:open', file),

    toolStatus: () => ipcRenderer.invoke('tools:status'),
    startConvert: (jobs, options) => ipcRenderer.invoke('convert:start', { jobs, options }),
    cancelConvert: () => ipcRenderer.invoke('convert:cancel'),
    onConvertEvent: (cb) => {
        const h = (_e, ev) => cb(ev);
        ipcRenderer.on('convert:event', h);
        return () => ipcRenderer.removeListener('convert:event', h);
    },
});
