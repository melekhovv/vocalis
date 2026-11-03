import { useEffect, useRef, useState } from 'react'
import { Power, Loader2, Mic, Speaker, Headphones, Library, TriangleAlert, Gauge, Wand2, Cable, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { VoiceAvatar } from '@/components/voice-avatar'
import { LevelMeter, Waveform } from '@/components/meters'
import { ParamSlider, ParamSwitch, setParam } from '@/components/param-controls'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CATEGORY_LABELS, type DeviceList, type Preset, type EngineParams } from '@/lib/types'
import type { Page } from '@/App'

export const PRESET_LABELS: Record<Preset, string> = { performance: 'Скорость', balanced: 'Баланс', quality: 'Качество' }

export function HomePage({ go }: { go: (p: Page, tab?: string) => void }) {
  const { status, activeVoice, levels, toggleEngine, voices } = useStore()
  const e = status!.engine
  const running = e.state === 'running'
  const loading = e.state === 'loading'
  const accent = activeVoice?.accent ?? '#8b5cf6'
  const readyCount = voices.filter((v) => v.status === 'ready').length

  return (
    <div className="flex h-full">
      {/* ---------------------------------------------------- stage */}
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto px-6 pb-4">
        <div
          className="pointer-events-none absolute top-1/3 left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl transition-colors duration-700"
          style={{ background: `radial-gradient(circle, ${running ? accent : '#ffffff'}${running ? '40' : '08'}, transparent 65%)` }}
        />
        <div className="relative my-auto flex w-full shrink-0 flex-col items-center py-6">
        {activeVoice ? (
          <>
            <VoiceAvatar voice={activeVoice} ring={running} className="size-44 rounded-2xl transition-shadow duration-500" />
            <div className="mt-6 text-center">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{activeVoice.franchise}</div>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">{activeVoice.nameRu}</h1>
              <div className="mt-2 flex items-center justify-center gap-1.5">
                <Badge variant="secondary" className="font-normal">{CATEGORY_LABELS[activeVoice.category]}</Badge>
                <Badge variant="secondary" className="font-normal">RVC {activeVoice.checkpoint?.version ?? 'v2'}</Badge>
                {activeVoice.checkpoint && <Badge variant="secondary" className="font-normal">{activeVoice.checkpoint.sampleRate / 1000} кГц</Badge>}
              </div>
            </div>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto flex size-44 items-center justify-center rounded-2xl border border-dashed text-muted-foreground">
              <Library className="size-10" />
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight">Голос не выбран</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {readyCount ? 'Выберите голос в библиотеке или в списке избранного.' : 'Загрузите хотя бы одну модель в библиотеке голосов.'}
            </p>
            <Button variant="secondary" className="mt-4" onClick={() => go('library')}>Открыть библиотеку</Button>
          </div>
        )}

        <button
          onClick={toggleEngine}
          disabled={!activeVoice}
          className={cn(
            'group relative mt-8 flex size-20 items-center justify-center rounded-full border transition-all duration-300 disabled:opacity-40',
            running ? 'border-transparent text-background' : 'border-border bg-card text-foreground hover:border-foreground/30',
          )}
          style={running ? { background: accent, boxShadow: `0 0 0 6px ${accent}22, 0 0 40px ${accent}66` } : undefined}
          aria-label={running ? 'Выключить преобразование' : 'Включить преобразование'}
        >
          {loading ? <Loader2 className="size-7 animate-spin" /> : <Power className="size-7" strokeWidth={2.25} />}
        </button>
        <div className="mt-3 h-5 text-sm">
          <StateLine />
        </div>

        <div className="mt-6 w-full max-w-xl">
          <Waveform history={running ? levels.output : levels.input} accent={accent} active={running && !e.params.bypass} />
          <div className="mt-4 grid grid-cols-1 gap-4 min-[1280px]:grid-cols-2 min-[1280px]:gap-6">
            <LevelMeter label="Вход (микрофон)" db={running ? e.stats.inputDb : -120} gateDb={e.params.noise_gate_db} />
            <LevelMeter label="Выход (обработанный голос)" db={running ? e.stats.outputDb : -120} />
          </div>
        </div>
        </div>
      </section>

      {/* ---------------------------------------------------- side panel */}
      <aside className="w-80 shrink-0 border-l bg-card/40">
        <ScrollArea className="h-full">
          <div className="space-y-6 p-5">
            <QuickSettings go={go} />
            <Separator />
            <LiveMonitor />
            <Separator />
            <DevicesSummary go={go} />
            <Separator />
            <Metrics />
          </div>
        </ScrollArea>
      </aside>
    </div>
  )
}

