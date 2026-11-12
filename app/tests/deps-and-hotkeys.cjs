const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { stripTypeScriptTypes } = require('node:module')

const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')

// 1. Test duplicate hotkey detection in applyHotkeys()
const hotkeyBlock = stripTypeScriptTypes(
  source.slice(source.indexOf('function applyHotkeys()'), source.indexOf('// ------------------------------------------------------------------ window / tray'))
)
const registered = []
const hotkeyCtx = {
  settings: {
    hotkeys: {
      toggle: 'Ctrl+Alt+V',
      bypass: 'ctrl+alt+v', // duplicate of toggle (case-insensitive)
      next: 'Ctrl+Alt+Right',
      prev: '',
      monitor: 'Ctrl+Alt+M',
    },
  },
  globalShortcut: {
    unregisterAll: () => { registered.length = 0 },
    register: (accel) => { registered.push(accel); return true },
  },
  runAction: () => {},
  Map,
}
vm.createContext(hotkeyCtx)
vm.runInContext(hotkeyBlock, hotkeyCtx)
const errors = hotkeyCtx.applyHotkeys()
assert.equal(errors.bypass, 'Уже назначено на другое действие')
assert.equal(errors.toggle, undefined)
assert.deepEqual(Array.from(registered), ['Ctrl+Alt+V', 'Ctrl+Alt+Right', 'Ctrl+Alt+M'])
console.log('PASS: duplicate hotkey detection prevents silent collision')

// 2. Test dirBytes & depsInfo on temporary directory
const dirBlock = stripTypeScriptTypes(
  source.slice(source.indexOf('function dirBytes('), source.indexOf('function launchUninstaller('))
)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vocalis-deps-'))
try {
  const nested = path.join(tmp, 'venv', 'Scripts')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'python.exe'), Buffer.alloc(1024, 1))
  fs.writeFileSync(path.join(tmp, 'marker.bin'), Buffer.alloc(512, 2))
  const depsCtx = {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    rmSync: fs.rmSync,
    join: path.join,
    dirname: path.dirname,
    app: { isPackaged: false, getPath: () => tmp },
    runtimeRoot: tmp,
    pythonExe: path.join(nested, 'python.exe'),
    quitting: false,
    cancelSetup: () => {},
    engineProc: null,
    enginePort: 0,
    engineLog: [],
    restarts: 0,
    setEngineState: () => {},
  }
  vm.createContext(depsCtx)
  vm.runInContext(dirBlock, depsCtx)
  const info = depsCtx.depsInfo()
  assert.equal(info.runtimeBytes, 1536)
  assert.equal(info.pythonInstalled, true)
  assert.equal(info.canUninstall, false)
  console.log('PASS: depsInfo calculates dependency footprint accurately')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
