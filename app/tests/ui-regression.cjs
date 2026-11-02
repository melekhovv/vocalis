// Run after npm run build. Requires Playwright, optionally via PLAYWRIGHT_MODULE.
// BROWSER_EXECUTABLE may point to an existing Chrome/Chromium executable.
// All engine, bridge and avatar data are fixtures; no microphone is opened.
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const voices = ['Рик Санчез', 'Соник'].map((name, i) => ({
  id: `voice-${i}`, name, nameRu: name, wikipedia: `Fixture_${i}`, franchise: 'Test',
  category: 'cartoon', accent: '#a78bfa', suggestedPitch: i, status: 'ready',
  description: 'Тестовый голос для проверки интерфейса', language: 'ru-RU', custom: false, compatible: true, diskSize: 1000, downloadSize: 1000,
  checkpoint: { version: 'v2', sampleRate: 40000, f0: true, vocoder: 'HiFi-GAN' },
  model: { title: name, format: 'RVC v2', upstream: '', license: '' },
}))
const fixture = {
  engine: {
    state: 'running', voiceId: 'voice-0', preset: 'balanced',
    devices: { input: 4, output: 1, monitor: 0 },
    compute: 'auto',
    params: { pitch: 0, index_rate: 0.5, protect: 0.33, f0_method: 'rmvpe', noise_gate_db: -50, monitor: false, monitor_gain: 0.8, input_gain: 1, output_gain: 1, clarity_mode: false, noise_filter: true, vad: false, bypass: false, ptt: false, ptt_vk: 20, volume_envelope: 1 },
    stats: { totalLatencyMs: 300, streamLatencyMs: 20, inferMs: 60, device: 'test', inputDb: -20, outputDb: -20, inferMsAvg: 60, blockMs: 200, realtimeFactor: 0.3, inputDrops: 0, outputUnderruns: 0 },
  },
  baseAssets: { ready: true, items: [] }, system: { cpu: 5, ram: 10, processRamMb: 500 }, voices, rev: 1,
}
const devices = {
  outputs: [
    { id: 0, name: 'Наушники USB', channels: 2, isVirtualCable: false },
    { id: 1, name: 'CABLE Input', channels: 2, isVirtualCable: true },
    { id: 2, name: 'Другие наушники', channels: 2, isVirtualCable: false },
  ], inputs: [{ id: 4, name: 'Микрофон USB' }], defaultOutput: 1,
}

