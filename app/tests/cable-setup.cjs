const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stripTypeScriptTypes } = require('node:module')

function load(extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/cable-setup.ts'), 'utf8')
  const js = stripTypeScriptTypes(source, { mode: 'transform', disableExperimentalWarning: true })
    .replace(/import (\{[^}]+\}) from ('[^']+');?/g, 'const $1 = require($2);')
    .replace(/export (class|const|async function|function) /g, '$1 ') + '\nmodule.exports = { CableSetup, detectCable, downloadCable, CABLE_URL };'
  const exports = {}
  const module = { exports }
  vm.runInNewContext(js, { exports, module, require, process, Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, ...extra })
  return module.exports
}

test('Windows detector includes a disabled installed driver, but rejects detection failures', async () => {
  const { detectCable } = load()
  const devices = await detectCable(async () => JSON.stringify([{ Name: 'VB-Audio Virtual Cable', Status: 'Error', ConfigManagerErrorCode: 22 }, { Name: 'NVIDIA Virtual Audio Device', Status: 'OK', ConfigManagerErrorCode: 0 }]))
  assert.equal(devices.length, 1)
  assert.match(devices[0], /22/)
  await assert.rejects(detectCable(async () => { throw Error('CIM unavailable') }), /CIM unavailable/)
  await assert.rejects(detectCable(async () => '{}'), /Некорректный/)
})

test('setup rechecks before any network; an installed cable or failed check never downloads', async () => {
  const { CableSetup } = load()
  let network = 0
  for (const detect of [async () => ['Virtual Audio Cable'], async () => { throw Error('no CIM') }]) {
    const flow = new CableSetup(os.tmpdir(), () => {}, { detect, download: async () => { network++; return Buffer.alloc(0) }, run: async () => '' })
    const result = await flow.setup()
    assert.ok(['installed', 'error'].includes(result.stage))
  }
  assert.equal(network, 0)
})

test('invalid package hash and redirects stop download before extraction', async () => {
  const { downloadCable, CABLE_URL } = load({ fetch: async () => ({ ok: true, url: CABLE_URL, headers: new Headers(), body: (async function* () { yield Buffer.from('not the signed official ZIP') })() }) })
  await assert.rejects(downloadCable(new AbortController().signal, () => {}), /Контрольная сумма/)
  let options
  const redirect = load({ fetch: async (_url, opts) => { options = opts; throw Error('redirect denied') } })
  await assert.rejects(redirect.downloadCable(new AbortController().signal, () => {}), /redirect denied/)
  assert.equal(options.redirect, 'error')
})

test('parallel setup requests waiting for initial device check cannot start duplicate downloads', async () => {
  const { CableSetup } = load()
  let finishCheck, checks = 0, downloads = 0
  const initial = new Promise(resolve => { finishCheck = resolve })
  const flow = new CableSetup(os.tmpdir(), () => {}, { detect: async () => ++checks === 1 ? initial : [], download: async () => { downloads++; throw Error('mock network failure') }, run: async () => '' })
  const checking = flow.status()
  const first = flow.setup(), second = flow.setup()
  finishCheck([])
  await Promise.all([checking, first, second])
  assert.equal(downloads, 1)
})

test('successful flow validates archive and signature, requests UAC, and preserves awaiting restart on refresh', async () => {
  const { CableSetup } = load()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocalis-cable-test-'))
  const scripts = [], stages = []
  try {
    const flow = new CableSetup(root, state => stages.push(state.stage), { detect: async () => [], download: async (_signal, progress) => { progress(4, 4); return Buffer.from('mock') }, run: async script => { scripts.push(script); return '' } })
    assert.equal((await flow.setup()).stage, 'awaiting-restart')
    assert.deepEqual(stages, ['checking', 'downloading', 'downloading', 'extracting', 'verifying', 'launching', 'awaiting-restart'])
    assert.match(scripts[0], /Unsafe archive entry/)
    assert.match(scripts[0], /67108864/)
    assert.match(scripts[1], /Get-AuthenticodeSignature/)
    assert.match(scripts[2], /-Verb RunAs/)
    assert.match(scripts[2], /Get-AuthenticodeSignature/)
    assert.doesNotMatch(scripts[2], /Restart-Computer|shutdown|ExecutionPolicy|silent/i)
    assert.equal((await flow.status()).stage, 'awaiting-restart')
    await flow.setup()
    assert.equal(scripts.length, 3)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancelled download is recoverable and signature failure never launches installer', async () => {
  const { CableSetup } = load()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocalis-cable-test-'))
  try {
    let downloading
    const started = new Promise(resolve => { downloading = resolve })
    const flow = new CableSetup(root, () => {}, { detect: async () => [], download: async signal => { downloading(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('abort')))) }, run: async () => '' })
    const pending = flow.setup()
    await started
    flow.cancel()
    assert.equal((await pending).stage, 'cancelled')
    assert.equal((await flow.status()).stage, 'available')
    const scripts = []
    const badSignature = new CableSetup(root, () => {}, { detect: async () => [], download: async () => Buffer.alloc(4), run: async script => { scripts.push(script); if (script.includes('Get-AuthenticodeSignature')) throw Error('signature invalid'); return '' } })
    assert.equal((await badSignature.setup()).stage, 'error')
    assert.equal(scripts.some(script => script.includes('Start-Process')), false)
    assert.equal(fs.readdirSync(root).length, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
