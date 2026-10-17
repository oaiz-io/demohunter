const { contextBridge, ipcRenderer, webUtils } = require("electron");
// The only bridge between Studio pages and the desktop shell.
contextBridge.exposeInMainWorld("demohunterDesktop", {
  platform: process.platform,
  info: () => ipcRenderer.invoke("info"),
  open: (dir) => ipcRenderer.invoke("open", dir),
  choose: () => ipcRenderer.invoke("choose"),
  openDropped: (file) => ipcRenderer.invoke("open", webUtils.getPathForFile(file)),
  openFile: (file) => ipcRenderer.invoke("open-file", file),
  showFile: (file) => ipcRenderer.invoke("show-file", file),
  openRepository: () => ipcRenderer.invoke("choose"),
});
