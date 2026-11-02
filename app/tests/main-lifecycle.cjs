// Run after npm run build: node --test tests/main-lifecycle.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function load() {
  const timers = new Map()
  const processes = []
  const registered = []
  const app = { isPackaged: false, getPath: () => 'D:/ai-vocechanger', requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }), on() {}, quit() {} }
  const electron = { app, globalShortcut: { unregisterAll() {}, register: key => { registered.push(key); return true } } }
  const childProcess = { spawn() {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => proc.emit('exit', 0)
    processes.push(proc)
    return proc
  } }
  const filename = path.resolve(__dirname, '../out/main/index.js')
  const source = fs.readFileSync(filename, 'utf8') + '\n globalThis.subject = { startEngine, setupEngine, normalizeSettings, applyHotkeys, setSettings: value => settings = normalizeSettings(value), state: () => ({ engineState, enginePort, engineProc }) };'
  const context = { process: { env: {}, argv: [], pid: 123 }, __dirname: path.dirname(filename), Buffer,
    setTimeout: fn => { const id = {}; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id),
    require: name => name === 'electron' ? electron : name === 'node:child_process' ? childProcess : name === 'node:fs' ? { ...fs, existsSync: () => true, mkdirSync() {} } : require(name) }
  vm.runInNewContext(source, context, { filename })
  return { api: context.subject, timers, processes, registered }
}

test('partial stdout/stderr lines do not corrupt engine readiness', () => {
  const { api, processes } = load()
  api.startEngine()
  processes[0].stdout.emit('data', Buffer.from('VOCALIS_RE'))
  processes[0].stderr.emit('data', Buffer.from('warning\n'))
  processes[0].stdout.emit('data', Buffer.from('ADY 4321\n'))
  assert.equal(api.state().engineState, 'ready')
  assert.equal(api.state().enginePort, 4321)
})

test('spawn errors are handled and duplicate starts do not launch a second engine', () => {
  const { api, processes, timers } = load()
  api.startEngine()
  api.startEngine()
  assert.equal(processes.length, 1)
  processes[0].emit('error', new Error('python unavailable'))
  assert.equal(api.state().engineState, 'crashed')
  assert.equal(timers.size, 1)
  api.startEngine()
  assert.equal(timers.size, 0)
  assert.equal(processes.length, 2)
  processes[0].emit('exit', 1)
  assert.equal(api.state().engineProc, processes[1])
})

test('setup spawn errors return to a recoverable setup state', () => {
  const { api, processes } = load()
  api.setupEngine()
  processes[0].emit('error', new Error('uv unavailable'))
  assert.equal(api.state().engineState, 'needs-setup')
})

test('malformed settings are normalized and duplicate shortcuts are reported', () => {
  const { api, registered } = load()
  const normalized = api.normalizeSettings({ favorites: 'broken', recent: [null, '../bad', 'voice-1', 'voice-1'], closeToTray: 'yes' })
  assert.equal(normalized.favorites.length, 0)
  assert.equal(normalized.recent.join(','), 'voice-1')
  assert.equal(normalized.closeToTray, true)
  api.setSettings({ hotkeys: { toggle: 'Ctrl+Alt+V', bypass: 'Alt+Control+V' } })
  const errors = api.applyHotkeys()
  assert.match(errors.bypass, /уже назначено/)
  assert.equal(registered.filter(key => key === 'Alt+Control+V').length, 0)
})
