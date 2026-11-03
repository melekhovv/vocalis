import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CableSetup } from './cable-setup'

// ------------------------------------------------------------------ settings
export type HotkeyAction = 'toggle' | 'bypass' | 'next' | 'prev' | 'monitor'

interface AppSettings {
  hotkeys: Record<HotkeyAction, string>
  favorites: string[]
  recent: string[]
  closeToTray: boolean
  autostart: boolean
  startMinimized: boolean
  acceptedNotice: boolean
  quickSwitchFavoritesOnly: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  hotkeys: {
    toggle: 'Ctrl+Alt+V',
    bypass: 'Ctrl+Alt+B',
    next: 'Ctrl+Alt+Right',
    prev: 'Ctrl+Alt+Left',
    monitor: 'Ctrl+Alt+M',
  },
  favorites: [],
  recent: [],
  closeToTray: true,
  autostart: false,
  startMinimized: false,
  acceptedNotice: false,
  quickSwitchFavoritesOnly: false,
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
let settings: AppSettings = DEFAULT_SETTINGS

function normalizeSettings(raw: unknown): AppSettings {
  const data = raw && typeof raw === 'object' ? raw as Partial<AppSettings> : {}
  const result: AppSettings = {
    ...DEFAULT_SETTINGS,
    hotkeys: { ...DEFAULT_SETTINGS.hotkeys },
    favorites: [], recent: [],
  }
  for (const key of ['closeToTray', 'autostart', 'startMinimized', 'acceptedNotice', 'quickSwitchFavoritesOnly'] as const) {
    if (typeof data[key] === 'boolean') result[key] = data[key]
  }
  for (const key of ['favorites', 'recent'] as const) {
    if (Array.isArray(data[key])) result[key] = [...new Set(data[key].filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))]
  }
  result.recent = result.recent.slice(0, 6)
  for (const key of Object.keys(result.hotkeys) as HotkeyAction[]) {
    if (typeof data.hotkeys?.[key] === 'string') result.hotkeys[key] = data.hotkeys[key]
  }
  return result
}

function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    settings = normalizeSettings(raw)
  } catch {
    settings = normalizeSettings({})
  }
}

function saveSettings() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const pending = settingsFile() + '.tmp'
  writeFileSync(pending, JSON.stringify(settings, null, 2))
  renameSync(pending, settingsFile())
}

// ------------------------------------------------------------------ engine process
type EngineState = 'needs-setup' | 'installing' | 'starting' | 'ready' | 'crashed'
type SetupProfile = 'nvidia' | 'amd' | 'laptop' | 'cpu'
interface SetupProgress {
  profile: SetupProfile
  stage: 'preparing' | 'downloading' | 'installing' | 'verifying' | 'complete' | 'cancelled' | 'error'
  detail: string
  error?: string
}

const isDev = !app.isPackaged
const engineDir = isDev ? resolve(__dirname, '../../../engine') : join(process.resourcesPath, 'engine')
const dataRoot = join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Vocalis')
const runtimeEnv = isDev ? join(engineDir, '.venv') : join(dataRoot, 'runtime', 'venv')
const pythonExe = join(runtimeEnv, 'Scripts', 'python.exe')
// Only installations touched by setup are marked; existing working environments
// from earlier releases remain usable without migration.
const incompleteSetupFile = runtimeEnv + '.setup-incomplete'
const uvExe = isDev
  ? resolve(engineDir, '../app/build/bin/uv.exe')
  : join(process.resourcesPath, 'bin', 'uv.exe')

const token = randomBytes(24).toString('base64url')
let engineProc: ChildProcess | null = null
let installerProc: ChildProcess | null = null
let restartTimer: ReturnType<typeof setTimeout> | undefined
let enginePort = 0
let engineState: EngineState = 'starting'
let engineLog: string[] = []
let quitting = false
let restarts = 0
let setupProgress: SetupProgress | undefined
let setupProfile: SetupProfile = 'nvidia'
let setupCancelled = false
let clearLogOnReady = false

const profileFile = () => join(dataRoot, 'runtime', 'profile.json')

function updateSetup(stage: SetupProgress['stage'], detail: string, error?: string) {
  setupProgress = { profile: setupProfile, stage, detail, ...(error ? { error } : {}) }
  win?.webContents.send('engine:state', engineInfo())
}

