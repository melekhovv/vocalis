export type Category = 'cartoon' | 'anime' | 'film_tv' | 'film' | 'series' | 'game' | 'bloggers' | 'other'

export const CATEGORY_LABELS: Record<Category, string> = {
  cartoon: 'Мультфильмы',
  anime: 'Аниме',
  film_tv: 'Фильмы и сериалы',
  film: 'Фильмы',
  series: 'Сериалы',
  game: 'Видеоигры',
  bloggers: 'Блогеры и стримеры',
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
  voiceProfile?: { saved: boolean; hasIndex: boolean; applicability?: { pitch: boolean; f0: boolean; index: boolean; protect: boolean } }
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

export type SetupProfile = 'nvidia' | 'amd' | 'laptop' | 'cpu'

export interface CableSetupInfo {
  stage: 'checking' | 'installed' | 'available' | 'downloading' | 'extracting' | 'verifying' | 'launching' | 'awaiting-restart' | 'cancelled' | 'error'
  detail: string
  downloaded?: number
  total?: number
  error?: string
  devices?: string[]
}

export interface SetupProgress {
  profile: SetupProfile
  stage: 'preparing' | 'downloading' | 'installing' | 'verifying' | 'complete' | 'cancelled' | 'error'
  detail: string
  error?: string
}

export interface EngineInfo {
  state: 'needs-setup' | 'installing' | 'starting' | 'ready' | 'crashed'
  port: number
  token: string
  log: string[]
  dev: boolean
  setup?: SetupProgress
  setupProfile?: SetupProfile
}

export interface CatalogProvider {
  id: string
  name: string
  available: boolean
  description: string
}
export interface CatalogProviderState {
  id: string
  state: 'online' | 'cache' | 'error'
  message: string
  checkedAt: number | null
}
export interface CatalogInstallSelection {
  pth?: string
  index?: string | null
  archive?: string
}
export interface CatalogEntry {
  /** Renderer-only snapshot marker; never grants installation permission. */
  cachedMetadata?: boolean
  discoveryVoiceId?: string
  id: string
  provider: string
  voiceId: string
  name: string
  description: string
  category: Category
  language: string | null
  author: string | null
  sourceUrl: string
  license: string
  rights: { approved: boolean; reason: string; evidenceUrl?: string; verifiedAt?: string }
  compatibility: 'unverified' | 'rvc-v1' | 'rvc-v2' | 'incompatible'
  size: number | null
  downloads: number | null
  installed: boolean
  job: JobInfo | null
  canInstall: boolean
  installReason?: string
  languageConfidence?: 'declared' | 'unknown'
  revision?: string
  requiresSelection?: boolean
  files?: { path: string; kind: 'pth' | 'index' | 'archive'; size: number; sha256: string }[]
  installedVariants?: { voiceId: string; name: string; revision: string; files: string[] }[]
  sourceState?: CatalogProviderState
}
export interface CatalogJob extends JobInfo {
  voiceId: string
  provider: string
  id: string
}
export interface CatalogSearchResult {
  items: CatalogEntry[]
  providers: CatalogProviderState[]
  cached: boolean
}
