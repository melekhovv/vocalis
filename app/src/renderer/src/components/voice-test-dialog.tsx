import { useEffect, useRef, useState } from 'react'
import { Mic, Play, Square, RefreshCw, Loader2, ArrowLeftRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { api, mediaUrl, type RecordTestResult } from '@/lib/api'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const DURATION_SEC = 4

export function VoiceTestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { status, activeVoice } = useStore()
  const e = status!.engine
  const running = e.state === 'running' || e.state === 'loading'
  const baseReady = status!.baseAssets.ready
  const [busy, setBusy] = useState<'record' | 'reconvert' | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [result, setResult] = useState<RecordTestResult | null>(null)
  const [playing, setPlaying] = useState<'raw' | 'converted' | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    setPlaying(null)
  }

  useEffect(() => {
    if (!open) stopPlayback()
    return () => stopPlayback()
  }, [open])

  useEffect(() => {
    if (busy !== 'record') {
      setCountdown(0)
      return
    }
    setCountdown(DURATION_SEC)
    const id = setInterval(() => {
      setCountdown((c) => (c > 0.2 ? Math.max(0, c - 0.1) : 0))
    }, 100)
    return () => clearInterval(id)
  }, [busy])

  const recordTest = async () => {
    stopPlayback()
    setBusy('record')
    try {
      const r = await api.previewRecordTest(DURATION_SEC)
      setResult(r)
      toast.success('Запись преобразована', { description: `Обработка заняла ${r.seconds} с` })
    } catch (err) {
      toast.error('Тест записи не удался', { description: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const reconvert = async () => {
    stopPlayback()
    setBusy('reconvert')
    try {
      const r = await api.previewReconvert()
      setResult(r)
      toast.success('Запись пересчитана', { description: `Обработка заняла ${r.seconds} с` })
    } catch (err) {
      toast.error('Не удалось пересчитать запись', { description: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const playTrack = async (kind: 'raw' | 'converted') => {
    if (!result) return
    if (playing === kind) return stopPlayback()
    stopPlayback()
    const a = new Audio(mediaUrl(kind === 'raw' ? result.rawUrl : result.convertedUrl))
    audioRef.current = a
    a.onended = () => { if (audioRef.current === a) setPlaying(null) }
    a.onerror = () => {
      if (audioRef.current === a) {
        stopPlayback()
        toast.error('Не удалось воспроизвести аудио')
      }
    }
    try {
      await a.play()
      if (audioRef.current === a) setPlaying(kind)
    } catch {
      stopPlayback()
    }
  }

  const blockedReason = running
    ? 'Остановите живое преобразование на главном экране, чтобы записать тестовую фразу.'
    : !activeVoice
      ? 'Сначала выберите голос.'
      : !baseReady
        ? 'Сначала загрузите базовые нейросети.'
        : e.devices.input === null
          ? 'Выберите микрофон в настройках аудиоустройств.'
          : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 text-primary" /> Тест голоса: До и После
          </DialogTitle>
          <DialogDescription>
            Запишите короткую фразу ({DURATION_SEC} сек.) с микрофона, чтобы объективно сравнить оригинал и преобразованный голос без задержки и костной проводимости.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {activeVoice && (
            <div className="rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs">
              <div className="font-medium text-foreground">Модель: {activeVoice.nameRu}</div>
              <div className="mt-1 text-muted-foreground">
                Тональность: {e.params.pitch > 0 ? '+' : ''}{e.params.pitch} пт · Index: {e.params.index_rate.toFixed(2)} · F0: {e.params.f0_method.toUpperCase()}
              </div>
            </div>
          )}

          {blockedReason && (
            <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {blockedReason}
            </p>
          )}

          {busy === 'record' && (
            <div className="space-y-2 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium text-destructive">
                  <Mic className="size-3.5 animate-pulse" />
                  {countdown > 0 ? `Говорите в микрофон… (${countdown.toFixed(1)} с)` : 'Нейросеть преобразует запись…'}
                </span>
              </div>
              <Progress value={countdown > 0 ? ((DURATION_SEC - countdown) / DURATION_SEC) * 100 : 100} className="h-1.5" />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button className="flex-1" disabled={!!blockedReason || busy !== null} onClick={recordTest}>
              {busy === 'record' ? <Loader2 className="animate-spin" /> : <Mic />}
              {result ? 'Записать заново (4 с)' : 'Записать фразу (4 с)'}
            </Button>
            {result && (
              <Button variant="outline" disabled={!!blockedReason || busy !== null} onClick={reconvert} title="Применить текущие ползунки (тональность, index, F0) к уже записанной фразе">
                {busy === 'reconvert' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Пересчитать с новыми параметрами
              </Button>
            )}
          </div>

          {result && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <Button
                variant={playing === 'raw' ? 'default' : 'outline'}
                className={cn('h-11 justify-center gap-2')}
                onClick={() => playTrack('raw')}
                disabled={busy !== null}
              >
                {playing === 'raw' ? <Square className="size-4" /> : <Play className="size-4" />}
                Оригинал (До)
              </Button>
              <Button
                variant={playing === 'converted' ? 'default' : 'secondary'}
                className={cn('h-11 justify-center gap-2')}
                onClick={() => playTrack('converted')}
                disabled={busy !== null}
              >
                {playing === 'converted' ? <Square className="size-4" /> : <Play className="size-4" />}
                После RVC ({result.seconds} с)
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