function pushLog(line: string) {
  engineLog.push(line)
  if (engineLog.length > 400) engineLog = engineLog.slice(-400)
  win?.webContents.send('engine:log', line)
}

function setEngineState(s: EngineState) {
  engineState = s
  win?.webContents.send('engine:state', engineInfo())
}

function engineInfo() {
  return { state: engineState, port: enginePort, token, log: engineLog.slice(-60), dev: isDev, setup: setupProgress, setupProfile }
}

function startEngine() {
  if (quitting || engineProc || installerProc) return
  clearTimeout(restartTimer)
  if (existsSync(incompleteSetupFile) || !existsSync(pythonExe)) {
    setEngineState('needs-setup')
    return
  }
  setEngineState('starting')
  const startedAt = Date.now()
  const proc = spawn(pythonExe, ['-u', '-m', 'vcengine.server', '--port', '0', '--parent-pid', String(process.pid)], {
    cwd: engineDir,
    env: { ...process.env, VOCALIS_TOKEN: token, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true,
  })
  engineProc = proc
  const readLines = () => {
    let buf = ''
    return (chunk: Buffer) => {
    buf += chunk.toString('utf-8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd()
      buf = buf.slice(i + 1)
      const m = /^VOCALIS_READY (\d+)/.exec(line)
      if (m) {
        enginePort = Number(m[1])
        if (clearLogOnReady) {
          engineLog = []
          clearLogOnReady = false
        }
        if (setupProgress?.stage === 'verifying') updateSetup('complete', 'Движок установлен и готов к работе.')
        setEngineState('ready')
      } else if (line) {
        pushLog(line)
      }
    }
  }
  }
  proc.stdout?.on('data', readLines())
  proc.stderr?.on('data', readLines())
  let finished = false
  const finish = (code: number | null, error?: Error) => {
    if (finished) return
    finished = true
    if (engineProc !== proc) return
    engineProc = null
    if (quitting) return
    pushLog(error ? `[engine could not start: ${error.message}]` : `[engine exited with code ${code}]`)
    if (setupProgress?.stage === 'verifying') updateSetup('error', 'Зависимости установлены, но движок не запустился. Подробности в журнале.', error?.message || `Код ${code}`)
    setEngineState('crashed')
    if (Date.now() - startedAt > 60000) restarts = 0
    if (restarts < 3) {
      restarts++
      restartTimer = setTimeout(startEngine, 1500)
    }
  }
  proc.once('error', (error) => finish(null, error))
  proc.once('exit', (code) => finish(code))
}

function setupEngine(profile: SetupProfile = 'nvidia') {
  if (quitting || installerProc || engineProc || engineState === 'installing') return
  if (!['nvidia', 'amd', 'laptop', 'cpu'].includes(profile)) throw new Error('Неизвестный профиль установки')
  setupProfile = profile
  setupCancelled = false
  updateSetup('preparing', 'Подготовка Python 3.11 и окружения. Потребуются интернет и свободное место на диске.')
  if (!existsSync(uvExe)) {
    pushLog(`uv не найден: ${uvExe}`)
    updateSetup('error', 'Не найден установщик uv. Переустановите Vocalis.', 'uv не найден')
    setEngineState('needs-setup')
    return
  }
  setEngineState('installing')
  mkdirSync(join(dataRoot, 'runtime'), { recursive: true })
  try {
    writeFileSync(incompleteSetupFile, JSON.stringify({ profile, startedAt: new Date().toISOString() }))
  } catch (error) {
    updateSetup('error', 'Не удалось сохранить состояние установки. Проверьте доступ к диску.', String(error))
    setEngineState('needs-setup')
    return
  }
  const proc = spawn(uvExe, ['sync', '--frozen', '--python', '3.11', '--no-progress'], {
    cwd: profile === 'nvidia' ? engineDir : join(engineDir, 'profiles', 'cpu'),
    env: {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: runtimeEnv,
      UV_PYTHON_INSTALL_DIR: join(dataRoot, 'runtime', 'python'),
      UV_HTTP_TIMEOUT: '300',
      UV_HTTP_RETRIES: '8',
    },
    windowsHide: true,
  })
  installerProc = proc
  const readInstallerLines = () => {
    let pending = ''
    return (chunk: Buffer) => {
      pending += chunk.toString('utf-8')
      const lines = pending.split(/[\r\n]+/)
      pending = lines.pop() || ''
      for (const line of lines.filter(Boolean)) {
        pushLog(line)
        const stage = /download/i.test(line) ? 'downloading' : /install|uninstall|prepared/i.test(line) ? 'installing' : setupProgress?.stage || 'preparing'
        updateSetup(stage, line)
      }
    }
  }
  proc.stdout?.on('data', readInstallerLines())
  proc.stderr?.on('data', readInstallerLines())
  let finished = false
  proc.once('error', (error) => {
    if (finished) return
    finished = true
    installerProc = null
    pushLog(`Не удалось запустить установку: ${error.message}`)
    updateSetup('error', 'Не удалось запустить установку. Можно повторить попытку.', error.message)
    if (!quitting) setEngineState('needs-setup')
  })
  proc.on('exit', (code) => {
    if (finished) return
    finished = true
    installerProc = null
    if (quitting) return
    if (setupCancelled) {
      updateSetup('cancelled', 'Установка отменена. Для продолжения запустите её повторно.')
      setEngineState('needs-setup')
    } else if (code === 0) {
      updateSetup('verifying', 'Зависимости установлены. Проверяем запуск движка…')
      try {
        writeFileSync(profileFile(), JSON.stringify({ profile: setupProfile }))
        unlinkSync(incompleteSetupFile)
      } catch (error) {
        updateSetup('error', 'Не удалось завершить настройку. Проверьте доступ к диску и повторите установку.', String(error))
        setEngineState('needs-setup')
        return
      }
      startEngine()
    }
    else {
      pushLog(`[установка завершилась с кодом ${code}]`)
      updateSetup('error', 'Установка не завершена. Проверьте сеть, свободное место и журнал; затем повторите попытку.', `Код ${code}`)
      setEngineState('needs-setup')
    }
  })
}

async function engineFetch(path: string, body?: unknown) {
  if (engineState !== 'ready') throw new Error('engine not ready')
  const r = await fetch(`http://127.0.0.1:${enginePort}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'X-Vocalis-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await r.json()
  if (!r.ok) throw new Error(json.detail || r.statusText)
  return json
}

// ------------------------------------------------------------------ hotkeys
async function runAction(action: HotkeyAction) {
  try {
    const st = await engineFetch('/status')
    const e = st.engine
    if (action === 'toggle') {
      await engineFetch(e.state === 'running' || e.state === 'loading' ? '/engine/stop' : '/engine/start', {})
    } else if (action === 'bypass') {
      await engineFetch('/engine/params', { bypass: !e.params.bypass })
    } else if (action === 'monitor') {
      await engineFetch('/engine/params', { monitor: !e.params.monitor })
    } else {
      const voices: { id: string; status: string; suggestedPitch: number }[] = await engineFetch('/voices')
      let ready = voices.filter((v) => v.status === 'ready').map((v) => v.id)
      if (settings.quickSwitchFavoritesOnly) {
        ready = ready.filter((id) => settings.favorites.includes(id))
      }
      if (!ready.length) return
      const cur = ready.indexOf(e.voiceId)
      const index = cur < 0 ? (action === 'next' ? 0 : ready.length - 1) : (cur + (action === 'next' ? 1 : -1) + ready.length) % ready.length
      const next = ready[index]
      await engineFetch('/engine/voice', { id: next })
      rememberRecent(next)
    }
    win?.webContents.send('hotkey', { action, ok: true })
  } catch (err) {
    win?.webContents.send('hotkey', { action, ok: false, error: String((err as Error).message || err) })
  }
}

function rememberRecent(id: string) {
  settings.recent = [id, ...settings.recent.filter((x) => x !== id)].slice(0, 6)
  saveSettings()
  win?.webContents.send('settings', settings)
}

function applyHotkeys(): Record<string, string> {
  globalShortcut.unregisterAll()
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [action, accel] of Object.entries(settings.hotkeys) as [HotkeyAction, string][]) {
    if (!accel) continue
    const normalized = accel.toLowerCase().replace(/control/g, 'ctrl').replace(/\s/g, '').split('+').sort().join('+')
    if (seen.has(normalized)) {
      errors[action] = 'Это сочетание уже назначено другому действию'
      continue
    }
    seen.add(normalized)
    try {
      if (!globalShortcut.register(accel, () => runAction(action))) errors[action] = 'Сочетание занято другим приложением'
    } catch {
      errors[action] = 'Некорректное сочетание клавиш'
    }
  }
  return errors
}

// ------------------------------------------------------------------ window / tray
let win: BrowserWindow | null = null
let tray: Tray | null = null

function iconPath() {
  return isDev ? resolve(__dirname, '../../build/icon.png') : join(process.resourcesPath, 'icon.png')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#14141a',
    title: 'Vocalis',
    icon: existsSync(iconPath()) ? iconPath() : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#a1a1aa', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    if (!(settings.startMinimized && process.argv.includes('--hidden'))) win?.show()
  })
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray() {
  const img = existsSync(iconPath()) ? nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip('Vocalis')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Vocalis', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Вкл / выкл преобразование', click: () => runAction('toggle') },
      { label: 'Оригинальный голос (Bypass)', click: () => runAction('bypass') },
      { label: 'Следующий голос', click: () => runAction('next') },
      { type: 'separator' },
      { label: 'Выход', click: () => quit() },
    ]),
  )
  tray.on('click', () => (win?.isVisible() ? win.focus() : win?.show()))
}

async function quit() {
  quitting = true
  cableSetup.cancel()
  clearTimeout(restartTimer)
  installerProc?.kill()
  try {
    if (engineState === 'ready') await engineFetch('/shutdown', {})
  } catch {
    /* engine already gone */
  }
  setTimeout(() => {
    engineProc?.kill()
    app.quit()
  }, 300)
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  ipcMain.handle('engine:info', () => engineInfo())
  ipcMain.handle('engine:setup', (_e, profile?: SetupProfile) => setupEngine(profile))
  ipcMain.handle('engine:cancelSetup', () => {
    if (!installerProc) return
    setupCancelled = true
    installerProc.kill()
  })
  ipcMain.handle('setup:cable', () => shell.openExternal('https://vb-audio.com/Cable/'))
  ipcMain.handle('cable:status', () => cableSetup.status())
  ipcMain.handle('cable:setup', () => cableSetup.setup())
  ipcMain.handle('cable:cancel', () => cableSetup.cancel())
  ipcMain.handle('engine:restart', () => {
    clearLogOnReady = true
    restarts = 0
    if (engineProc) engineProc.kill()
    else startEngine()
  })
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    settings = normalizeSettings({ ...settings, ...patch, hotkeys: { ...settings.hotkeys, ...(patch.hotkeys || {}) } })
    saveSettings()
    let hotkeyErrors = {}
    if (patch.hotkeys) hotkeyErrors = applyHotkeys()
    if (patch.autostart !== undefined) {
      app.setLoginItemSettings({ openAtLogin: settings.autostart, args: ['--hidden'] })
    }
    win?.webContents.send('settings', settings)
    return { settings, hotkeyErrors }
  })
  ipcMain.handle('voice:recent', (_e, id: string) => rememberRecent(id))
  ipcMain.handle('hotkeys:suspend', (_e, suspend: boolean) => {
    // While the user records a new shortcut, existing ones must not fire.
    if (suspend) globalShortcut.unregisterAll()
    else return applyHotkeys()
    return {}
  })
  ipcMain.handle('dialog:open', async (_e, opts: { title: string; filters: { name: string; extensions: string[] }[] }) => {
    const r = await dialog.showOpenDialog(win!, { title: opts.title, filters: opts.filters, properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:soundSettings', () => shell.openExternal('ms-settings:sound'))
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataRoot, engineDir, isDev }))
}

// ------------------------------------------------------------------ lifecycle
const cableSetup = new CableSetup(app.getPath('temp'), info => win?.webContents.send('cable:state', info))
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    win?.show()
    win?.focus()
  })
  app.whenReady().then(() => {
    app.setAppUserModelId('app.vocalis')
    loadSettings()
    try {
      const saved = JSON.parse(readFileSync(profileFile(), 'utf-8'))
      if (['nvidia', 'amd', 'laptop', 'cpu'].includes(saved.profile)) setupProfile = saved.profile
    } catch { /* first launch */ }
    registerIpc()
    createWindow()
    void cableSetup.status()
    createTray()
    applyHotkeys()
    startEngine()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', () => {
    quitting = true
    cableSetup.cancel()
    clearTimeout(restartTimer)
    installerProc?.kill()
    engineProc?.kill()
  })
  app.on('window-all-closed', () => {
    if (!settings.closeToTray) quit()
  })
}