function StateLine() {
  const { status } = useStore()
  const e = status!.engine
  if (e.state === 'error')
    return (
      <span className="flex items-center gap-1.5 text-destructive">
        <TriangleAlert className="size-4" /> {e.error?.slice(0, 90)}
      </span>
    )
  if (e.state === 'loading') return <span className="text-warn">Загрузка модели и подготовка {e.compute === 'cpu' ? 'CPU' : 'вычислительного устройства'}…</span>
  if (e.state !== 'running') return <span className="text-muted-foreground">Преобразование выключено</span>
  if (e.params.bypass) return <span className="text-warn">Bypass — звучит ваш оригинальный голос</span>
  if (e.params.ptt && !e.stats.pttHeld) return <span className="text-muted-foreground">Push-to-Talk: удерживайте клавишу, чтобы говорить</span>
  return <span className="text-live">● В эфире — голос преобразуется</span>
}

function QuickSettings({ go }: { go: (p: Page, tab?: string) => void }) {
  const { status } = useStore()
  const e = status!.engine
  const p = e.params
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Wand2 className="size-4 text-muted-foreground" /> Преобразование
      </div>
      <ToggleGroup
        type="single"
        aria-label="Режим качества"
        disabled={e.state === 'loading'}
        variant="outline"
        className="w-full"
        value={e.preset}
        onValueChange={(v) => v && api.preset(v as Preset).catch((e) => toast.error(e.message))}
      >
        {(Object.keys(PRESET_LABELS) as Preset[]).map((k) => (
          <ToggleGroupItem key={k} value={k} className="flex-1 text-xs">
            {PRESET_LABELS[k]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <VoiceControls key={e.voiceId ?? 'none'} go={go} />
      <ParamSlider
        label="Noise Gate"
        hint="Блоки тише порога не обрабатываются и заглушаются — убирает шум и дыхание в паузах."
        value={p.noise_gate_db}
        min={-80}
        max={-20}
        step={1}
        format={(v) => `${v} dB`}
        onCommit={(v) => setParam({ noise_gate_db: v })}
      />
      <div className="space-y-3.5">
        <ParamSwitch label="Оригинальный голос (Bypass)" hint="Временно пропускает ваш настоящий голос, не останавливая поток." checked={p.bypass} onChange={(v) => setParam({ bypass: v })} />
        <ParamSwitch label="Push-to-Talk" hint="Голос передаётся только пока удерживается клавиша PTT (настраивается в разделе «Горячие клавиши»)." checked={p.ptt} onChange={(v) => setParam({ ptt: v })} />
      </div>
    </div>
  )
}

function VoiceControls({ go }: { go: (p: Page, tab?: string) => void }) {
  const { status, activeVoice } = useStore()
  const e = status!.engine
  const p = e.params
  const [operation, setOperation] = useState<'idle' | 'saving' | 'resetting' | 'error'>('idle')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const selectedId = useRef(activeVoice?.id)
  selectedId.current = activeVoice?.id
  useEffect(() => { setOperation('idle') }, [activeVoice?.id])
  const disabled = !activeVoice || !e.voiceProfile || e.state === 'loading' || operation === 'saving' || operation === 'resetting'
  const apply = async (patch: Partial<EngineParams>) => {
    const id = activeVoice?.id
    if (!id || disabled) return undefined
    setOperation('saving')
    try {
      const result = await api.voiceParams(id, patch)
      if (mounted.current && selectedId.current === id) setOperation('idle')
      return result
    } catch (error) {
      if (mounted.current && selectedId.current === id) setOperation('error')
      toast.error('Настройки голоса не сохранены', { description: (error as Error).message })
      return undefined
    }
  }
  const reset = async () => {
    const id = activeVoice?.id
    if (!id || disabled) return
    setOperation('resetting')
    try {
      await api.resetVoiceProfile(id)
      if (mounted.current && selectedId.current === id) {
        setOperation('idle')
        toast.success('Восстановлены базовые настройки этого голоса')
      }
    } catch (error) {
      if (mounted.current && selectedId.current === id) setOperation('error')
      toast.error('Не удалось сбросить настройки голоса', { description: (error as Error).message })
    }
  }
  return (
    <section aria-label="Настройки этого голоса" className="space-y-4 border-y py-4">
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Настройки этого голоса</h2>
        <p className="text-xs text-muted-foreground">{activeVoice ? activeVoice.nameRu : 'Выберите модель в библиотеке'}</p>
        {activeVoice && <p role="status" className="text-xs text-muted-foreground">
          {operation === 'saving' ? 'Сохраняем изменения…' : operation === 'resetting' ? 'Восстанавливаем базовые настройки…' : operation === 'error' ? 'Последнее изменение не сохранено. Повторите настройку.' : !e.voiceProfile ? 'Получаем сведения о настройках…' : e.voiceProfile.saved ? 'Мои настройки · сохранены' : 'Базовые настройки модели'}
        </p>}
        <p className="text-xs leading-relaxed text-muted-foreground">Изменения сохраняются отдельно для этого голоса и используются также в примере.</p>
      </div>
      <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        <li>Для похожего тембра подберите тональность под свой голос, затем сравните влияние Index rate.</li>
        <li>Если согласные искажены, уменьшите protect или включите «Чёткую речь».</li>
        <li>Если звук заикается, проверьте режим «Скорость» и устройство CPU/GPU в производительности.</li>
      </ol>
      <ParamSlider disabled={disabled || e.voiceProfile?.applicability?.pitch === false} label="Тональность" hint="Сдвиг высоты в полутонах. Подбирайте небольшими шагами под свой диапазон; универсального значения для мужского или женского голоса нет." value={p.pitch} min={-24} max={24} step={1} format={(v) => `${v > 0 ? '+' : ''}${v} пт`} onCommit={(v) => apply({ pitch: v })} />
      {e.voiceProfile?.applicability?.f0 === false && <p className="text-xs leading-relaxed text-muted-foreground">Модель без F0 не использует тональность и защиту согласных.</p>}
      <ParamSlider disabled={disabled || p.clarity_mode || e.voiceProfile?.hasIndex === false || e.voiceProfile?.applicability?.index === false} label="Index rate" hint="Влияние необязательного файла .index на тембр. Большее значение может усилить сходство, но также артефакты; сравнивайте на одной фразе." value={p.index_rate} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => apply({ index_rate: v })} />
      {e.voiceProfile?.hasIndex === false && <p className="text-xs leading-relaxed text-muted-foreground">Файл .index не подключён. Он необязателен; Index rate недоступен.</p>}
      <ParamSlider disabled={disabled || p.clarity_mode || e.voiceProfile?.applicability?.protect === false} label="Защита согласных (protect)" hint="Меньше — сильнее сохраняются согласные и дыхание исходной речи. 0.5 выключает защиту. Сравнивайте разборчивость и сходство тембра." value={p.protect} min={0} max={0.5} step={0.01} format={(v) => v.toFixed(2)} onCommit={(v) => apply({ protect: v })} />
      <ParamSwitch disabled={disabled} label="Чёткая речь" hint="Уменьшает влияние индекса и усиливает защиту согласных. После выключения возвращаются ваши ручные Index rate и protect." checked={p.clarity_mode} onChange={(v) => { void apply({ clarity_mode: v }) }} />
      {p.clarity_mode && <p className="text-xs leading-relaxed text-muted-foreground">«Чёткая речь» управляет Index rate и protect. Выключите её для ручной настройки.</p>}
      {e.state === 'running' && !p.bypass && e.stats.realtimeFactor > 1 && <p role="status" className="rounded-md bg-warn/10 p-2 text-xs text-warn">Обработка не успевает: выберите режим «Скорость» и проверьте CPU/GPU. Настройка тембра сама по себе не устранит перегрузку.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || !e.voiceProfile?.saved} onClick={reset}>{operation === 'resetting' ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />} Сбросить настройки голоса</Button>
        <Button size="sm" variant="ghost" onClick={() => go('settings', 'performance')}>Производительность</Button>
      </div>
    </section>
  )
}

function LiveMonitor() {
  const { status } = useStore()
  const { params: p, devices: d, state } = status!.engine
  const [devs, setDevs] = useState<DeviceList | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.devices().then(setDevs).catch((e) => toast.error('Не удалось получить устройства прослушивания', { description: e.message }))
  }, [])
  const outputs = devs?.outputs.filter((device) => !device.isVirtualCable && device.id !== d.output) ?? []
  const selected = outputs.some((device) => device.id === d.monitor)
  const apply = async (change: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await change()
    } catch (e) {
      toast.error('Не удалось настроить прослушивание', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-label="Прослушивание голоса">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Headphones className="size-4 text-muted-foreground" /> Прослушивание голоса
      </div>
      <ParamSwitch
        label="Слышать себя"
        hint="Преобразованный голос звучит в наушниках одновременно с передачей в Discord. Включение не прерывает преобразование."
        checked={p.monitor}
        disabled={busy || state === 'loading' || (!p.monitor && !selected)}
        onChange={(monitor) => apply(() => api.params({ monitor }))}
      />
      <Select
        value={selected ? String(d.monitor) : ''}
        disabled={busy || !outputs.length || state === 'loading'}
        onValueChange={(id) => apply(() => api.setDevices({ monitor: Number(id) }))}
      >
        <SelectTrigger className="w-full" aria-label="Наушники для прослушивания">
          <SelectValue placeholder="Выберите наушники" />
        </SelectTrigger>
        <SelectContent>
          {outputs.map((device) => <SelectItem key={device.id} value={String(device.id)}>{device.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <ParamSlider
        label="Громкость в наушниках"
        value={p.monitor_gain} min={0} max={2} step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(monitor_gain) => setParam({ monitor_gain })}
      />
      <p className="text-xs text-muted-foreground" role="status">
        {!devs ? 'Загружаем устройства…' : !outputs.length ? 'Подключите наушники и обновите список устройств в настройках.'
          : !selected ? 'Выберите наушники для прослушивания.'
          : p.monitor && state === 'running' ? 'Вы слышите голос, который отправляется в Discord.'
          : p.monitor ? 'Прослушивание начнётся вместе с преобразованием.' : 'Включите, чтобы слышать результат во время разговора.'}
      </p>
    </section>
  )
}

function DevicesSummary({ go }: { go: (p: Page, tab?: string) => void }) {
  const { status } = useStore()
  const [devs, setDevs] = useState<DeviceList | null>(null)
  const d = status!.engine.devices
  useEffect(() => {
    api.devices().then(setDevs).catch(() => {})
  }, [d.input, d.output, d.monitor])
  const name = (list: DeviceList['inputs'] | undefined, id: number | null) => list?.find((x) => x.id === id)?.name ?? 'Не выбрано'
  const out = devs?.outputs.find((x) => x.id === d.output)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm font-medium">
        <span className="flex items-center gap-2">
          <Speaker className="size-4 text-muted-foreground" /> Устройства
        </span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => go('settings', 'devices')}>Изменить</Button>
      </div>
      <DeviceRow icon={Mic} label="Микрофон" value={name(devs?.inputs, d.input)} />
      <DeviceRow icon={Cable} label="Вывод" value={name(devs?.outputs, d.output)} warn={!!devs && !out?.isVirtualCable} />
      {status!.engine.params.monitor && <DeviceRow icon={Headphones} label="Мониторинг" value={name(devs?.outputs, d.monitor)} />}
      {devs && !out?.isVirtualCable && (
        <button onClick={() => go('settings', 'virtual')} className="w-full rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-left text-xs text-warn">
          Вывод идёт не в виртуальный кабель — Discord и игры не услышат голос. Настроить VB-CABLE →
        </button>
      )}
    </div>
  )
}

function DeviceRow({ icon: Icon, label, value, warn }: { icon: typeof Mic; label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', warn && 'text-warn')} />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate">{value}</div>
      </div>
    </div>
  )
}

function Metrics() {
  const { status } = useStore()
  const s = status!.engine.stats
  const sys = status!.system
  const running = status!.engine.state === 'running'
  const rows: [string, string, string?][] = [
    ['Задержка (оценка)', running ? `${Math.round(s.totalLatencyMs)} мс` : '—', 'Блок захвата + время нейросети + буфер джиттера + буферы драйверов'],
    ['Нейросеть / блок', running ? `${s.inferMsAvg.toFixed(0)} / ${s.blockMs.toFixed(0)} мс` : '—'],
    ['Устройство', s.device ? (s.device.startsWith('cuda') ? 'GPU (CUDA)' : 'CPU') : '—'],
    ['CPU', `${sys.cpu.toFixed(0)}%`],
    ['GPU', sys.gpu ? `${sys.gpu.util}% · ${(sys.gpu.memUsedMb / 1024).toFixed(1)} / ${(sys.gpu.memTotalMb / 1024).toFixed(0)} ГБ` : 'нет данных'],
    ['Пропуски', running ? `${s.inputDrops} вход · ${s.outputUnderruns} выход` : '—', 'Сколько блоков отброшено из-за перегрузки и сколько раз выходу не хватило звука'],
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Gauge className="size-4 text-muted-foreground" /> Производительность
      </div>
      <dl className="space-y-2">
        {rows.map(([k, v, title]) => (
          <div key={k} className="flex justify-between gap-3 text-xs" title={title}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="tabular text-right font-mono">{v}</dd>
          </div>
        ))}
      </dl>
      {running && s.realtimeFactor > 0.85 && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Нейросеть едва успевает за реальным временем. Переключитесь в режим «Скорость» или закройте тяжёлые приложения.
        </p>
      )}
    </div>
  )
}
