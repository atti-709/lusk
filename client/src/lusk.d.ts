interface LuskBridge {
  isElectron: true;
  onOpenSession: (callback: (sessionId: string) => void) => void;
  onRequestCancelPrompt: (callback: () => void) => void;
  showSaveDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ canceled: boolean; filePath: string | null }>;
  showOpenDialog: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ canceled: boolean; filePath: string | null }>;
  getFilePath: (file: File) => string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, base64Data: string) => Promise<void>;
}

declare global {
  interface Window {
    lusk?: LuskBridge;
  }
}

export {};
