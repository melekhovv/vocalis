import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Keep automated screenshot runs separate from the user's open application.
if (process.env.VOCALIS_SHOTS) {
  const qaUserData = join(resolve(process.env.VOCALIS_SHOTS), 'user-data')
  mkdirSync(qaUserData, { recursive: true })
  app.setPath('userData', qaUserData)
}

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

function normalizeSettings(raw: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<AppSettings> : {}
  const result = { ...base, hotkeys: { ...base.hotkeys } }
  for (const key of ['closeToTray', 'autostart', 'startMinimized', 'acceptedNotice', 'quickSwitchFavoritesOnly'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  for (const key of ['favorites', 'recent'] as const) {
    if (Array.isArray(value[key])) result[key] = [...new Set(value[key].filter((id): id is string => typeof id === 'string'))]
  }
  for (const key of Object.keys(base.hotkeys) as HotkeyAction[]) {
    if (typeof value.hotkeys?.[key] === 'string') result.hotkeys[key] = value.hotkeys[key]
  }
  return result
}

function loadSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf-8'))
    settings = normalizeSettings(raw)
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
}

function saveSettings() {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

// ------------------------------------------------------------------ engine process
type EngineState = 'needs-setup' | 'installing' | 'starting' | 'ready' | 'crashed'

const isDev = !app.isPackaged
const engineDir = isDev ? resolve(__dirname, '../../../engine') : join(process.resourcesPath, 'engine')
const dataRoot = join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Vocalis')
const runtimeEnv = isDev ? join(engineDir, '.venv') : join(dataRoot, 'runtime', 'venv')
const pythonExe = join(runtimeEnv, 'Scripts', 'python.exe')
const uvExe = isDev
  ? join(process.env.APPDATA || '', 'Python', 'Python314', 'Scripts', 'uv.exe')
  : join(process.resourcesPath, 'bin', 'uv.exe')

const token = randomBytes(24).toString('base64url')
let engineProc: ChildProcess | null = null
let setupProc: ChildProcess | null = null
let enginePort = 0
let engineState: EngineState = 'starting'
let engineLog: string[] = []
let quitting = false
let restarts = 0

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
  return { state: engineState, port: enginePort, token, log: engineLog.slice(-60), dev: isDev }
}

function startEngine() {
  if (engineProc || setupProc || quitting) return
  if (!existsSync(pythonExe)) {
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
  let buf = ''
  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf-8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd()
      buf = buf.slice(i + 1)
      const m = /^VOCALIS_READY (\d+)/.exec(line)
      if (m) {
        engineLog = []
        enginePort = Number(m[1])
        setEngineState('ready')
      } else if (line) {
        pushLog(line)
      }
    }
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  proc.on('error', (error) => {
    if (engineProc !== proc) return
    engineProc = null
    pushLog(`Не удалось запустить движок: ${error.message}`)
    setEngineState('crashed')
  })
  proc.on('exit', (code) => {
    if (engineProc !== proc) return
    engineProc = null
    if (Date.now() - startedAt > 60000) restarts = 0
    if (quitting) return
    pushLog(`[engine exited with code ${code}]`)
    setEngineState('crashed')
    if (restarts < 3) {
      restarts++
      setTimeout(startEngine, 1500)
    }
  })
}

function setupEngine() {
  if (setupProc || engineProc || quitting) return
  if (!existsSync(uvExe)) {
    pushLog(`uv не найден: ${uvExe}`)
    setEngineState('needs-setup')
    return
  }
  engineLog = []
  setEngineState('installing')
  mkdirSync(join(dataRoot, 'runtime'), { recursive: true })
  const proc = spawn(uvExe, ['sync', '--frozen', '--python', '3.11'], {
    cwd: engineDir,
    env: {
      ...process.env,
      UV_PROJECT_ENVIRONMENT: runtimeEnv,
      UV_PYTHON_INSTALL_DIR: join(dataRoot, 'runtime', 'python'),
      UV_HTTP_TIMEOUT: '300',
      UV_HTTP_RETRIES: '8',
    },
    windowsHide: true,
  })
  setupProc = proc
  const onData = (chunk: Buffer) => {
    chunk.toString('utf-8').split(/[\r\n]+/).filter(Boolean).forEach(pushLog)
    win?.webContents.send('engine:state', engineInfo())
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  proc.on('error', (error) => {
    if (setupProc !== proc) return
    setupProc = null
    if (!quitting) { pushLog(error.message); setEngineState('needs-setup') }
  })
  proc.on('exit', (code) => {
    if (setupProc !== proc) return
    setupProc = null
    if (quitting) return
    if (code === 0) startEngine()
    else {
      pushLog(`[установка завершилась с кодом ${code}]`)
      setEngineState('needs-setup')
    }
  })
}

async function engineFetch(path: string, body?: unknown) {
  if (engineState !== 'ready') throw new Error('engine not ready')
  const r = await fetch(`http://127.0.0.1:${enginePort}${path}`, {
    signal: AbortSignal.timeout(path === '/shutdown' ? 3000 : 60000),
    method: body === undefined ? 'GET' : 'POST',
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
        const fav = ready.filter((id) => settings.favorites.includes(id))
        if (fav.length) ready = fav
      }
      if (!ready.length) return
      const cur = ready.indexOf(e.voiceId)
      const next = ready[cur < 0 ? (action === 'next' ? 0 : ready.length - 1) : (cur + (action === 'next' ? 1 : -1) + ready.length) % ready.length]
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
  for (const [action, accel] of Object.entries(settings.hotkeys) as [HotkeyAction, string][]) {
    if (!accel) continue
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
      backgroundThrottling: !process.env.VOCALIS_SHOTS,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => {
    if (!process.env.VOCALIS_SHOTS && !(settings.startMinimized && process.argv.includes('--hidden'))) win?.show()
  })
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => { win = null })
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
  if (quitting) return
  quitting = true
  setupProc?.kill()
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
  ipcMain.handle('engine:setup', () => setupEngine())
  ipcMain.handle('engine:restart', () => {
    if (setupProc || quitting) return
    restarts = 0
    if (engineProc) engineProc.kill()
    else startEngine()
  })
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    settings = normalizeSettings(patch, settings)
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

// ------------------------------------------------------------------ QA screenshots
// VOCALIS_SHOTS=<dir> walks every page once the UI is connected and saves PNGs.
async function captureShots(dir: string) {
  mkdirSync(dir, { recursive: true })
  const dimensions = process.env.VOCALIS_SHOTS_SIZE?.match(/^(\d+)x(\d+)$/)
  if (dimensions) win!.setSize(Number(dimensions[1]), Number(dimensions[2]))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const js = (code: string) => win!.webContents.executeJavaScript(code)
  const layout = async (name: string) => {
    const report = await js(`({width: innerWidth, height: innerHeight, overflow: [...document.querySelectorAll('main *, [role=dialog] *')].filter(e => {
      const r=e.getBoundingClientRect(); const c=getComputedStyle(e);
      return r.width && r.height && c.visibility !== 'hidden' && (r.right > innerWidth+1 || r.left < -1);
    }).map(e => ({tag:e.tagName, slot:e.getAttribute('data-slot'), text:e.textContent?.slice(0,100)}))})`)
    writeFileSync(join(dir, name + '-layout.json'), JSON.stringify(report, null, 2))
  }
  const snapshot = async () => {
    // A hidden window may otherwise return its previous compositor frame.
    await win!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await sleep(200)
    return win!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  }
  for (let i = 0; i < 60; i++) {
    if (await js(`!!document.querySelector('aside nav')`)) break
    await sleep(500)
  }
  await sleep(2500)
  await win!.webContents.insertCSS('* { animation: none !important; transition: none !important; }')
  await js(`document.querySelector('[role=alertdialog] button')?.click()`)
  const pages = ['Главная', 'Библиотека голосов', 'Менеджер моделей', 'Настройки', 'Система']
  for (const [i, label] of pages.entries()) {
    await js(`[...document.querySelectorAll('aside nav button')].find(b => b.textContent.includes(${JSON.stringify(label)}))?.click()`)
    await sleep(1800)
    const img = await snapshot()
    writeFileSync(join(dir, `${i + 1}-${label}.png`), img.toPNG())
    await layout(String(i + 1))
    if (label === 'Менеджер моделей') {
      for (let check = 0; check < 30; check++) {
        if (await js(`document.querySelector('main h1')?.textContent === 'Менеджер моделей'`)) break
        await sleep(150)
      }
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Источники')?.click()`)
      for (let check = 0; check < 30; check++) {
        if (await js(`!!document.querySelector('[role=dialog]')?.textContent.includes('Warlock700')`)) break
        await sleep(150)
      }
      writeFileSync(join(dir, 'sources-dom.json'), JSON.stringify(await js(`({buttons: [...document.querySelectorAll('button')].map(b=>b.textContent), dialog: document.querySelector('[role=dialog]')?.outerHTML ?? null})`), null, 2))
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      await sleep(1000)
      writeFileSync(join(dir, '3-sources.png'), (await snapshot()).toPNG())
      await js(`document.querySelector('[data-slot=dialog-close]')?.click()`)
      await sleep(300)
    }
    if (label === 'Менеджер моделей') {
      // Exercise the real import picker UI without opening a native dialog or reading a model.
      ipcMain.removeHandler('dialog:open')
      ipcMain.handle('dialog:open', () => 'C:\\Models\\' + 'Very-long-model-directory-'.repeat(16) + '\\voice.pth')
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Импорт'))?.click()`)
      await sleep(400)
      await js(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('Обзор'))?.click()`)
      await sleep(400)
      writeFileSync(join(dir, '3-import.png'), (await snapshot()).toPNG())
      await layout('3-import')
      await js(`document.querySelector('[data-slot=dialog-close]')?.click()`)
    }
    if (label !== 'Настройки') continue
    for (const tab of ['Виртуальный микрофон', 'Обработка', 'Производительность', 'Горячие клавиши', 'Приложение']) {
      await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.includes(${JSON.stringify(tab)}))?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0, ctrlKey: false}))`)
      await sleep(1200)
      writeFileSync(join(dir, `4-settings-${tab}-dom.json`), JSON.stringify(await js(`({tabs:[...document.querySelectorAll('[role=tab]')].map(t=>({label:t.textContent,selected:t.getAttribute('aria-selected')})),text:document.querySelector('[role=tabpanel]')?.textContent})`), null, 2))
      writeFileSync(join(dir, `4-settings-${tab}.png`), (await snapshot()).toPNG())
      await layout('4-' + tab)
    }
  }
  quit()
}

// ------------------------------------------------------------------ lifecycle
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
    registerIpc()
    createWindow()
    createTray()
    applyHotkeys()
    startEngine()
    if (process.env.VOCALIS_SHOTS) win!.once('ready-to-show', () => captureShots(process.env.VOCALIS_SHOTS!))
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', () => {
    quitting = true
    setupProc?.kill()
    engineProc?.kill()
  })
  app.on('window-all-closed', () => {
    if (!settings.closeToTray) quit()
  })
}
