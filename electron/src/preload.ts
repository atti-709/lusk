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
    ipcRenderer.on("update-downloading", () => callback());
  },

  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on("update-progress", (_event, percent: number) => callback(percent));
  },

  onUpdateError: (callback: (message: string) => void) => {
    ipcRenderer.on("update-error", (_event, message: string) => callback(message));
  },
});
