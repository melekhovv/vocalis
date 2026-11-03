import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Volume2, Mic, CheckCircle2, CircleAlert, Loader2, Cpu, Zap, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ParamSlider, ParamSwitch, setParam } from '@/components/param-controls'
import { CableSetup } from '@/components/cable-setup'
import { HotkeyRecorder, KeyRecorder } from '@/components/hotkey-recorder'
import { useStore } from '@/lib/store'
import { api, type SystemInfo } from '@/lib/api'
import { bridge } from '@/lib/bridge'
import { formatBytes } from '@/lib/utils'
import type { AudioDevice, DeviceList, HotkeyAction, Preset } from '@/lib/types'
import { PRESET_LABELS } from '@/pages/home'

export function SettingsPage({ tab, onTab }: { tab: string; onTab: (t: string) => void }) {
  return (
    <div className="flex h-full flex-col">
      <header className="px-8 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
      </header>
      <Tabs value={tab} onValueChange={onTab} className="flex min-h-0 flex-1 flex-col">
        <div className="mx-8 min-w-0">
          <TabsList className="grid w-full grid-cols-3 gap-1 group-data-[orientation=horizontal]/tabs:h-auto min-[1280px]:grid-cols-6 [&>button]:h-8 [&>button]:min-w-0 [&>button]:text-xs">
            <TabsTrigger value="devices">Аудиоустройства</TabsTrigger>
            <TabsTrigger value="virtual">Виртуальный микрофон</TabsTrigger>
            <TabsTrigger value="processing">Обработка</TabsTrigger>
            <TabsTrigger value="performance">Производительность</TabsTrigger>
            <TabsTrigger value="hotkeys">Горячие клавиши</TabsTrigger>
            <TabsTrigger value="app">Приложение</TabsTrigger>
          </TabsList>
        </div>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <div className="w-full px-8 pb-10">
            <TabsContent value="devices"><DevicesTab /></TabsContent>
            <TabsContent value="virtual"><VirtualTab /></TabsContent>
            <TabsContent value="processing"><ProcessingTab /></TabsContent>
            <TabsContent value="performance"><PerformanceTab /></TabsContent>
            <TabsContent value="hotkeys"><HotkeysTab /></TabsContent>
            <TabsContent value="app"><AppTab /></TabsContent>
          </div>
        </div>
      </Tabs>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="border-b px-5 py-3.5">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="space-y-5 p-5">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function useDevices() {
  const [devs, setDevs] = useState<DeviceList | null>(null)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async (hard = false) => {
    setLoading(true)
    try {
      setDevs(await api.devices(hard))
    } catch (e) {
      toast.error('Не удалось получить список устройств', { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  return { devs, loading, refresh }
}

function DeviceSelect({ list, value, onChange, placeholder }: { list: AudioDevice[]; value: number | null; onChange: (id: number) => void; placeholder: string }) {
  return (
    <Select value={list.some((d) => d.id === value) ? String(value) : ''} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-80"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {list.map((d) => (
          <SelectItem key={d.id} value={String(d.id)}>
            {d.name}
            {d.isVirtualCable && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">виртуальный</Badge>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DevicesTab() {
  const { status } = useStore()
  const { devs, loading, refresh } = useDevices()
  const d = status!.engine.devices
  const p = status!.engine.params
  const running = status!.engine.state === 'running' || status!.engine.state === 'loading'
  const [testing, setTesting] = useState<string | null>(null)

  const set = (patch: { input?: number; output?: number; monitor?: number }) =>
    api.setDevices(patch).catch((e) => toast.error('Не удалось выбрать устройство', { description: e.message }))

  const testIn = async () => {
    if (d.input === null) return
    setTesting('in')
    try {
      const r = await api.testInput(d.input)
      if (r.peakDb < -60) toast.warning('Микрофон работает, но сигнал очень тихий', { description: `Пик ${r.peakDb.toFixed(0)} dB. Проверьте, не выключен ли микрофон.` })
      else toast.success('Микрофон работает', { description: `Пик ${r.peakDb.toFixed(0)} dB, средний уровень ${r.rmsDb.toFixed(0)} dB` })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(null)
    }
  }
  const testOut = async (id: number | null, key: string) => {
    if (id === null) return
    setTesting(key)
    try {
      await api.testOutput(id)
      toast.success('Тестовый сигнал воспроизведён')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(null)
    }
  }

  if (!devs) return <div className="space-y-3 text-sm text-muted-foreground"><p role="status">{loading ? 'Загружаем устройства…' : 'Не удалось загрузить устройства.'}</p><Button variant="outline" disabled={loading} onClick={() => refresh()}>Повторить</Button></div>
  return (
    <div className="space-y-5">
      <Section
        title="Устройства ввода и вывода"
        description={`Используется ${devs.hostApi ?? '—'} (общий режим) — минимальная задержка без монопольного захвата устройств.`}
      >
        <Row label="Физический микрофон" hint="Откуда берётся ваш голос">
          <div className="flex gap-2">
            <DeviceSelect list={devs.inputs} value={d.input} onChange={(id) => set({ input: id })} placeholder="Выберите микрофон" />
            <Button variant="outline" size="icon" onClick={testIn} disabled={running || testing !== null} title="Проверить микрофон (1 с)">
              {testing === 'in' ? <Loader2 className="animate-spin" /> : <Mic />}
            </Button>
          </div>
        </Row>
        <Row label="Вывод преобразованного голоса" hint="Выберите «CABLE Input» — его слушают Discord и игры">
          <div className="flex gap-2">
            <DeviceSelect list={devs.outputs} value={d.output} onChange={(id) => set({ output: id })} placeholder="Выберите устройство" />
            <Button variant="outline" size="icon" onClick={() => testOut(d.output, 'out')} disabled={running || testing !== null || d.output === null} title="Тестовый тон (при остановленном преобразовании)">
              {testing === 'out' ? <Loader2 className="animate-spin" /> : <Volume2 />}
            </Button>
          </div>
        </Row>
        <Row label="Устройство мониторинга" hint="Наушники, в которых вы слышите себя">
          <div className="flex gap-2">
            <DeviceSelect list={devs.outputs.filter((device) => !device.isVirtualCable && device.id !== d.output)} value={d.monitor} onChange={(id) => set({ monitor: id })} placeholder="Выберите наушники" />
            <Button variant="outline" size="icon" onClick={() => testOut(d.monitor, 'mon')} disabled={running || testing !== null || d.monitor === null} title="Тестовый тон (при остановленном преобразовании)">
              {testing === 'mon' ? <Loader2 className="animate-spin" /> : <Volume2 />}
            </Button>
          </div>
        </Row>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => refresh(true)} disabled={loading || running} title={running ? 'Остановите преобразование, чтобы пересканировать устройства' : undefined}>
            <RefreshCw className={loading ? 'animate-spin' : ''} /> Обновить список устройств
          </Button>
        </div>
      </Section>
      <Section title="Громкость">
        <ParamSlider label="Громкость микрофона" value={p.input_gain} min={0} max={3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => setParam({ input_gain: v })} />
        <ParamSlider label="Громкость обработанного голоса" value={p.output_gain} min={0} max={3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => setParam({ output_gain: v })} />
        <ParamSlider label="Громкость мониторинга" value={p.monitor_gain} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => setParam({ monitor_gain: v })} />
      </Section>
    </div>
  )
}

function VirtualTab() {
  const { status } = useStore()
  const { devs, loading, refresh } = useDevices()
  const running = status!.engine.state === 'running' || status!.engine.state === 'loading'
  const cableIn = devs?.outputs.find((o) => o.isVirtualCable)
  const routed = cableIn && status!.engine.devices.output === cableIn.id

  return (
    <div className="space-y-5">
      <CableSetup />
      <Section title="Маршрутизация" description="После установки и перезагрузки Windows выберите виртуальный кабель как вывод Vocalis.">
        {devs ? <StatusLine ok={!!routed} okText="Vocalis выводит голос в виртуальный кабель" badText="Вывод Vocalis ещё не направлен в «CABLE Input»" /> : <p className="text-sm text-muted-foreground">Получаем список аудиоустройств…</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh(true)} disabled={loading || running}>
            <RefreshCw className={loading ? 'animate-spin' : ''} /> Обновить аудиоустройства
          </Button>
          {cableIn && !routed && (
            <Button size="sm" onClick={() => api.setDevices({ output: cableIn.id }).then(() => toast.success('Вывод направлен в CABLE Input')).catch((e) => toast.error(e.message))}>Направить вывод в CABLE Input</Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => bridge.openSoundSettings()}>Параметры звука Windows</Button>
        </div>
      </Section>
      <Section title="2. Маршрутизация звука">
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-3 text-center text-xs">
          <Node title="Ваш микрофон" sub="физическое устройство" />
          <Arrow />
          <Node title="Vocalis" sub="локальное преобразование RVC" accent />
          <Arrow />
          <Node title="CABLE Input" sub="вывод Vocalis" />
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center text-xs">
          <Node title="CABLE Output" sub="виртуальный микрофон" />
          <Arrow />
          <Node title="Discord · Telegram · CS2" sub="выберите как микрофон" />
        </div>
      </Section>
      <Section title="3. Настройка программ">
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li><b className="text-foreground">Discord:</b> Настройки → Голос и видео → Устройство ввода: <code className="rounded bg-muted px-1">CABLE Output (VB-Audio Virtual Cable)</code>. Отключите «Шумоподавление» Krisp и автоматическую регулировку чувствительности — они портят обработанный голос.</li>
          <li><b className="text-foreground">Telegram:</b> Настройки → Звонки → Микрофон: <code className="rounded bg-muted px-1">CABLE Output</code>.</li>
          <li><b className="text-foreground">Counter-Strike 2 / Steam:</b> CS2 использует микрофон по умолчанию Windows — в «Параметрах звука» сделайте <code className="rounded bg-muted px-1">CABLE Output</code> устройством ввода по умолчанию.</li>
          <li><b className="text-foreground">Проверка:</b> включите преобразование и откройте Discord → «Проверка микрофона» — вы должны услышать изменённый голос.</li>
        </ul>
      </Section>
    </div>
  )
}

function StatusLine({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      {ok ? <CheckCircle2 className="size-4 text-live" /> : <CircleAlert className="size-4 text-warn" />}
      <span className={ok ? '' : 'text-muted-foreground'}>{ok ? okText : badText}</span>
    </div>
  )
}

function Node({ title, sub, accent }: { title: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${accent ? 'border-primary/40 bg-primary/10' : 'bg-muted/40'}`}>
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-0.5 text-muted-foreground">{sub}</div>
    </div>
  )
}

function Arrow() {
  return <span className="text-muted-foreground">→</span>
}

function ProcessingTab() {
  const { status } = useStore()
  const p = status!.engine.params
  return (
    <div className="space-y-5">
      <Section title="Высота тона">
        <ParamSwitch label="Чёткая речь" hint="Меньше влияния индекса, сильнее защита согласных. Выключите, чтобы вернуть настройки выбранного голоса." checked={p.clarity_mode} onChange={(v) => setParam({ clarity_mode: v })} />
        <Row label="Метод извлечения высоты (Pitch extraction)" hint="RMVPE — точнее, FCPE — быстрее, CREPE — медленно, для мощных GPU">
          <Select value={p.f0_method} onValueChange={(v) => setParam({ f0_method: v })}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="rmvpe">RMVPE</SelectItem>
              <SelectItem value="fcpe">FCPE</SelectItem>
              <SelectItem value="crepe">CREPE</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <ParamSlider label="Transpose (сдвиг тональности)" hint="+12 — на октаву выше. Мужской голос → женский/мультяшный: +8…+12" value={p.pitch} min={-24} max={24} step={1} format={(v) => `${v > 0 ? '+' : ''}${v} пт`} onCommit={(v) => setParam({ pitch: v })} />
        <ParamSlider disabled={p.clarity_mode} label="Index rate" value={p.index_rate} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => setParam({ index_rate: v })} />
        <ParamSlider disabled={p.clarity_mode} label="Защита согласных (protect)" hint="Меньше — сильнее сохраняются глухие согласные и дыхание исходного голоса (0.5 — выключено)" value={p.protect} min={0} max={0.5} step={0.01} format={(v) => v.toFixed(2)} onCommit={(v) => setParam({ protect: v })} />
        <ParamSlider label="Огибающая громкости" hint="1 — громкость как у модели, 0 — повторять громкость вашего голоса" value={p.volume_envelope} min={0} max={1} step={0.05} format={(v) => v.toFixed(2)} onCommit={(v) => setParam({ volume_envelope: v })} />
      </Section>
      <Section title="Шум">
        <ParamSlider label="Noise Gate" value={p.noise_gate_db} min={-80} max={-20} step={1} format={(v) => `${v} dB`} onCommit={(v) => setParam({ noise_gate_db: v })} />
        <ParamSwitch label="Фильтр шума (ФВЧ 80 Гц)" hint="Срезает гул, вибрации стола и низкочастотный шум до подачи в нейросеть" checked={p.noise_filter} onChange={(v) => setParam({ noise_filter: v })} />
        <ParamSwitch label="Детектор речи (WebRTC VAD)" hint="Обрабатывать только фрагменты, распознанные как речь — убирает клавиатуру и фоновые звуки" checked={p.vad} onChange={(v) => setParam({ vad: v })} />
      </Section>
    </div>
  )
}

function PerformanceTab() {
  const { status } = useStore()
  const e = status!.engine
  const [sys, setSys] = useState<SystemInfo | null>(null)
  useEffect(() => {
    api.system().then(setSys).catch(() => {})
  }, [])
  const desc: Record<Preset, string> = {
    performance: 'Блок 120 мс, FCPE. Минимальная задержка.',
    balanced: 'Блок 200 мс, RMVPE. Рекомендуется.',
    quality: 'Блок 300 мс, RMVPE, больше контекста. Самый чистый звук.',
  }
  return (
    <div className="space-y-5">
      <Section title="Режим качества / производительности" description="Размер блока определяет основную часть задержки. Нейросеть должна успевать обработать блок быстрее, чем он длится.">
        <ToggleGroup type="single" variant="outline" disabled={e.state === 'loading'} aria-label="Режим качества" value={e.preset} onValueChange={(v) => v && api.preset(v as Preset).catch((e) => toast.error(e.message))} className="grid w-full grid-cols-3 items-stretch">
          {(Object.keys(PRESET_LABELS) as Preset[]).map((k) => (
            <ToggleGroupItem key={k} value={k} className="h-auto flex-1 basis-0 flex-col items-start justify-start gap-1 px-3 py-3 text-left whitespace-normal">
              <span className="text-sm font-medium">{PRESET_LABELS[k]}</span>
              <span className="text-[11px] font-normal whitespace-normal text-muted-foreground">{desc[k]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Section>
      <Section title="Аппаратное ускорение">
        <Row label="Вычислительное устройство" hint={sys?.hardware.cuda ? `Обнаружено: ${sys.hardware.gpu} · CUDA ${sys.hardware.cudaVersion}` : 'CUDA-совместимая видеокарта NVIDIA не обнаружена'}>
          <ToggleGroup type="single" variant="outline" disabled={e.state === 'loading'} aria-label="Вычислительное устройство" value={e.compute} onValueChange={(v) => v && api.compute(v as 'auto' | 'cpu').catch((e) => toast.error(e.message))}>
            <ToggleGroupItem value="auto" className="px-3 text-xs"><Zap className="size-3.5" /> Авто (CUDA / CPU)</ToggleGroupItem>
            <ToggleGroupItem value="cpu" className="px-3 text-xs"><Cpu className="size-3.5" /> Только CPU</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <p className="text-xs text-muted-foreground">
          Режим CPU — резервный. Замер на Ryzen 5 3600: блок 120 мс обрабатывается ~220 мс (в 2,4 раза медленнее реального времени), поэтому живой голос будет прерываться. Подходит для прослушивания примеров и проверки моделей без видеокарты.
        </p>
      </Section>
    </div>
  )
}

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggle: 'Включить / выключить преобразование',
  bypass: 'Оригинальный голос (Bypass)',
  next: 'Следующий голос',
  prev: 'Предыдущий голос',
  monitor: 'Включить / выключить мониторинг',
}

function HotkeysTab() {
  const { settings, updateSettings, status } = useStore()
  const p = status!.engine.params
  if (!settings) return null
  return (
    <div className="space-y-5">
      <Section title="Глобальные горячие клавиши" description="Работают, даже когда Vocalis свёрнут или вы в игре. Нажмите на поле и введите сочетание с Ctrl/Alt/Shift.">
        {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((a) => (
          <Row key={a} label={HOTKEY_LABELS[a]}>
            <HotkeyRecorder value={settings.hotkeys[a]} onChange={(accel) => updateSettings({ hotkeys: { ...settings.hotkeys, [a]: accel } })} />
          </Row>
        ))}
        <Separator />
        <Row label="Quick Switch только по избранным" hint="«Следующий / предыдущий голос» переключает только голоса из избранного">
          <Switch checked={settings.quickSwitchFavoritesOnly} onCheckedChange={(v) => updateSettings({ quickSwitchFavoritesOnly: v })} />
        </Row>
      </Section>
      <Section title="Push-to-Talk" description="Голос передаётся только пока клавиша удерживается. Клавиша отслеживается глобально, в том числе в играх.">
        <Row label="Включить Push-to-Talk">
          <Switch checked={p.ptt} onCheckedChange={(v) => setParam({ ptt: v })} />
        </Row>
        <Row label="Клавиша PTT" hint="Можно назначить клавишу клавиатуры или боковую кнопку мыши">
          <KeyRecorder value={p.ptt_vk} onChange={(vk) => setParam({ ptt_vk: vk })} />
        </Row>
      </Section>
    </div>
  )
}

function AppTab() {
  const { settings, updateSettings } = useStore()
  const [info, setInfo] = useState<{ version: string; dataRoot: string } | null>(null)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  useEffect(() => {
    bridge.appInfo().then(setInfo)
    api.system().then(setSys).catch(() => {})
  }, [])
  if (!settings) return null
  return (
    <div className="space-y-5">
      <Section title="Запуск и закрытие">
        <Row label="Запускать вместе с Windows" hint="Приложение стартует свёрнутым в трей">
          <Switch checked={settings.autostart} onCheckedChange={(v) => updateSettings({ autostart: v, startMinimized: v })} />
        </Row>
        <Row label="При закрытии окна сворачивать в трей" hint="Преобразование продолжит работать в фоне. Выключите, чтобы крестик завершал приложение.">
          <Switch checked={settings.closeToTray} onCheckedChange={(v) => updateSettings({ closeToTray: v })} />
        </Row>
      </Section>
      <Section title="Хранение моделей">
        <Row label="Папка данных" hint={sys?.storage.dataDir}>
          <Button variant="outline" size="sm" onClick={() => sys && bridge.openPath(sys.storage.dataDir)}><FolderOpen /> Открыть</Button>
        </Row>
        {sys && (
          <Row label="Занято на диске">
            <span className="tabular text-sm text-muted-foreground">
              голоса {formatBytes(sys.storage.voicesBytes)} · базовые модели {formatBytes(sys.storage.baseBytes)}
            </span>
          </Row>
        )}
      </Section>
      <Section title="О программе">
        <Row label="Версия"><span className="text-sm text-muted-foreground">{info?.version}</span></Row>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Движок преобразования основан на открытом коде Applio (RVC, лицензия MIT). Голосовые модели — сторонние неофициальные фан-модели; сведения об источнике и лицензии каждой модели указаны в библиотеке. Аудио обрабатывается локально и никуда не отправляется.
        </p>
        <Button variant="ghost" size="sm" onClick={() => updateSettings({ acceptedNotice: false })}>Показать предупреждение о моделях снова</Button>
      </Section>
    </div>
  )
}
