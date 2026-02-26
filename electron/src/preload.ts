import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lusk", {
  isElectron: true,
  onOpenSession: (callback: (sessionId: string) => void) => {
    ipcRenderer.on("open-session", (_event, sessionId: string) => callback(sessionId));
  },
});
