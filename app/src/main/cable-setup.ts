import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface CableSetupInfo {
  stage: 'checking' | 'installed' | 'available' | 'downloading' | 'extracting' | 'verifying' | 'launching' | 'awaiting-restart' | 'cancelled' | 'error'
  detail: string
  downloaded?: number
  total?: number
  error?: string
  devices?: string[]
}

// Official Pack45, inspected 2026-11-03. Pin the whole package, including driver
// payloads, rather than trusting only the signed bootstrap executable.
export const CABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
export const CABLE_SHA256 = 'b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb'
const SIGNER = 'A77952D93229D0EC36E2543081EEA7D125732B9C'
const MAX_DOWNLOAD = 8 * 1024 * 1024
const psString = (value: string) => "'" + value.replace(/'/g, "''") + "'"

export function powershell(script: string, signal?: AbortSignal, timeout = 30000): Promise<string> {
  return new Promise((accept, reject) => {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const proc = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script, 'utf16le').toString('base64')], { windowsHide: true, signal })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Проверка Windows превысила время ожидания. Повторите попытку.')) }, timeout)
    proc.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 1024 * 1024) proc.kill() })
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 8192) })
    proc.once('error', error => { clearTimeout(timer); reject(error) })
    proc.once('exit', code => { clearTimeout(timer); code === 0 ? accept(stdout.trim().replace(/^\uFEFF/, '')) : reject(new Error(stderr || `Windows: код ${code}`)) })
  })
}

export async function detectCable(run = powershell, signal?: AbortSignal): Promise<string[]> {
  const output = await run("$devices=@(Get-CimInstance Win32_PnPEntity -Filter \"PNPClass='AudioEndpoint' OR PNPClass='MEDIA'\" -ErrorAction Stop); if($devices.Count -eq 0){throw 'Windows не вернула аудиоустройства; проверьте службу Windows Audio'}; ConvertTo-Json -Compress -InputObject @($devices | Select-Object Name,Status,ConfigManagerErrorCode)", signal)
  const devices: { Name: string; Status: string; ConfigManagerErrorCode: number }[] = JSON.parse(output)
  if (!Array.isArray(devices)) throw new Error('Некорректный ответ проверки аудиоустройств Windows')
  if (devices.some(device => typeof device.Name !== 'string' || typeof device.ConfigManagerErrorCode !== 'number')) throw new Error('Неполный ответ проверки аудиоустройств Windows')
  // A disabled/broken but installed driver must not trigger a duplicate install.
  // Return it with diagnostics; the user can enable/repair it in Windows.
  return devices.filter(device => /VB-Audio Virtual Cable|\bCABLE (?:Input|Output|In \d+ch)|Virtual Audio Cable|Voicemeeter (?:Input|Output|Aux|VAIO)|VAC (?:Input|Output)|Virtual Cable/i.test(device.Name)).map(device => device.Name + (device.Status === 'OK' && device.ConfigManagerErrorCode === 0 ? '' : ` (Windows: ${device.ConfigManagerErrorCode}, ${device.Status})`))
}

