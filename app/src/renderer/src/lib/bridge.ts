import type { AppSettings, EngineInfo, HotkeyAction } from './types'

export interface DepsInfo {
  runtimeBytes: number
  runtimePath: string
  pythonInstalled: boolean
  canUninstall: boolean
}

interface Bridge {
  engineInfo(): Promise<EngineInfo>
  setupEngine(): Promise<void>
  cancelSetup(): Promise<boolean>
  restartEngine(): Promise<void>
  depsInfo(): Promise<DepsInfo>
  removeRuntimeDeps(): Promise<DepsInfo>
  uninstallApp(): Promise<void>
  saveDiagnostics(content: string): Promise<string | null>
  onEngineState(cb: (info: EngineInfo) => void): () => void
  onEngineLog(cb: (line: string) => void): () => void
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings; hotkeyErrors: Partial<Record<HotkeyAction, string>> }>
  onSettings(cb: (s: AppSettings) => void): () => void
  onHotkey(cb: (e: { action: HotkeyAction; ok: boolean; error?: string }) => void): () => void
  suspendHotkeys(suspend: boolean): Promise<Partial<Record<HotkeyAction, string>>>
  rememberVoice(id: string): Promise<void>
  openFile(opts: { title: string; filters: { name: string; extensions: string[] }[] }): Promise<string | null>
  openExternal(url: string): Promise<void>
  openPath(p: string): Promise<string>
  openSoundSettings(): Promise<void>
  appInfo(): Promise<{ version: string; dataRoot: string; engineDir: string; isDev: boolean; canUninstall: boolean }>
}

export const bridge = (window as unknown as { vocalis: Bridge }).vocalis
