import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

function on<T>(channel: string, cb: (data: T) => void) {
  const handler = (_e: IpcRendererEvent, data: T) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  setupEngine: () => ipcRenderer.invoke('engine:setup'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  onEngineState: (cb: (info: unknown) => void) => on('engine:state', cb),
  onEngineLog: (cb: (line: string) => void) => on('engine:log', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  onSettings: (cb: (s: unknown) => void) => on('settings', cb),
  onHotkey: (cb: (e: unknown) => void) => on('hotkey', cb),
  suspendHotkeys: (suspend: boolean) => ipcRenderer.invoke('hotkeys:suspend', suspend),
  rememberVoice: (id: string) => ipcRenderer.invoke('voice:recent', id),
  openFile: (opts: { title: string; filters: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke('dialog:open', opts),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open', url),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  openSoundSettings: () => ipcRenderer.invoke('shell:soundSettings'),
  appInfo: () => ipcRenderer.invoke('app:info'),
}

contextBridge.exposeInMainWorld('vocalis', api)

export type VocalisBridge = typeof api
