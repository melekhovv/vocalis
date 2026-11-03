const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { stripTypeScriptTypes } = require('node:module')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main/index.ts'), 'utf8')
const settingsSource = source.slice(source.indexOf('export type HotkeyAction'), source.indexOf('function loadSettings()')).replace('export type', 'type')
const context = { app: {}, join: () => '' }
vm.createContext(context)
vm.runInContext(stripTypeScriptTypes(settingsSource), context)
const normalize = context.normalizeSettings
for (const raw of [null, [], 1, 'broken', { favorites: null, recent: {}, closeToTray: 'false', hotkeys: { toggle: 1 } }]) {
  const result = normalize(raw)
  assert.deepEqual(Array.from(result.favorites), [])
  assert.deepEqual(Array.from(result.recent), [])
  assert.equal(result.closeToTray, true)
  assert.equal(result.hotkeys.toggle, 'Ctrl+Alt+V')
}
const result = normalize({ favorites: ['a', 2, 'a', 'b'], recent: ['a'], closeToTray: false, hotkeys: { toggle: '', unknown: 'Ctrl+X' } })
assert.deepEqual(Array.from(result.favorites), ['a', 'b'])
assert.equal(result.closeToTray, false)
assert.equal(result.hotkeys.toggle, '')
assert.equal(result.hotkeys.unknown, undefined)
assert.deepEqual(Array.from(normalize({ autostart: true }, result).favorites), ['a', 'b'], 'patch preserves existing preferences')
console.log('PASS: malformed settings recovery, deduplication, known keys, incremental updates')

const actionSource = stripTypeScriptTypes(source.slice(source.indexOf('async function runAction('), source.indexOf('function rememberRecent(')))
let selected
Object.assign(context, {
  settings: { quickSwitchFavoritesOnly: false }, win: null, rememberRecent: () => {},
  engineFetch: async (path, body) => {
    if (path === '/status') return { engine: { voiceId: null } }
    if (path === '/voices') return ['a', 'b', 'c'].map(id => ({ id, status: 'ready' }))
    selected = body.id
  },
})
vm.runInContext(actionSource, context)
;(async () => {
  await context.runAction('prev')
  assert.equal(selected, 'c', 'previous from no selection starts with last voice')
  await context.runAction('next')
  assert.equal(selected, 'a', 'next from no selection starts with first voice')
  console.log('PASS: quick switch without existing selection')
})().catch(error => { console.error(error); process.exitCode = 1 })
