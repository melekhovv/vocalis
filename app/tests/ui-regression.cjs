// Run after npm run build. Requires Playwright, optionally via PLAYWRIGHT_MODULE.
// BROWSER_EXECUTABLE may point to an existing Chrome/Chromium executable.
// All engine, bridge and avatar data are fixtures; no microphone is opened.
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const voices = ['Тестовый голос 1', 'Тестовый голос 2'].map((name, i) => ({
  id: `voice-${i}`, name, nameRu: name, wikipedia: `Fixture_${i}`, franchise: 'Test',
  category: 'cartoon', accent: '#a78bfa', suggestedPitch: i, status: 'ready',
  description: 'Тестовый голос для проверки интерфейса', language: 'ru-RU', custom: false, compatible: true, diskSize: 1000, downloadSize: 1000,
  checkpoint: { version: 'v2', sampleRate: 40000, f0: true, vocoder: 'HiFi-GAN' },
  model: { title: name, format: 'RVC v2', upstream: '', license: '' },
}))
const fixture = {
  engine: {
    state: 'running', voiceId: 'voice-0', preset: 'balanced', voiceProfile: {saved: false, hasIndex: true},
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
    let failVoiceReset = false
    let catalogOffline = false
    let catalogFail = false
    let catalogSourceError = false
    let catalogDetailFail = false
    let catalogJobs = []
    let catalogVariants = []
    const catalogEntries = [
      { id: 'catalog-safe', provider: 'approved', voiceId: 'catalog-safe', name: 'Тест каталога', description: 'Синтетическая запись метаданных для проверки UI, без реальных весов.', category: 'game', language: 'ru', languageConfidence: 'declared', author: 'Fixture author', sourceUrl: 'https://example.com/synthetic-model', license: 'MIT', rights: { approved: false, reason: 'Лицензия указана источником; происхождение голоса не проверялось', evidenceUrl: 'https://example.com/synthetic-evidence', verifiedAt: '2026-11-03' }, compatibility: 'rvc-v2', size: 100, downloads: 20, installed: false, job: null, canInstall: true },
      { id: 'fixture/metadata', provider: 'huggingface', voiceId: 'hf-' + '0'.repeat(40), name: 'Метаданные источника', description: 'Файлы RVC с неуказанной лицензией', category: 'bloggers', language: null, author: 'fixture', sourceUrl: 'https://huggingface.co/fixture/metadata', license: '', rights: { approved: false, reason: 'Лицензия не указана источником. Права на голос не проверены.' }, compatibility: 'unverified', size: null, downloads: 100, installed: false, job: null, canInstall: false },
    ]
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(({ fixture, port }) => {
      window.__fixture = fixture
      window.__profileDefaults = { pitch: 0, index_rate: 0.5, protect: 0.33, f0_method: 'rmvpe', clarity_mode: false, volume_envelope: 1 }
      window.__profiles = {}
      window.__ticks = 0
      window.__cableInfo = { stage: 'installed', detail: 'Драйвер обнаружен', devices: ['CABLE Input', 'CABLE Output'] }
      window.__cableCalls = { check: 0, setup: 0, cancel: 0 }
      const cableListeners = new Set()
      window.__emitCable = info => { window.__cableInfo = info; for (const cb of cableListeners) cb(info) }
      const settings = { recent: ['voice-0', 'voice-1'], favorites: ['voice-1'], acceptedNotice: true, hotkeys: { toggle: 'Ctrl+Alt+V', bypass: 'Ctrl+Alt+B', next: 'Ctrl+Alt+Right', prev: 'Ctrl+Alt+Left', monitor: 'Ctrl+Alt+M' }, closeToTray: true, autostart: false, startMinimized: false, quickSwitchFavoritesOnly: false }
      Object.assign(settings, JSON.parse(localStorage.getItem('vocalis-test-settings') || '{}'))
      let onSettings = () => {}
      const noSubscription = () => () => {}
      window.vocalis = {
        engineInfo: async () => ({ state: 'ready', port, token: 'fixture', log: [], dev: true }),
        getSettings: async () => settings,
        onSettings: cb => { onSettings = cb; return () => {} },
        onEngineState: cb => { window.__setEngineInfo = cb; return () => {} }, onHotkey: noSubscription,
        cableStatus: async () => { window.__cableCalls.check++; return window.__cableInfo },
        onCableSetup: cb => { cableListeners.add(cb); return () => cableListeners.delete(cb) },
        setupCable: async () => { window.__cableCalls.setup++; const info = { stage: 'downloading', detail: 'Загрузка официального архива', downloaded: 25, total: 100 }; window.__emitCable(info); return info },
        cancelCableSetup: async () => { window.__cableCalls.cancel++; window.__emitCable({ stage: 'cancelled', detail: 'Загрузка отменена' }) },
        onEngineLog: noSubscription,
        appInfo: async () => ({ version: 'test', dataRoot: 'D:\\ai-vocechanger', engineDir: 'D:\\ai-vocechanger\\engine' }),
        setSettings: async patch => { Object.assign(settings, patch); localStorage.setItem('vocalis-test-settings', JSON.stringify(settings)); onSettings({ ...settings }); return { settings, hotkeyErrors: {} } },
        suspendHotkeys: async () => ({}),
        openFile: async () => null, openPath: async () => '', openExternal: async url => { (window.__externalLinks ||= []).push(url) },
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
      if (pathname === '/catalog/providers') result = { providers: [{ id: 'approved', name: 'Подборка голосов', available: true, description: 'Модели в общей подборке; сведения об условиях указаны источниками' }, { id: 'huggingface', name: 'Hugging Face', available: true, description: 'Публичные метаданные' }] }
      else if (pathname === '/catalog/search') {
        if (catalogFail) { await route.fulfill({ status: 503, json: { detail: 'Источник временно недоступен' } }); return }
        const params = new URL(req.url()).searchParams
        const items = catalogEntries.filter(entry => (params.get('provider') === 'all' || params.get('provider') === entry.provider) && (params.get('category') === 'all' || params.get('category') === entry.category) && (!params.get('q') || (entry.name + entry.description + entry.id).toLowerCase().includes(params.get('q').toLowerCase())))
        result = { items, cached: catalogOffline, providers: [{ id: 'huggingface', state: catalogSourceError ? 'error' : catalogOffline ? 'cache' : 'online', message: catalogSourceError ? 'Подождите секунду и повторите запрос' : catalogOffline ? 'Нет сети: сохранённая копия' : 'Доступен', checkedAt: 1793690000 }] }
      }
      else if (pathname.startsWith('/catalog/models/')) {
        if (catalogDetailFail) { await route.fulfill({ status: 503, json: { detail: 'Карточка временно недоступна' } }); return }
        const entry = catalogEntries.find(entry => pathname === '/catalog/models/' + entry.provider + '/' + entry.id)
        result = entry?.provider === 'huggingface' ? { ...entry, revision: 'a'.repeat(40), canInstall: true, requiresSelection: true, installedVariants: catalogVariants, files: [{path:'voice-a.pth',kind:'pth',size:100,sha256:'0'.repeat(64)},{path:'voice-b.pth',kind:'pth',size:100,sha256:'1'.repeat(64)},{path:'voice-a.index',kind:'index',size:10,sha256:'2'.repeat(64)},{path:'voices.zip',kind:'archive',size:110,sha256:'3'.repeat(64)}] } : entry
      }
      else if (pathname === '/catalog/jobs') result = { jobs: catalogJobs }
      else if (pathname === '/catalog/install') {
        const body = req.postDataJSON()
        calls.push({ pathname, body })
        const entry = catalogEntries.find(item => item.provider === body.provider && item.id === body.id)
        if (!entry || (!entry.canInstall && entry.provider !== 'huggingface')) { await route.fulfill({ status: 400, json: { detail: 'Файлы модели недоступны' } }); return }
        const job = { voiceId: entry.provider === 'huggingface' ? 'hf-' + (body.selection?.pth === 'voice-b.pth' ? 'e' : body.selection?.archive ? 'd' : 'f').repeat(40) : entry.voiceId, provider: entry.provider, id: entry.id, stage: 'downloading', done: 25, total: 100, progress: 0.25, error: null }
        catalogJobs = [...catalogJobs.filter(item => item.voiceId !== job.voiceId), job]
        result = { voiceId: job.voiceId, job }
      }
      else if (pathname.startsWith('/catalog/jobs/') && pathname.endsWith('/cancel')) {
        calls.push({ pathname })
        const voiceId = decodeURIComponent(pathname.split('/')[3])
        catalogJobs = catalogJobs.map(job => job.voiceId === voiceId ? ({ ...job, stage: 'cancelled' }) : job)
        result = { ok: true }
      }
      else if (pathname === '/voices' && req.method() === 'GET') result = await page.evaluate(() => window.__fixture.voices)
      else if (pathname === '/devices' && req.method() === 'GET') result = devices
      else if (pathname === '/preview/input' && req.method() === 'GET') result = { ready: false }
      else if (pathname === '/system') result = { hardware: { cpu: 'Test CPU', cores: 6, threads: 12, ramGb: 16, cuda: true, gpu: 'Test GPU', vramGb: 8, torch: 'test', cudaVersion: 'test' }, storage: { dataDir: 'D:\\ai-vocechanger', voicesBytes: 1000, baseBytes: 2000 }, presets: {} }
      else if (pathname === '/sources') result = { checkedAt: '2026-11-02', summary: 'Fixtures', sources: [{ id: 'test', name: 'Test source', url: 'https://example.com', kind: 'Test', notes: 'Source fixture', httpStatus: 200 }] }
      else if (pathname === '/preview') result = { hasRecording: false, files: [] }
      else if (req.method() === 'POST') {
        const body = req.postDataJSON()
        calls.push({ pathname, body })
        if (pathname === '/engine/voice/reset' && failVoiceReset) {
          await route.fulfill({ status: 409, json: { detail: 'Выбран другой голос. Повторите действие.' } })
          return
        }
        if (pathname === '/devices' && failMonitorChange) {
          await route.fulfill({ status: 400, json: { detail: 'Наушники отключены' } })
          return
        }
        await page.evaluate(({ pathname, body }) => {
          const e = window.__fixture.engine
          if (pathname === '/engine/voice') {
            e.voiceId = body.id
            Object.assign(e.params, window.__profileDefaults, window.__profiles[body.id] || {})
            e.voiceProfile = { saved: !!window.__profiles[body.id], hasIndex: body.id === 'voice-0' }
          }
          if (pathname === '/engine/params') {
            const { voiceId, ...patch } = body
            Object.assign(e.params, patch)
            if (Object.keys(patch).some(key => key in window.__profileDefaults)) {
              window.__profiles[e.voiceId] = Object.fromEntries(Object.keys(window.__profileDefaults).map(key => [key, e.params[key]]))
              e.voiceProfile.saved = true
            }
          }
          if (pathname === '/engine/voice/reset') {
            delete window.__profiles[body.id]
            Object.assign(e.params, window.__profileDefaults)
            e.voiceProfile.saved = false
          }
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
    const rows = sidebar.getByRole('button', { name: 'Тестовый голос 2', exact: true })
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
    await sidebar.getByRole('button', { name: 'Тестовый голос 1', exact: true }).click()
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'voice-0')
    await rows.first().focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'voice-1')
    console.log('PASS: favorites can select a voice using the keyboard')

    const voiceControls = page.getByRole('region', { name: 'Настройки этого голоса', exact: true })
    const voicePitch = voiceControls.getByRole('slider', { name: 'Тональность', exact: true })
    const voiceIndex = voiceControls.getByRole('slider', { name: 'Index rate', exact: true })
    const voiceProtect = voiceControls.getByRole('slider', { name: 'Защита согласных (protect)', exact: true })
    const voiceReset = voiceControls.getByRole('button', { name: 'Сбросить настройки голоса', exact: true })
    await voiceControls.getByText('Базовые настройки модели', { exact: true }).waitFor()
    await voiceControls.getByText('Файл .index не подключён.', { exact: false }).waitFor()
    assert.equal(await voiceIndex.isDisabled(), true)
    assert.equal(await voiceReset.isDisabled(), true)
    await voicePitch.focus()
    await page.keyboard.press('ArrowRight')
    await voiceControls.getByText('Мои настройки · сохранены', { exact: true }).waitFor()
    assert.equal(calls.filter(c => c.pathname === '/engine/params').at(-1).body.voiceId, 'voice-1')
    assert.equal(await voicePitch.getAttribute('aria-valuenow'), '1')
    await sidebar.getByRole('button', { name: 'Тестовый голос 1', exact: true }).click()
    await voiceControls.getByText('Базовые настройки модели', { exact: true }).waitFor()
    assert.equal(await voiceIndex.isEnabled(), true)
    await sidebar.getByRole('button', { name: 'Тестовый голос 2', exact: true }).first().click()
    await voiceControls.getByText('Мои настройки · сохранены', { exact: true }).waitFor()
    assert.equal(await voicePitch.getAttribute('aria-valuenow'), '1')
    // A pointer gesture belongs to its original voice even when a hotkey changes selection.
    await voicePitch.scrollIntoViewIfNeeded()
    await voicePitch.evaluate(el => { window.__oldPitchThumb = el })
    const pitchBounds = await voicePitch.boundingBox()
    const profileCallsBeforeDrag = calls.filter(c => c.pathname === '/engine/params').length
    await page.mouse.move(pitchBounds.x + pitchBounds.width / 2, pitchBounds.y + pitchBounds.height / 2)
    await page.mouse.down()
    await page.evaluate(() => {
      const e = window.__fixture.engine
      e.voiceId = 'voice-0'
      Object.assign(e.params, window.__profileDefaults)
      e.voiceProfile = { saved: false, hasIndex: true }
    })
    await page.waitForFunction(() => window.__oldPitchThumb && !window.__oldPitchThumb.isConnected)
    await page.mouse.up()
    assert.equal(calls.filter(c => c.pathname === '/engine/params').length, profileCallsBeforeDrag)
    await sidebar.getByRole('button', { name: 'Тестовый голос 2', exact: true }).first().click()
    await voiceControls.getByText('Мои настройки · сохранены', { exact: true }).waitFor()
    assert.equal(await voicePitch.getAttribute('aria-valuenow'), '1')
    failVoiceReset = true
    await voiceReset.click()
    await page.getByText('Не удалось сбросить настройки голоса', { exact: true }).waitFor()
    assert.equal(await voicePitch.getAttribute('aria-valuenow'), '1')
    failVoiceReset = false
    await voiceReset.click()
    await voiceControls.getByText('Базовые настройки модели', { exact: true }).waitFor()
    assert.equal(await voicePitch.getAttribute('aria-valuenow'), '0')
    assert.equal(calls.filter(c => c.pathname === '/engine/voice/reset').at(-1).body.id, 'voice-1')
    const clarity = voiceControls.getByRole('switch', { name: 'Чёткая речь', exact: true })
    await clarity.click()
    await voiceControls.getByText('«Чёткая речь» управляет', { exact: false }).waitFor()
    assert.equal(await voiceProtect.isDisabled(), true)
    await clarity.click()
    await page.waitForFunction(() => !window.__fixture.engine.params.clarity_mode)
    await page.evaluate(() => { window.__fixture.engine.voiceProfile.applicability = { pitch: false, f0: false, index: false, protect: false } })
    await voiceControls.getByText('Модель без F0 не использует тональность и защиту согласных.', { exact: true }).waitFor()
    assert.equal(await voicePitch.isDisabled(), true)
    assert.equal(await voiceProtect.isDisabled(), true)
    await page.evaluate(() => { delete window.__fixture.engine.voiceProfile.applicability })
    await page.evaluate(() => { window.__fixture.engine.state = 'loading' })
    await page.waitForFunction(() => document.querySelector('[aria-label="Настройки этого голоса"] [aria-label="Тональность"]')?.hasAttribute('data-disabled'))
    assert.equal(await voicePitch.isDisabled(), true)
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Настройки этого голоса"] button')].find(el => el.textContent.includes('Сбросить настройки голоса'))?.disabled)
    assert.equal(await voiceReset.isDisabled(), true)
    await page.evaluate(() => { window.__fixture.engine.state = 'running'; window.__fixture.engine.stats.realtimeFactor = 1.2 })
    await voiceControls.getByText('Обработка не успевает:', { exact: false }).waitFor()
    await page.setViewportSize({ width: 1040, height: 600 })
    await voiceReset.scrollIntoViewIfNeeded()
    await fs.mkdir(path.join(__dirname, 'out'), { recursive: true })
    await page.screenshot({ path: path.join(__dirname, 'out/voice-profile.png') })
    await page.evaluate(() => { window.__fixture.engine.stats.realtimeFactor = 0.3 })
    await page.setViewportSize({ width: 1280, height: 900 })
    console.log('PASS: per-voice autosave/scoped request, profile switching/reset/error, optional index, clarity, loading lock and overload guidance')

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
    // Warnings remain visible outside the home page, without a toast per status tick.
    await page.evaluate(() => {
      window.__fixture.engine.devices.output = 0
      window.__fixture.engine.stats.realtimeFactor = 1.2
    })
    const cableWarning = page.locator('[data-sonner-toast]').filter({ hasText: 'Для передачи голоса в Discord и игры нужен виртуальный кабель' })
    const slowWarning = page.locator('[data-sonner-toast]').filter({ hasText: 'Нейросеть не успевает обрабатывать голос' })
    await cableWarning.waitFor()
    await slowWarning.waitFor()
    assert.equal(await cableWarning.count(), 1)
    assert.equal(await slowWarning.count(), 1)
    await page.evaluate(() => { window.__warningTick = window.__ticks })
    await page.waitForFunction(() => window.__ticks - window.__warningTick >= 40)
    assert.equal(await slowWarning.count(), 1)
    await slowWarning.getByRole('button', { name: 'Настройки', exact: true }).click()
    await presetGroup.waitFor()
    await page.evaluate(() => { window.__fixture.engine.state = 'stopped' })
    await slowWarning.waitFor({ state: 'hidden' })
    await cableWarning.waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    console.log('PASS: cable and sustained overload warnings work across pages, deduplicate, and clear after stop')
    // Driver discovery must work without Python and never trigger a download itself.
    await page.evaluate(({ port }) => window.__setEngineInfo({ state: 'needs-setup', port, token: 'fixture', log: [], dev: true }), { port })
    const cableSetup = page.getByRole('region', { name: 'Установка виртуального кабеля', exact: true })
    const cableDownload = cableSetup.getByRole('button', { name: 'Скачать и запустить установщик', exact: true })
    await cableSetup.getByText('Виртуальный кабель уже установлен', { exact: true }).waitFor()
    assert.equal(await cableDownload.count(), 0)
    assert.equal(await cableSetup.getByRole('checkbox').count(), 0)
    assert.equal(await page.evaluate(() => window.__cableCalls.setup), 0)
    await page.evaluate(() => { window.__cableInfo = { stage: 'error', detail: 'Проверка недоступна', error: 'Windows audio discovery failed' } })
    await cableSetup.getByRole('button', { name: 'Проверить кабель снова', exact: true }).click()
    await cableSetup.getByRole('alert').waitFor()
    assert.equal(await cableDownload.count(), 0)
    await page.evaluate(() => { window.__cableInfo = { stage: 'available', detail: 'Драйвер не найден' } })
    await cableSetup.getByRole('button', { name: 'Повторить проверку', exact: true }).click()
    await cableDownload.waitFor()
    const consent = cableSetup.getByRole('checkbox', { name: 'Хочу установить VB-CABLE для Discord и игр' })
    assert.equal(await consent.isChecked(), false)
    assert.equal(await cableDownload.isDisabled(), true)
    assert.equal(await page.evaluate(() => window.__cableCalls.setup), 0)
    await cableSetup.getByText('Для локального прослушивания', { exact: false }).waitFor()
    await page.setViewportSize({ width: 1040, height: 600 })
    await consent.focus()
    await page.keyboard.press('Space')
    assert.equal(await consent.isChecked(), true)
    assert.equal(await cableDownload.isEnabled(), true)
    await fs.mkdir(path.join(__dirname, 'out'), { recursive: true })
    await page.screenshot({ path: path.join(__dirname, 'out/cable-opt-in.png') })
    await cableDownload.click()
    const cableProgress = cableSetup.getByRole('progressbar', { name: 'Загрузка и подготовка VB-CABLE', exact: true })
    await cableProgress.waitFor()
    assert.equal(await cableProgress.getAttribute('value'), '25')
    assert.equal(await cableProgress.getAttribute('max'), '100')
    assert.equal(await page.evaluate(() => window.__cableCalls.setup), 1)
    await cableSetup.getByRole('button', { name: 'Отменить загрузку кабеля', exact: true }).click()
    await cableSetup.getByText('Загрузка VB-CABLE отменена', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.__cableCalls.cancel), 1)
    assert.equal(await cableDownload.count(), 0)
    await page.evaluate(() => window.__emitCable({ stage: 'error', detail: 'Архив не прошёл проверку', error: 'Integrity check failed' }))
    await cableSetup.getByRole('button', { name: 'Повторить проверку', exact: true }).waitFor()
    assert.equal(await cableDownload.count(), 0)
    await page.evaluate(() => { window.__cableInfo = { stage: 'available', detail: 'Драйвер не найден' } })
    await cableSetup.getByRole('button', { name: 'Повторить проверку', exact: true }).click()
    assert.equal(await consent.isChecked(), false)
    assert.equal(await cableDownload.isDisabled(), true)
    await page.evaluate(() => window.__emitCable({ stage: 'awaiting-restart', detail: 'Windows installer started' }))
    await cableSetup.getByText('Установщик запущен — завершите установку', { exact: true }).waitFor()
    assert.equal(await cableDownload.count(), 0)
    await page.evaluate(({ port }) => window.__setEngineInfo({ state: 'ready', port, token: 'fixture', log: [], dev: true }), { port })
    await page.getByRole('tab', { name: 'Виртуальный микрофон', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[role="tab"][data-state="active"]')?.textContent === 'Виртуальный микрофон')
    await cableSetup.getByText('Установщик запущен — завершите установку', { exact: true }).waitFor()
    await cableSetup.getByText('Запуск установщика ещё не означает', { exact: false }).waitFor()
    await page.evaluate(() => window.__emitCable({ stage: 'installed', detail: 'Драйвер обнаружен', devices: ['CABLE Input'] }))
    await cableSetup.getByText('Виртуальный кабель уже установлен', { exact: true }).waitFor()
    assert.equal(await cableDownload.count(), 0)
    await page.getByRole('tab', { name: 'Виртуальный микрофон', exact: true }).click()
    await cableSetup.getByText('Виртуальный кабель уже установлен', { exact: true }).waitFor()
    assert.equal(await cableDownload.count(), 0)
    await cableSetup.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(__dirname, 'out/cable-installed.png') })
    assert.deepEqual(errors, [])
    console.log('PASS: cable discovery without engine, installed hides download in setup/settings, errors retry, explicit keyboard opt-in, real byte progress, cancel, installer/reboot guidance stays visible after engine ready')
    // Catalog uses synthetic metadata and fake jobs; no model weights/network source are touched.
    await sidebar.getByRole('button', { name: 'Каталог голосов', exact: true }).click()
    const catalog = page.getByRole('heading', { name: 'Каталог голосов', exact: true })
    await catalog.waitFor()
    const approvedCard = page.getByRole('article', { name: 'Тест каталога', exact: true })
    const metadataCard = page.getByRole('article', { name: 'Метаданные источника', exact: true })
    await approvedCard.waitFor()
    await metadataCard.waitFor()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.screenshot({ path: path.join(__dirname, 'out/catalog.png') })
    assert.equal(await metadataCard.getByRole('button', { name: 'Проверить файлы', exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole('heading', { name: 'Каталог голосов', exact: true }).count(), 1)
    assert.equal(await page.getByRole('combobox', { name: 'Источник каталога', exact: true }).textContent(), 'Все источники')
    assert.equal(await page.locator('article').first().getAttribute('aria-label'), 'Тест каталога')
    assert.equal(calls.filter(call => call.pathname === '/catalog/install').length, 0)
    await metadataCard.getByText('Лицензия источника: не указана', { exact: true }).waitFor()
    await metadataCard.getByRole('button', { name: 'Подробнее', exact: true }).click()
    const catalogDialog = page.getByRole('dialog')
    await catalogDialog.getByText('Сведения об условиях использования', { exact: true }).waitFor()
    assert.equal(await catalogDialog.getByText('Права проверены', { exact: true }).count(), 0)
    assert.equal(await catalogDialog.getByRole('checkbox').count(), 0)
    await catalogDialog.getByRole('region', { name: 'Файлы модели', exact: true }).waitFor()
    await catalogDialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)) })
    await page.screenshot({ path: path.join(__dirname, 'out/catalog-detail.png') })
    await catalogDialog.getByRole('button', { name: 'Открыть источник модели', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__externalLinks.at(-1)), 'https://huggingface.co/fixture/metadata')
    const unknownDownload = catalogDialog.getByRole('button', { name: 'Скачать и установить', exact: true })
    assert.equal(await unknownDownload.isDisabled(), true)
    await catalogDialog.getByRole('combobox', { name: 'Файл модели .pth', exact: true }).click()
    await page.getByRole('option', { name: 'voice-a.pth · 100 Б', exact: true }).click()
    await catalogDialog.getByRole('combobox', { name: 'Необязательный индекс модели', exact: true }).click()
    await page.getByRole('option', { name: 'voice-a.index · 10 Б', exact: true }).click()
    await unknownDownload.click()
    const variantJobs = catalogDialog.getByRole('region', { name: 'Загрузки вариантов', exact: true })
    await variantJobs.getByRole('progressbar').waitFor()
    const remoteInstall = calls.filter(call => call.pathname === '/catalog/install').at(-1)
    assert.deepEqual(remoteInstall.body, { provider: 'huggingface', id: 'fixture/metadata', selection: { pth: 'voice-a.pth', index: 'voice-a.index' } })
    await catalogDialog.getByRole('combobox', { name: 'Файл модели .pth', exact: true }).click()
    await page.getByRole('option', { name: 'voice-b.pth · 100 Б', exact: true }).click()
    await unknownDownload.click()
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Загрузки вариантов"] progress').length === 2)
    assert.equal(new Set(catalogJobs.filter(job => job.provider === 'huggingface').map(job => job.voiceId)).size, 2)
    await variantJobs.getByRole('button', { name: 'Отменить загрузку', exact: true }).first().click()
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Загрузки вариантов"] progress').length === 1)
    await variantJobs.getByRole('button', { name: 'Отменить загрузку', exact: true }).click()
    await variantJobs.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    await catalogDialog.waitFor({ state: 'hidden' })
    await approvedCard.getByRole('button', { name: 'Избранное: Тест каталога', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('vocalis.catalog.favorites.v1') || '[]').some(entry => entry.voiceId === 'catalog-safe'))
    await page.evaluate(() => {
      const cached = JSON.parse(localStorage.getItem('vocalis.catalog.favorites.v1'))
      cached[0].canInstall = true // A snapshot can never elevate download permission.
      cached[0].rights.approved = true
      cached.push({ provider: 'huggingface', id: 'invalid', voiceId: '../../invalid', name: 'Invalid cached card' })
      localStorage.setItem('vocalis.catalog.favorites.v1', JSON.stringify(cached))
    })
    catalogFail = true
    catalogDetailFail = true
    await page.reload()
    await sidebar.getByRole('button', { name: 'Каталог голосов', exact: true }).click()
    await page.getByRole('tab', { name: 'Избранное', exact: true }).click()
    await approvedCard.getByText('Сохранённые метаданные · откройте сведения для проверки доступности', { exact: true }).waitFor()
    assert.equal(await approvedCard.getByRole('button', { name: 'Скачать и установить', exact: true }).count(), 0)
    await approvedCard.getByRole('button', { name: 'Проверить файлы', exact: true }).waitFor()
    assert.equal(await page.getByRole('article', { name: 'Invalid cached card', exact: true }).count(), 0)
    await approvedCard.getByRole('button', { name: 'Подробнее', exact: true }).click()
    await catalogDialog.getByRole('alert').waitFor()
    assert.equal(await catalogDialog.getByRole('button', { name: 'Скачивание недоступно', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    catalogFail = false
    catalogDetailFail = false
    await page.getByRole('button', { name: 'Обновить каталог', exact: true }).click()
    await approvedCard.getByRole('button', { name: 'Скачать и установить', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Избранное', exact: true }).click()
    await approvedCard.waitFor()
    assert.equal(await metadataCard.count(), 0)
    await page.getByRole('tab', { name: 'Все голоса', exact: true }).click()
    await page.getByRole('combobox', { name: 'Приоритет языка', exact: true }).click()
    await page.getByRole('option', { name: 'Любой язык', exact: true }).click()
    await page.getByRole('combobox', { name: 'Сортировка каталога', exact: true }).click()
    await page.getByRole('option', { name: 'По загрузкам источника', exact: true }).click()
    await metadataCard.waitFor()
    await page.waitForFunction(() => document.querySelector('article')?.getAttribute('aria-label') === 'Метаданные источника')
    await page.getByRole('combobox', { name: 'Категория голоса', exact: true }).click()
    await page.getByRole('option', { name: 'Аниме', exact: true }).click()
    await page.getByRole('heading', { name: 'Модели не найдены', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click()
    await approvedCard.waitFor()
    const catalogSearch = page.getByRole('textbox', { name: 'Поиск голосов в каталоге', exact: true })
    await catalogSearch.fill('несуществующий результат')
    await page.getByRole('heading', { name: 'Модели не найдены', exact: true }).waitFor()
    await catalogSearch.fill('Тест каталога')
    await approvedCard.waitFor()
    assert.equal(await metadataCard.count(), 0)
    await catalogSearch.fill('')
    await metadataCard.waitFor()
    await page.getByRole('combobox', { name: 'Источник каталога', exact: true }).click()
    await page.getByRole('option', { name: 'Подборка голосов', exact: true }).click()
    await approvedCard.waitFor()
    assert.equal(await metadataCard.count(), 0)
    await page.getByRole('combobox', { name: 'Источник каталога', exact: true }).click()
    await page.getByRole('option', { name: 'Все источники', exact: true }).click()
    await metadataCard.waitFor()
    await approvedCard.getByRole('button', { name: 'Скачать и установить', exact: true }).click()
    const catalogProgress = approvedCard.getByRole('progressbar', { name: 'Установка: Тест каталога', exact: true })
    await catalogProgress.waitFor()
    assert.equal(await catalogProgress.getAttribute('value'), '25')
    assert.equal(await catalogProgress.getAttribute('max'), '100')
    await approvedCard.getByRole('button', { name: 'Отменить загрузку', exact: true }).click()
    await approvedCard.getByText('Загрузка отменена', { exact: true }).waitFor()
    await approvedCard.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
    catalogJobs = catalogJobs.map(job => ({ ...job, stage: 'error', error: 'Тестовая ошибка проверки архива' }))
    await approvedCard.getByRole('alert').waitFor()
    await approvedCard.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
    catalogJobs = catalogJobs.map(job => ({ ...job, stage: 'done', done: 100, progress: 1 }))
    await page.evaluate(() => { window.__fixture.voices.push({ ...window.__fixture.voices[0], id: 'catalog-safe', name: 'Тест каталога', nameRu: 'Тест каталога', wikipedia: null }) })
    await approvedCard.getByRole('button', { name: 'Использовать голос', exact: true }).waitFor()
    catalogDetailFail = true
    await approvedCard.getByRole('button', { name: 'Подробнее', exact: true }).click()
    await catalogDialog.getByRole('alert').waitFor()
    catalogDetailFail = false
    await catalogDialog.getByRole('button', { name: 'Повторить проверку модели', exact: true }).click()
    await catalogDialog.getByText('Сведения об условиях использования', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    catalogOffline = true
    await page.getByRole('combobox', { name: 'Сортировка каталога', exact: true }).click()
    await page.getByRole('option', { name: 'По названию', exact: true }).click()
    await page.getByText('Показаны сохранённые метаданные.', { exact: false }).waitFor()
    catalogSourceError = true
    await page.getByRole('button', { name: 'Обновить каталог', exact: true }).click()
    await page.getByText('Hugging Face · источник недоступен: Подождите секунду и повторите запрос', { exact: true }).waitFor()
    catalogSourceError = false
    await page.getByRole('button', { name: 'Обновить каталог', exact: true }).click()
    await page.getByText('Hugging Face · источник недоступен:', { exact: false }).waitFor({ state: 'hidden' })
    catalogFail = true
    await catalogSearch.fill('сбой')
    await page.getByRole('alert').filter({ hasText: 'Не удалось обновить каталог' }).waitFor()
    await page.getByRole('tab', { name: 'Мои голоса', exact: true }).click()
    const failedEmptySearch = page.waitForResponse(response => new URL(response.url()).pathname === '/catalog/search' && new URL(response.url()).searchParams.get('q') === '' && response.status() === 503)
    await catalogSearch.fill('')
    await failedEmptySearch
    await page.getByRole('alert').filter({ hasText: 'Не удалось обновить каталог' }).waitFor()
    await page.getByRole('article', { name: 'Тестовый голос 1', exact: true }).waitFor()
    assert.equal(await metadataCard.count(), 0)
    catalogFail = false
    await page.getByRole('button', { name: 'Повторить', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Не удалось обновить каталог' }).waitFor({ state: 'hidden' })
    await page.getByRole('status').filter({ hasText: /^Найдено:/ }).waitFor()
    await page.setViewportSize({ width: 1040, height: 600 })
    await page.locator('main .overflow-y-auto').evaluate(el => { el.scrollTop = 0 })
    await page.screenshot({ path: path.join(__dirname, 'out/catalog-installed.png') })
    await approvedCard.getByRole('button', { name: 'Использовать голос', exact: true }).click()
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'catalog-safe')
    await sidebar.getByRole('button', { name: 'Главная', exact: true }).waitFor()
    catalogVariants = [{voiceId:'hf-'+'f'.repeat(40),name:'Вариант A',revision:'a'.repeat(40),files:['voice-a.pth']},{voiceId:'hf-'+'e'.repeat(40),name:'Вариант B',revision:'a'.repeat(40),files:['voice-b.pth']}]
    await page.evaluate(variants => { for (const variant of variants) window.__fixture.voices.push({ ...window.__fixture.voices[0], id: variant.voiceId, name: variant.name, nameRu: variant.name, wikipedia: null }) }, catalogVariants)
    await sidebar.getByRole('button', { name: 'Каталог голосов', exact: true }).click()
    await metadataCard.getByRole('button', { name: 'Подробнее', exact: true }).click()
    await catalogDialog.getByRole('region', { name: 'Установленные варианты', exact: true }).waitFor()
    await catalogDialog.getByRole('button', { name: 'Использовать Вариант B', exact: true }).click()
    await page.waitForFunction(() => window.__fixture.engine.voiceId === 'hf-'+'e'.repeat(40))
    assert.deepEqual(errors, [])
    console.log('PASS: catalog navigation/search/source/category/sort/favorites across reload and offline sanitized snapshot, single catalog Russian-first non-CC0/unknown-license download, coexisting unique variants/file selection/use and no approval checkbox, install/progress/cancel/retry/use, offline cache/local library and keyboard dialog')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
