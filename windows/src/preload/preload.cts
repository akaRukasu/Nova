// Pont entre l'interface (sans accès au système) et le processus principal.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nova', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const wrapped = (_event: unknown, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