export async function downloadCable(signal: AbortSignal, progress: (done: number, total?: number) => void): Promise<Buffer> {
  const response = await fetch(CABLE_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: 'error' })
  if (!response.ok || !response.body || response.url !== CABLE_URL) throw new Error(`Загрузка VB-CABLE: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || undefined
  if (total && total > MAX_DOWNLOAD) throw new Error('Архив VB-CABLE превышает допустимый размер')
  const chunks: Buffer[] = []
  let done = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    done += chunk.length
    if (done > MAX_DOWNLOAD) throw new Error('Архив VB-CABLE превышает допустимый размер')
    chunks.push(Buffer.from(chunk))
    progress(done, total)
  }
  const result = Buffer.concat(chunks)
  if (createHash('sha256').update(result).digest('hex') !== CABLE_SHA256) throw new Error('Контрольная сумма VB-CABLE не совпадает. Установка остановлена.')
  return result
}

interface Dependencies {
  detect: typeof detectCable
  download: typeof downloadCable
  run: typeof powershell
}

export class CableSetup {
  private info: CableSetupInfo = { stage: 'checking', detail: 'Проверяем виртуальный кабель в Windows…' }
  private controller?: AbortController
  private check?: Promise<CableSetupInfo>
  private awaitingRestart = false
  constructor(private tempRoot: string, private publish: (info: CableSetupInfo) => void, private deps: Dependencies = { detect: detectCable, download: downloadCable, run: powershell }) {}
  private update(info: CableSetupInfo) { this.info = info; this.publish(info); return info }
  private failure(error: unknown) { return this.update({ stage: 'error', detail: 'Не удалось настроить виртуальный кабель. Повторите проверку.', error: String((error as Error).message || error).slice(0, 2000) }) }
  status(): Promise<CableSetupInfo> {
    if (this.controller) return Promise.resolve(this.info)
    if (this.check) return this.check
    const awaitingRestart = this.awaitingRestart
    this.update({ stage: 'checking', detail: 'Проверяем виртуальный кабель в Windows…' })
    this.check = this.deps.detect().then(devices => this.update(devices.length ? { stage: 'installed', detail: 'Виртуальный кабель уже установлен. Если устройство отключено или сообщает ошибку, проверьте его в диспетчере устройств Windows.', devices } : awaitingRestart ? { stage: 'awaiting-restart', detail: 'Виртуальный кабель пока не появился. Завершите установщик VB-CABLE и перезагрузите Windows вручную.' } : { stage: 'available', detail: 'Виртуальный кабель не найден. Можно установить VB-CABLE отдельно.' })).catch(error => this.failure(error)).finally(() => { this.check = undefined })
    return this.check
  }
  cancel() {
    // Once UAC has opened, the independent vendor installer belongs to the user.
    if (this.info.stage !== 'launching' && this.info.stage !== 'awaiting-restart') this.controller?.abort()
  }
  async setup(): Promise<CableSetupInfo> {
    if (this.controller || this.info.stage === 'awaiting-restart') return this.info
    if (this.check) await this.check
    if (this.controller || this.awaitingRestart) return this.info
    const controller = new AbortController()
    this.controller = controller
    let directory: string | undefined
    let launched = false
    try {
      this.update({ stage: 'checking', detail: 'Повторно проверяем виртуальный кабель перед загрузкой…' })
      const devices = await this.deps.detect(this.deps.run, controller.signal)
      controller.signal.throwIfAborted()
      if (devices.length) return this.update({ stage: 'installed', detail: 'Виртуальный кабель уже установлен.', devices })
      this.update({ stage: 'downloading', detail: 'Загружаем официальный VB-CABLE Pack45…', downloaded: 0 })
      const data = await this.deps.download(controller.signal, (downloaded, total) => this.update({ stage: 'downloading', detail: 'Загружаем официальный VB-CABLE Pack45…', downloaded, total }))
      controller.signal.throwIfAborted()
      directory = await mkdtemp(join(this.tempRoot, 'vocalis-cable-'))
      const archive = join(directory, 'VBCABLE_Driver_Pack45.zip')
      const extracted = join(directory, 'package')
      await writeFile(archive, data, { flag: 'wx' })
      this.update({ stage: 'extracting', detail: 'Проверяем и распаковываем пакет драйвера…' })
      // Official archive is flat. Reject any nested/absolute/traversal entries,
      // symbolic links and unexpectedly large expanded payloads before extraction.
      await this.deps.run(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead(${psString(archive)}); try { if($zip.Entries.Count -gt 100){throw 'Too many archive entries'}; $size=0; foreach($entry in $zip.Entries){if($entry.FullName -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Unsafe archive entry'}; $size += $entry.Length; if($size -gt 67108864){throw 'Expanded archive too large'}} } finally {$zip.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory(${psString(archive)},${psString(extracted)})`, controller.signal)
      this.update({ stage: 'verifying', detail: 'Проверяем цифровую подпись издателя VB-Audio…' })
      const exe = join(extracted, 'VBCABLE_Setup_x64.exe')
      const verify = `$sig=Get-AuthenticodeSignature -LiteralPath ${psString(exe)}; if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Thumbprint -ne '${SIGNER}'){throw 'Недопустимая цифровая подпись установщика VB-CABLE'}`
      await this.deps.run(verify, controller.signal)
      controller.signal.throwIfAborted()
      this.update({ stage: 'launching', detail: 'Подтвердите запрос Windows UAC и установку в окне VB-CABLE.' })
      // Recheck Authenticode immediately before opening the vendor's interactive
      // setup. Never suppress UAC, install silently, or reboot the machine.
      await this.deps.run(`${verify}; Start-Process -FilePath ${psString(exe)} -WorkingDirectory ${psString(extracted)} -Verb RunAs -PassThru | Out-Null`, undefined, 180000)
      launched = true
      this.awaitingRestart = true
      return this.update({ stage: 'awaiting-restart', detail: 'Установщик VB-CABLE запущен. Завершите установку и перезагрузите Windows вручную, затем повторите проверку.' })
    } catch (error) {
      return controller.signal.aborted ? this.update({ stage: 'cancelled', detail: 'Настройка отменена. Можно повторить проверку и установку.' }) : this.failure(error)
    } finally {
      this.controller = undefined
      // Only remove a unique directory that this operation itself created.
      // Keep a launched package intact while the vendor installer is using it.
      if (directory && !launched && resolve(directory).startsWith(resolve(this.tempRoot) + sep)) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }
}
