import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("lusk", {
  isElectron: true,

  onOpenSession: (callback: (sessionId: string) => void) => {
    ipcRenderer.on("open-session", (_event, sessionId: string) => callback(sessionId));
  },

  onRequestCancelPrompt: (callback: () => void) => {
    ipcRenderer.on("request-cancel-prompt", () => callback());
  },

  showSaveDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => ipcRenderer.invoke("show-save-dialog", options ?? {}),

  showOpenDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => ipcRenderer.invoke("show-open-dialog", options ?? {}),

  getFilePath: (file: File) => webUtils.getPathForFile(file),

  readFile: (filePath: string) => ipcRenderer.invoke("read-file", filePath),

  writeFile: (filePath: string, base64Data: string) =>
    ipcRenderer.invoke("write-file", filePath, base64Data),

  onUpdateDownloading: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("update-downloading", handler);
    return () => { ipcRenderer.removeListener("update-downloading", handler); };
  },

  onUpdateProgress: (callback: (percent: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, percent: number) => callback(percent);
    ipcRenderer.on("update-progress", handler);
    return () => { ipcRenderer.removeListener("update-progress", handler); };
  },

  onUpdateError: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("update-error", handler);
    return () => { ipcRenderer.removeListener("update-error", handler); };
  },
});
