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
});
