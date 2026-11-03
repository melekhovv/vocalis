import type { DeviceList, EngineParams, EngineStatus, Preset, Voice } from './types'

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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(base + path, {
      method,
      headers: { 'X-Vocalis-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Аудиодвижок недоступен')
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : `Ошибка ${r.status}`)
  return data as T
}

export const api = {
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
  params: (p: Partial<EngineParams>) => req<EngineStatus>('POST', '/engine/params', p),
  preset: (name: Preset) => req<EngineStatus>('POST', '/engine/preset', { name }),
  compute: (device: 'auto' | 'cpu') => req<EngineStatus>('POST', '/engine/compute', { device }),
  system: () => req<SystemInfo>('GET', '/system'),
  previewConvert: (voiceId: string) => req<{ url: string; seconds: number }>('POST', '/preview/convert', { voiceId }),
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