async function main() {
  const root = path.resolve(__dirname, '../out/renderer')
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
  const server = http.createServer(async (req, res) => {
    const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]))
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
    try {
      const data = await fs.readFile(file)
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(data)
    } catch { res.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    const calls = []
    let failMonitorChange = false
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(({ fixture, port }) => {
      window.__fixture = fixture
      window.__ticks = 0
      const settings = { recent: ['voice-0', 'voice-1'], favorites: ['voice-1'], acceptedNotice: true, hotkeys: { toggle: 'Ctrl+Alt+V', bypass: 'Ctrl+Alt+B', next: 'Ctrl+Alt+Right', prev: 'Ctrl+Alt+Left', monitor: 'Ctrl+Alt+M' }, closeToTray: true, autostart: false, startMinimized: false, quickSwitchFavoritesOnly: false }
      let onSettings = () => {}
      const noSubscription = () => () => {}
      window.vocalis = {
        engineInfo: async () => ({ state: 'ready', port, token: 'fixture', log: [], dev: true }),
        getSettings: async () => settings,
        onSettings: cb => { onSettings = cb; return () => {} },
        onEngineState: noSubscription, onHotkey: noSubscription,
        onEngineLog: noSubscription,
        appInfo: async () => ({ version: 'test', dataRoot: 'D:\\ai-vocechanger', engineDir: 'D:\\ai-vocechanger\\engine' }),
        setSettings: async patch => { Object.assign(settings, patch); onSettings({ ...settings }); return { settings, hotkeyErrors: {} } },
        suspendHotkeys: async () => ({}),
        openFile: async () => null, openPath: async () => '', openExternal: async () => {},
        rememberVoice: async id => {
          settings.recent = [id, ...settings.recent.filter(x => x !== id)]
          onSettings({ ...settings })
        },
      }
      const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
      for (let i = 0; i < 2; i++) localStorage.setItem(`vocalis.avatar.v3.Fixture_${i}`, avatar)
      window.WebSocket = class {
        constructor() {
          setTimeout(() => this.onopen?.(), 0)
          this.timer = setInterval(() => {
            window.__ticks++
            this.onmessage?.({ data: JSON.stringify(window.__fixture) })
          }, 25)
        }
        close() { clearInterval(this.timer) }
      }
    }, { fixture, port })
    await page.route(`http://127.0.0.1:${port}/**`, async route => {
      const req = route.request()
      const pathname = new URL(req.url()).pathname
      let result
      if (pathname === '/devices' && req.method() === 'GET') result = devices
      else if (pathname === '/preview/input' && req.method() === 'GET') result = { ready: false }
      else if (pathname === '/system') result = { hardware: { cpu: 'Test CPU', cores: 6, threads: 12, ramGb: 16, cuda: true, gpu: 'Test GPU', vramGb: 8, torch: 'test', cudaVersion: 'test' }, storage: { dataDir: 'D:\\ai-vocechanger', voicesBytes: 1000, baseBytes: 2000 }, presets: {} }
      else if (pathname === '/sources') result = { checkedAt: '2026-11-02', summary: 'Fixtures', sources: [{ id: 'test', name: 'Test source', url: 'https://example.com', kind: 'Test', notes: 'Source fixture', httpStatus: 200 }] }
      else if (pathname === '/preview') result = { hasRecording: false, files: [] }
      else if (req.method() === 'POST') {
        const body = req.postDataJSON()
        calls.push({ pathname, body })
        if (pathname === '/devices' && failMonitorChange) {
          await route.fulfill({ status: 400, json: { detail: 'Наушники отключены' } })
          return
        }
        await page.evaluate(({ pathname, body }) => {
          const e = window.__fixture.engine
          if (pathname === '/engine/voice') e.voiceId = body.id
          if (pathname === '/engine/params') Object.assign(e.params, body)
          if (pathname === '/devices') Object.assign(e.devices, body)
          if (pathname === '/engine/preset') e.preset = body.name
          if (pathname === '/engine/compute') e.compute = body.device
        }, { pathname, body })
        result = await page.evaluate(() => window.__fixture.engine)
      } else { await route.continue(); return }
      await route.fulfill({ json: result })
    })
    await page.goto(`http://127.0.0.1:${port}`)
    const sidebar = page.locator('aside').first()
    const rows = sidebar.getByRole('button', { name: 'Соник', exact: true })
    await rows.last().waitFor()
    await rows.last().locator('img').waitFor()
    await rows.last().evaluate(el => {
      window.__recentButton = el
      window.__recentImage = el.querySelector('img')
      window.__startTick = window.__ticks
    })
    await page.waitForFunction(() => window.__ticks - window.__startTick >= 40)
    assert(await rows.last().evaluate(el => el === window.__recentButton && el.querySelector('img') === window.__recentImage), 'recent button and image must survive status updates')
    const position = await rows.last().boundingBox()
    await page.mouse.move(position.x + 50, position.y + 10)
    await page.mouse.down()
    await page.waitForFunction(() => window.__ticks - window.__startTick >= 48)
    await page.mouse.up()
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'voice-1')
    assert.equal(calls.filter(c => c.pathname === '/engine/voice').length, 1)
    console.log('PASS: recent avatar/button stay mounted during 40 status updates; held click selects once')
    // The same component is used for Favorites.
    await sidebar.getByRole('button', { name: 'Рик Санчез', exact: true }).click()
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'voice-0')
    await rows.first().focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'voice-1')
    console.log('PASS: favorites can select a voice using the keyboard')

    const monitor = page.getByRole('region', { name: 'Прослушивание голоса' })
    const toggle = monitor.getByRole('switch', { name: 'Слышать себя' })
    await toggle.click()
    await page.waitForFunction(() => window.__fixture.engine.params.monitor)
    await page.waitForFunction(() => document.querySelector('[aria-label="Прослушивание голоса"] [role="switch"]')?.getAttribute('aria-checked') === 'true')
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await monitor.getByRole('combobox').click()
    assert.equal(await page.getByRole('option', { name: 'CABLE Input' }).count(), 0)
    await page.getByRole('option', { name: 'Другие наушники', exact: true }).click()
    await page.waitForFunction(() => window.__fixture.engine.devices.monitor === 2)
    await monitor.getByRole('slider').focus()
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => window.__fixture.engine.params.monitor_gain > 0.8)
    failMonitorChange = true
    await monitor.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Наушники USB', exact: true }).click()
    await page.getByText('Наушники отключены', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__fixture.engine.devices.monitor), 2)
    assert.equal(await page.evaluate(() => window.__fixture.engine.state), 'running')
    await toggle.click()
    await page.waitForFunction(() => !window.__fixture.engine.params.monitor)
    await page.waitForFunction(() => document.querySelector('[aria-label="Прослушивание голоса"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
    assert.equal(calls.filter(c => ['/engine/start', '/engine/stop'].includes(c.pathname)).length, 0)
    assert.deepEqual(errors, [])
    console.log('PASS: live monitor on/off, headphones, volume, error feedback, no conversion restart')
    await fs.mkdir(path.join(__dirname, 'out'), { recursive: true })
    await page.screenshot({ path: path.join(__dirname, 'out/home.png') })
    await sidebar.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.getByRole('tab', { name: 'Производительность', exact: true }).click()
    const presetGroup = page.getByRole('radiogroup', { name: 'Режим качества' })
    await presetGroup.waitFor()
    for (const width of [1040, 1280, 1600]) {
      await page.setViewportSize({ width, height: 800 })
      const bounds = await presetGroup.getByRole('radio').evaluateAll(items => items.map(el => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, width: r.width }
      }))
      assert.equal(bounds.length, 3)
      for (const item of bounds) {
        assert(Math.abs(item.top - bounds[0].top) < 1)
        assert(Math.abs(item.bottom - bounds[0].bottom) < 1)
        assert(Math.abs(item.width - bounds[0].width) < 1)
      }
    }
    await presetGroup.getByRole('radio', { name: /Качество/ }).click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Режим качества"] [data-state="on"]')?.textContent.includes('Качество'))
    console.log('PASS: preset cards have equal bounds at 1040, 1280 and 1600px and selection works')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
