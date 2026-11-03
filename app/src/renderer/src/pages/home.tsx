import { useEffect, useState } from 'react'
import { Power, Loader2, Mic, Speaker, Headphones, Library, TriangleAlert, Gauge, Wand2, Cable } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { VoiceAvatar } from '@/components/voice-avatar'
import { LevelMeter, Waveform } from '@/components/meters'
import { ParamSlider, ParamSwitch, setParam } from '@/components/param-controls'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CATEGORY_LABELS, type DeviceList, type Preset } from '@/lib/types'
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
      <section className="relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden px-10 pb-10">
        <div
          className="pointer-events-none absolute top-1/3 left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl transition-colors duration-700"
          style={{ background: `radial-gradient(circle, ${running ? accent : '#ffffff'}${running ? '40' : '08'}, transparent 65%)` }}
        />
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
          <div className="mt-4 grid grid-cols-2 gap-6">
            <LevelMeter label="Вход (микрофон)" db={running ? e.stats.inputDb : -120} gateDb={e.params.noise_gate_db} />
            <LevelMeter label="Выход (обработанный голос)" db={running ? e.stats.outputDb : -120} />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- side panel */}
      <aside className="w-80 shrink-0 border-l bg-card/40">
        <ScrollArea className="h-full">
          <div className="space-y-6 p-5">
            <QuickSettings />
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
  if (e.state === 'loading') return <span className="text-warn">Загрузка модели и прогрев {e.compute === 'cpu' ? 'CPU' : 'устройства вычислений (автовыбор)'}…</span>
  if (e.state !== 'running') return <span className="text-muted-foreground">Преобразование выключено</span>
  if (e.params.bypass) return <span className="text-warn">Bypass — звучит ваш оригинальный голос</span>
  if (e.params.ptt && !e.stats.pttHeld) return <span className="text-muted-foreground">Push-to-Talk: удерживайте клавишу, чтобы говорить</span>
  return <span className="text-live">● В эфире — голос преобразуется</span>
}

function QuickSettings() {
  const { status, activeVoice } = useStore()
  const e = status!.engine
  const p = e.params
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Wand2 className="size-4 text-muted-foreground" /> Преобразование
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        className="w-full"
        value={e.preset}
        onValueChange={(v) => v && api.preset(v as Preset)}
      >
        {(Object.keys(PRESET_LABELS) as Preset[]).map((k) => (
          <ToggleGroupItem key={k} value={k} className="flex-1 text-xs">
            {PRESET_LABELS[k]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ParamSwitch label="Чёткая речь" hint="Для микрофона: мягче переносит тембр и сильнее сохраняет согласные. Отключите, чтобы вернуть профиль голоса." checked={p.clarity_mode} onChange={(v) => setParam({ clarity_mode: v })} />
      <ParamSlider
        label="Тональность"
        hint={activeVoice ? `Рекомендуется для мужского голоса: ${activeVoice.suggestedPitch > 0 ? '+' : ''}${activeVoice.suggestedPitch} полутонов. Для женского голоса — примерно на 12 меньше.` : 'Сдвиг высоты в полутонах'}
        value={p.pitch}
        min={-24}
        max={24}
        step={1}
        format={(v) => `${v > 0 ? '+' : ''}${v} пт`}
        onCommit={(v) => setParam({ pitch: v })}
      />
      {activeVoice && p.pitch !== activeVoice.suggestedPitch && (
        <button className="-mt-3 text-xs text-primary hover:underline" onClick={() => setParam({ pitch: activeVoice.suggestedPitch })}>
          Сбросить на рекомендуемую ({activeVoice.suggestedPitch > 0 ? '+' : ''}{activeVoice.suggestedPitch})
        </button>
      )}
      <ParamSlider
        label="Index rate"
        disabled={p.clarity_mode}
        hint="Насколько сильно подтягивать тембр к обучающим данным модели (.index). Выше — больше сходства, но возможны артефакты."
        value={p.index_rate}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onCommit={(v) => setParam({ index_rate: v })}
      />
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
        <ParamSwitch label="Мониторинг" hint="Слышать обработанный голос в наушниках (устройство мониторинга задаётся в настройках)." checked={p.monitor} onChange={(v) => setParam({ monitor: v })} />
        <ParamSwitch label="Push-to-Talk" hint="Голос передаётся только пока удерживается клавиша PTT (настраивается в разделе «Горячие клавиши»)." checked={p.ptt} onChange={(v) => setParam({ ptt: v })} />
      </div>
    </div>
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
