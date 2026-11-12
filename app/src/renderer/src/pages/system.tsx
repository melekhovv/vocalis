import { useEffect, useState } from 'react'
import { Cpu, MemoryStick, MonitorSpeaker, Activity, CheckCircle2, CircleAlert, Copy, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { useStore } from '@/lib/store'
import { api, type SystemInfo } from '@/lib/api'
import { bridge, type DepsInfo } from '@/lib/bridge'
import { formatBytes } from '@/lib/utils'
import type { DeviceList } from '@/lib/types'

export function SystemPage() {
  const { status, info, voices } = useStore()
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [devs, setDevs] = useState<DeviceList | null>(null)
  const [deps, setDeps] = useState<DepsInfo | null>(null)
  useEffect(() => {
    api.system().then(setSys).catch(() => {})
    api.devices().then(setDevs).catch(() => {})
    bridge.depsInfo().then(setDeps).catch(() => {})
  }, [])
  const s = status!.system
  const st = status!.engine.stats
  const e = status!.engine
  const running = e.state === 'running'
  const hw = sys?.hardware
  const readyVoices = voices.filter((v) => v.status === 'ready').length
  const cableOut = devs?.outputs.find((d) => d.isVirtualCable)
  const cableSelected = !!cableOut && e.devices.output === cableOut.id

  const buildReport = () => {
    const lines = [
      `Vocalis Diagnostics Report (${new Date().toISOString()})`,
      `Engine version: ${status!.version}`,
      `Engine state: ${e.state} (compute=${e.compute}, preset=${e.preset})`,
      `Hardware CPU: ${hw?.cpu ?? 'unknown'} (${hw?.cores ?? '?'}c/${hw?.threads ?? '?'}t, RAM ${hw?.ramGb ?? '?'} GB)`,
      `Hardware GPU: ${hw?.gpu ?? 'none'} (VRAM ${hw?.vramGb ?? 0} GB, CUDA=${hw?.cuda ? hw.cudaVersion : 'no'})`,
      `PyTorch: ${hw?.torch ?? 'unknown'}`,
      `Base assets ready: ${status!.baseAssets.ready}`,
      `Models ready: ${readyVoices} / ${voices.length}`,
      `Storage: runtime=${deps ? formatBytes(deps.runtimeBytes) : '?'}, base=${sys ? formatBytes(sys.storage.baseBytes) : '?'}, voices=${sys ? formatBytes(sys.storage.voicesBytes) : '?'}`,
      `Host API: ${devs?.hostApi ?? 'unknown'}`,
      `Virtual cable detected: ${Boolean(cableOut)} (selected=${cableSelected})`,
      `Input device id: ${e.devices.input ?? 'none'}, Output id: ${e.devices.output ?? 'none'}, Monitor id: ${e.devices.monitor ?? 'none'}`,
      `Stats: device=${st.device ?? '-'}, blockMs=${st.blockMs.toFixed(1)}, inferAvgMs=${st.inferMsAvg.toFixed(1)}, rtf=${st.realtimeFactor.toFixed(2)}, drops=${st.inputDrops}/${st.outputUnderruns}`,
      '',
      '--- Engine Log (last 60 lines) ---',
      ...(info?.log.length ? info.log : ['(empty)']),
    ]
    return lines.join('\n')
  }

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(info?.log.join('\n') || 'Пусто')
      toast.success('Журнал скопирован в буфер обмена')
    } catch {
      toast.error('Не удалось скопировать журнал')
    }
  }

  const saveReport = async () => {
    try {
      const saved = await bridge.saveDiagnostics(buildReport())
      if (saved) toast.success('Отчёт сохранён', { description: saved })
    } catch (err) {
      toast.error('Не удалось сохранить отчёт', { description: (err as Error).message })
    }
  }

  return (
    <ScrollArea className="h-full min-w-0">
      <div className="@container w-full min-w-0 space-y-5 px-8 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Система</h1>
          <Button variant="outline" size="sm" onClick={saveReport}>
            <FileDown /> Сохранить отчёт диагностики
          </Button>
        </div>

        <section className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3.5 text-sm font-medium">Готовность к работе</div>
          <div className="grid grid-cols-1 gap-3 p-5 text-sm @min-[44rem]:grid-cols-2">
            <CheckRow ok={info?.state === 'ready'} label="Python-движок запущен" />
            <CheckRow ok={status!.baseAssets.ready} label="Базовые нейросети загружены" />
            <CheckRow ok={!!hw?.cuda} warnLabel="CUDA не найдена — используется CPU" label={`GPU-ускорение (${hw?.gpu ?? 'CUDA'})`} />
            <CheckRow ok={e.devices.input !== null} label="Микрофон выбран" warnLabel="Микрофон не выбран" />
            <CheckRow ok={!!cableOut && cableSelected} label="Вывод направлен в VB-CABLE" warnLabel={cableOut ? 'Вывод не направлен в CABLE Input' : 'VB-CABLE не обнаружен'} />
            <CheckRow ok={readyVoices > 0} label={`Доступно голосов: ${readyVoices}`} warnLabel="Нет загруженных голосовых моделей" />
          </div>
        </section>
        <div className="grid min-w-0 grid-cols-1 gap-4 @min-[42rem]:grid-cols-3">
          <Stat icon={Cpu} label="Процессор" value={`${s.cpu.toFixed(0)}%`} sub={hw ? `${hw.cores} ядер / ${hw.threads} потоков` : ''} progress={s.cpu} />
          <Stat
            icon={MonitorSpeaker}
            label="Видеокарта"
            value={s.gpu ? `${s.gpu.util}%` : '—'}
            sub={s.gpu ? `${s.gpu.name} · ${(s.gpu.memUsedMb / 1024).toFixed(1)} / ${(s.gpu.memTotalMb / 1024).toFixed(1)} ГБ` : 'NVML недоступен'}
            progress={s.gpu?.util}
          />
          <Stat icon={MemoryStick} label="Память движка" value={`${(s.processRamMb / 1024).toFixed(2)} ГБ`} sub={`ОЗУ системы занято на ${s.ram.toFixed(0)}%${hw ? ` из ${hw.ramGb} ГБ` : ''}`} progress={s.ram} />
        </div>

        <section className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-5 py-3.5 text-sm font-medium"><Activity className="size-4 text-muted-foreground" /> Аудиоконвейер</div>
          <dl className="grid min-w-0 grid-cols-1 @min-[50rem]:grid-cols-2 gap-x-10 gap-y-2.5 p-5 text-sm">
            <KV k="Состояние" v={{ stopped: 'Остановлен', loading: 'Загрузка модели', running: 'Работает', error: 'Ошибка' }[status!.engine.state]} />
            <KV k="Устройство инференса" v={st.device ?? '—'} />
            <KV k="Размер блока" v={running ? `${st.blockMs.toFixed(0)} мс` : '—'} />
            <KV k="Нейросеть (среднее / последний)" v={running ? `${st.inferMsAvg.toFixed(1)} / ${st.inferMs.toFixed(1)} мс` : '—'} />
            <KV k="Загрузка реального времени" v={running ? `${(st.realtimeFactor * 100).toFixed(0)}%` : '—'} />
            <KV k="Буферы драйверов" v={running ? `${st.streamLatencyMs.toFixed(0)} мс` : '—'} />
            <KV k="Оценка общей задержки" v={running ? `${st.totalLatencyMs.toFixed(0)} мс` : '—'} />
            <KV k="Пропуски вход / выход" v={running ? `${st.inputDrops} / ${st.outputUnderruns}` : '—'} />
          </dl>
          <p className="border-t px-5 py-3 text-xs text-muted-foreground">
            Оценка задержки = блок захвата + время нейросети + буфер джиттера 50 мс + буферы WASAPI. Задержка внутри VB-CABLE и самого Discord сюда не входит.
          </p>
        </section>

        <section className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3.5 text-sm font-medium">Окружение</div>
          <dl className="grid min-w-0 grid-cols-1 @min-[50rem]:grid-cols-2 gap-x-10 gap-y-2.5 p-5 text-sm">
            <KV k="CPU" v={hw?.cpu ?? '—'} />
            <KV k="GPU" v={hw?.gpu ?? 'нет CUDA-устройства'} />
            <KV k="VRAM" v={hw?.vramGb ? `${hw.vramGb} ГБ` : '—'} />
            <KV k="PyTorch / CUDA" v={hw ? `${hw.torch ?? '—'} / ${hw.cudaVersion ?? '—'}` : '—'} />
            <KV k="Версия движка" v={status!.version} />
          </dl>
        </section>

        <section className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3 text-sm font-medium">
            Журнал движка
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={copyLogs}><Copy className="size-3.5" /> Копировать</Button>
              <Button variant="ghost" size="sm" onClick={() => bridge.restartEngine()}>Перезапустить движок</Button>
            </div>
          </div>
          <pre className="max-h-64 min-w-0 max-w-full overflow-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">{info?.log.join('\n') || 'Пусто'}</pre>
        </section>
      </div>
    </ScrollArea>
  )
}

function Stat({ icon: Icon, label, value, sub, progress }: { icon: typeof Cpu; label: string; value: string; sub: string; progress?: number }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-4" /> {label}</div>
      <div className="tabular mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={sub}>{sub}</div>
      {progress !== undefined && <Progress value={progress} className="mt-3 h-1" />}
    </div>
  )
}

function CheckRow({ ok, label, warnLabel }: { ok: boolean; label: string; warnLabel?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {ok ? <CheckCircle2 className="size-4 shrink-0 text-live" /> : <CircleAlert className="size-4 shrink-0 text-warn" />}
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{ok ? label : (warnLabel || label)}</span>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular min-w-0 break-words text-right font-mono text-xs [overflow-wrap:anywhere]" title={v}>{v}</dd>
    </div>
  )
}
