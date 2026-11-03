import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, configureApi, wsUrl } from './api'
import { bridge } from './bridge'
import type { AppSettings, EngineInfo, StatusMessage, Voice } from './types'

interface Store {
  info: EngineInfo | null
  connected: boolean
  status: StatusMessage | null
  voices: Voice[]
  settings: AppSettings | null
  /** rolling input/output level history (dBFS), newest last */
  levels: { input: number[]; output: number[] }
  activeVoice: Voice | null
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  toggleFavorite: (id: string) => void
  selectVoice: (id: string) => Promise<void>
  toggleEngine: () => Promise<void>
  refreshVoices: () => Promise<void>
}

const Ctx = createContext<Store | null>(null)
const HISTORY = 96

export function StoreProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<EngineInfo | null>(null)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<StatusMessage | null>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [levels, setLevels] = useState<{ input: number[]; output: number[] }>({ input: [], output: [] })
  const wsRef = useRef<WebSocket | null>(null)
  const lastError = useRef<string | null>(null)

  useEffect(() => {
    bridge.engineInfo().then(setInfo)
    bridge.getSettings().then(setSettings)
    const offs = [
      bridge.onEngineState(setInfo),
      bridge.onSettings(setSettings),
      bridge.onHotkey((e) => {
        if (!e.ok) toast.error('Горячая клавиша не сработала', { description: e.error })
      }),
    ]
    return () => offs.forEach((f) => f())
  }, [])

  // (Re)connect the status socket whenever the engine (re)starts.
  useEffect(() => {
    if (!info || info.state !== 'ready') {
      setConnected(false)
      return
    }
    configureApi(info.port, info.token)
    let closed = false
    let retry: ReturnType<typeof setTimeout>
    const connect = () => {
      const ws = new WebSocket(wsUrl())
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 1000)
      }
      ws.onmessage = (ev) => {
        const msg: StatusMessage = JSON.parse(ev.data)
        setStatus(msg)
        if (msg.voices) setVoices(msg.voices)
        const st = msg.engine.stats
        const running = msg.engine.state === 'running'
        setLevels((l) => ({
          input: [...l.input.slice(-(HISTORY - 1)), running ? st.inputDb : -120],
          output: [...l.output.slice(-(HISTORY - 1)), running ? st.outputDb : -120],
        }))
        const err = msg.engine.state === 'error' ? msg.engine.error : null
        if (err && err !== lastError.current) toast.error('Ошибка преобразования', { description: err })
        lastError.current = err
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [info?.state, info?.port, info?.token])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const r = await bridge.setSettings(patch)
    setSettings(r.settings)
    const errs = Object.entries(r.hotkeyErrors || {})
    if (errs.length) toast.error('Не удалось назначить горячие клавиши', { description: errs.map(([k, v]) => `${k}: ${v}`).join('\n') })
  }, [])

  const toggleFavorite = useCallback(
    (id: string) => {
      if (!settings) return
      const fav = settings.favorites.includes(id) ? settings.favorites.filter((x) => x !== id) : [...settings.favorites, id]
      updateSettings({ favorites: fav })
    },
    [settings, updateSettings],
  )

  const selectVoice = useCallback(
    async (id: string) => {
      try {
        await api.selectVoice(id)
        bridge.rememberVoice(id)
      } catch (e) {
        toast.error('Не удалось выбрать голос', { description: (e as Error).message })
      }
    },
    [voices],
  )

  const toggleEngine = useCallback(async () => {
    const st = status?.engine.state
    try {
      if (st === 'running' || st === 'loading') await api.stop()
      else await api.start()
    } catch (e) {
      toast.error('Не удалось запустить преобразование', { description: (e as Error).message })
    }
  }, [status?.engine.state])

  const refreshVoices = useCallback(async () => setVoices(await api.voices()), [])

  const activeVoice = useMemo(() => voices.find((v) => v.id === status?.engine.voiceId) ?? null, [voices, status?.engine.voiceId])

  const value: Store = {
    info, connected, status, voices, settings, levels, activeVoice,
    updateSettings, toggleFavorite, selectVoice, toggleEngine, refreshVoices,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('StoreProvider missing')
  return s
}
