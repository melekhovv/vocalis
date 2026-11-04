export type Category = 'cartoon' | 'anime' | 'film_tv' | 'game' | 'people' | 'other'

export const CATEGORY_LABELS: Record<Category, string> = {
  cartoon: 'Мультфильмы',
  anime: 'Аниме',
  film_tv: 'Фильмы и сериалы',
  game: 'Видеоигры',
  people: 'Медийные люди',
  other: 'Другие',
}

export type VoiceStatus = 'not_downloaded' | 'downloading' | 'ready' | 'corrupted'

export interface JobInfo {
  stage: string
  done: number
  total: number
  progress: number
  error: string | null
}

export interface Voice {
  id: string
  name: string
  nameRu: string
  franchise: string
  category: Category
  description: string
  language: string | null
  suggestedPitch: number
  accent: string
  wikipedia: string | null
  custom: boolean
  status: VoiceStatus
  downloadSize: number | null
  diskSize: number | null
  compatible: boolean | null
  checkpoint: { version: string; sampleRate: number; f0: boolean; vocoder: string } | null
  job: JobInfo | null
  lastError?: string
  model: {
    title: string
    format: string
    repo: string | null
    revision: string | null
    upstream: string
    license: string
    licenseNote: string
  }
}

export interface EngineParams {
  clarity_mode: boolean
  pitch: number
  index_rate: number
  protect: number
  f0_method: string
  noise_gate_db: number
  noise_filter: boolean
  vad: boolean
  input_gain: number
  output_gain: number
  monitor_gain: number
  monitor: boolean
  bypass: boolean
  ptt: boolean
  ptt_vk: number
  volume_envelope: number
}

export type Preset = 'performance' | 'balanced' | 'quality'

export interface EngineStats {
  inputDb: number
  outputDb: number
  inferMs: number
  inferMsAvg: number
  blockMs: number
  streamLatencyMs: number
  bufferMs: number
  totalLatencyMs: number
  inputDrops: number
  outputUnderruns: number
  gated: boolean
  pttHeld: boolean
  device: string | null
  realtimeFactor: number
}

export interface EngineStatus {
  state: 'stopped' | 'loading' | 'running' | 'error'
  error: string | null
  voiceId: string | null
  preset: Preset
  params: EngineParams
  devices: { input: number | null; output: number | null; monitor: number | null }
  compute: 'auto' | 'cpu'
  stats: EngineStats
}

export interface SystemStats {
  cpu: number
  ram: number
  processRamMb: number
  gpu: { name: string; util: number; memUsedMb: number; memTotalMb: number } | null
}

export interface BaseAssets {
  ready: boolean
  items: { id: string; title: string; size: number; present: boolean }[]
  job: JobInfo | null
}

export interface StatusMessage {
  version: string
  engine: EngineStatus
  system: SystemStats
  baseAssets: BaseAssets
  rev: number
  voices?: Voice[]
}

export interface AudioDevice {
  id: number
  name: string
  hostApi: string
  channels: number
  defaultSampleRate: number
  isVirtualCable: boolean
}

export interface DeviceList {
  hostApi: string | null
  inputs: AudioDevice[]
  outputs: AudioDevice[]
  defaultInput: number | null
  defaultOutput: number | null
  virtualCable: number | null
}

export type HotkeyAction = 'toggle' | 'bypass' | 'next' | 'prev' | 'monitor'

export interface AppSettings {
  hotkeys: Record<HotkeyAction, string>
  favorites: string[]
  recent: string[]
  closeToTray: boolean
  autostart: boolean
  startMinimized: boolean
  acceptedNotice: boolean
  quickSwitchFavoritesOnly: boolean
}

export interface EngineInfo {
  state: 'needs-setup' | 'installing' | 'starting' | 'ready' | 'crashed'
  port: number
  token: string
  log: string[]
  dev: boolean
}
