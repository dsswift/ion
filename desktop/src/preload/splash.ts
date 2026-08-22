import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { StartupState } from '../shared/startup-state'

const api = {
  getState: (): Promise<StartupState> => ipcRenderer.invoke(IPC.STARTUP_GET_STATE),
  onState: (callback: (state: StartupState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: StartupState) => callback(state)
    ipcRenderer.on(IPC.STARTUP_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.STARTUP_STATE, handler)
  },
  authenticate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.STARTUP_AUTHENTICATE),
  relaunch: (): void => ipcRenderer.send(IPC.STARTUP_RELAUNCH),
  quit: (): void => ipcRenderer.send(IPC.STARTUP_QUIT),
}

contextBridge.exposeInMainWorld('ionStartup', api)
