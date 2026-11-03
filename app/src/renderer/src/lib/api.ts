import type { CatalogEntry, CatalogInstallSelection, CatalogJob, CatalogProvider, CatalogSearchResult, DeviceList, EngineParams, EngineStatus, JobInfo, Preset, Voice } from './types'

let base = ''
let token = ''

export function configureApi(port: number, tok: string) {
  base = `http://127.0.0.1:${port}`
  token = tok
}

export function wsUrl() {
  return `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`
}

export function mediaUrl(path: string) {
  return `${base}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}&t=${Date.now()}`
}

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  let r: Response
  try {
    r = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'X-Vocalis-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new ApiError('Движок долго не отвечает. Повторите действие')
    throw new ApiError('Аудиодвижок недоступен')
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : `Ошибка ${r.status}`)
  return data as T
}

export const api = {
  catalogProviders: () => req<{ providers: CatalogProvider[] }>('GET', '/catalog/providers'),
  catalogSearch: (q: string, provider: string, category: string, sort: 'name' | 'downloads') => req<CatalogSearchResult>('GET', `/catalog/search?${new URLSearchParams({ q, provider, category, sort })}`, undefined, 60000),
  catalogDetail: (provider: string, id: string) => req<CatalogEntry>('GET', `/catalog/models/${encodeURIComponent(provider)}/${id.split('/').map(encodeURIComponent).join('/')}`),
  catalogInstall: (provider: string, id: string, selection?: CatalogInstallSelection) => req<{ voiceId: string; job: JobInfo }>('POST', '/catalog/install', { provider, id, ...(selection ? { selection } : {}) }),
  catalogJobs: () => req<{ jobs: CatalogJob[] }>('GET', '/catalog/jobs'),
  catalogCancel: (voiceId: string) => req('POST', `/catalog/jobs/${encodeURIComponent(voiceId)}/cancel`),
  devices: (refresh = false) => req<DeviceList>('GET', `/devices${refresh ? '?refresh=true' : ''}`),
  setDevices: (d: { input?: number; output?: number; monitor?: number }) => req<EngineStatus>('POST', '/devices', d),
  testOutput: (id: number) => req('POST', '/devices/test-output', { id }),
  testInput: (id: number) => req<{ rmsDb: number; peakDb: number }>('POST', '/devices/test-input', { id }),
  sources: () => req<SourceRegistry>('GET', '/sources'),
  voices: () => req<Voice[]>('GET', '/voices'),
  download: (id: string) => req('POST', `/voices/${id}/download`),
  cancel: (id: string) => req('POST', `/voices/${id}/cancel`),
  verify: (id: string) => req<{ ok: boolean; problems: string[] }>('POST', `/voices/${id}/verify`),
  remove: (id: string) => req('DELETE', `/voices/${id}`),
  importVoice: (b: { name: string; pth: string; index?: string | null; category: string; description?: string }) =>
    req<{ id: string }>('POST', '/voices/import', b),
  downloadBase: () => req('POST', '/base-assets/download'),
  start: () => req<EngineStatus>('POST', '/engine/start'),
  stop: () => req<EngineStatus>('POST', '/engine/stop'),
  selectVoice: (id: string) => req<EngineStatus>('POST', '/engine/voice', { id }),
  resetVoiceProfile: (id: string) => req<EngineStatus>('POST', '/engine/voice/reset', { id }),
  voiceParams: (voiceId: string, p: Partial<EngineParams>) => req<EngineStatus>('POST', '/engine/params', { ...p, voiceId }),
  params: (p: Partial<EngineParams>) => req<EngineStatus>('POST', '/engine/params', p),
  preset: (name: Preset) => req<EngineStatus>('POST', '/engine/preset', { name }),
  compute: (device: 'auto' | 'cpu') => req<EngineStatus>('POST', '/engine/compute', { device }),
  system: () => req<SystemInfo>('GET', '/system'),
  previewConvert: (voiceId: string) => req<{ url: string; seconds: number; text: string; source: 'windows-sapi' }>('POST', '/preview/convert', { voiceId }, 180000),
}

export interface SystemInfo {
  hardware: {
    cpu: string | null
    cores: number
    threads: number
    ramGb: number
    torch?: string
    cuda?: boolean
    cudaVersion?: string
    gpu?: string
    vramGb?: number
  }
  storage: { dataDir: string; voicesBytes: number; baseBytes: number }
  presets: Record<string, { block_frame: number; crossfade: number; extra: number; f0_method: string }>
}

export interface SourceRegistry {
  checkedAt: string
  summary: string
  sources: { id: string; name: string; url: string; kind: string; notes: string; httpStatus: number | null }[]
}
