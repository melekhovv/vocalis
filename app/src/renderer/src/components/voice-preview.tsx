import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, mediaUrl } from '@/lib/api'

interface PreviewCtx {
  converting: string | null
  playing: string | null
  play: (voiceId: string) => Promise<void>
  stop: () => void
}
const Ctx = createContext<PreviewCtx | null>(null)

/** Card previews convert local Windows system speech, never a microphone recording. */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [converting, setConverting] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  const stop = useCallback(() => {
    if (audio.current) {
      audio.current.onended = null
      audio.current.onerror = null
      audio.current.pause()
      audio.current = null
    }
    setPlaying(null)
  }, [])
  const play = useCallback(async (voiceId: string) => {
    if (playing === voiceId) return stop()
    if (busy.current) return
    busy.current = true
    stop()
    setConverting(voiceId)
    try {
      const { url } = await api.previewConvert(voiceId)
      if (!mounted.current) return
      const a = new Audio(mediaUrl(url))
      audio.current = a
      const fail = () => {
        if (audio.current !== a) return
        stop()
        toast.error('Не удалось воспроизвести пример')
      }
      a.onerror = fail
      a.onended = () => { if (audio.current === a) stop() }
      await a.play()
      if (audio.current === a && mounted.current) setPlaying(voiceId)
    } catch (e) {
      if (mounted.current) {
        stop()
        toast.error('Не удалось прослушать', { description: (e as Error).message })
      }
    } finally {
      busy.current = false
      if (mounted.current) setConverting(null)
    }
  }, [playing, stop])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; audio.current?.pause() }
  }, [])
  return <Ctx.Provider value={{ converting, playing, play, stop }}>{children}</Ctx.Provider>
}
export function usePreview() {
  const c = useContext(Ctx)
  if (!c) throw new Error('PreviewProvider missing')
  return c
}
