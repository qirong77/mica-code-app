import { contextBridge, ipcRenderer } from 'electron'

const terminalApi = {
  create: (payload) => ipcRenderer.invoke('terminal:create', payload),
  write: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  dispose: (id) => ipcRenderer.invoke('terminal:dispose', { id }),
  disposeAll: () => ipcRenderer.invoke('terminal:dispose-all'),
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  }
}

const workspaceApi = {
  get: () => ipcRenderer.invoke('workspace:get'),
  save: (workspace) => ipcRenderer.invoke('workspace:save', workspace)
}

contextBridge.exposeInMainWorld('mica', {
  terminal: terminalApi,
  workspace: workspaceApi,
  platform: process.platform
})
