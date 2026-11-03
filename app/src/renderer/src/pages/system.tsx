import { useEffect, useState } from 'react'
import { Cpu, MemoryStick, MonitorSpeaker, Activity } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { useStore } from '@/lib/store'
import { api, type SystemInfo } from '@/lib/api'
import { bridge } from '@/lib/bridge'

export function SystemPage() {
  const { status, info } = useStore()
  const [sys, setSys] = useState<SystemInfo | null>(null)
  useEffect(() => {
    api.system().then(setSys).catch(() => {})
  }, [])
  const s = status!.system
  const st = status!.engine.stats
  const running = status!.engine.state === 'running'
  const hw = sys?.hardware

  return (
    <ScrollArea className="h-full">
      <div className="max-w-4xl space-y-5 px-8 pb-10">
        <h1 className="text-2xl font-semibold tracking-tight">Система</h1>
        <div className="grid grid-cols-3 gap-4">
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
          <dl className="grid grid-cols-2 gap-x-10 gap-y-2.5 p-5 text-sm">
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
          <dl className="grid grid-cols-2 gap-x-10 gap-y-2.5 p-5 text-sm">
            <KV k="CPU" v={hw?.cpu ?? '—'} />
            <KV k="GPU" v={hw?.gpu ?? 'нет CUDA-устройства'} />
            <KV k="VRAM" v={hw?.vramGb ? `${hw.vramGb} ГБ` : '—'} />
            <KV k="PyTorch / CUDA" v={hw ? `${hw.torch ?? '—'} / ${hw.cudaVersion ?? '—'}` : '—'} />
            <KV k="Версия движка" v={status!.version} />
          </dl>
        </section>

        <section className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-5 py-3 text-sm font-medium">
            Журнал движка
            <Button variant="ghost" size="sm" onClick={() => bridge.restartEngine()}>Перезапустить движок</Button>
          </div>
          <pre className="max-h-64 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">{info?.log.join('\n') || 'Пусто'}</pre>
        </section>
      </div>
    </ScrollArea>
  )
}

function Stat({ icon: Icon, label, value, sub, progress }: { icon: typeof Cpu; label: string; value: string; sub: string; progress?: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-4" /> {label}</div>
      <div className="tabular mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={sub}>{sub}</div>
      {progress !== undefined && <Progress value={progress} className="mt-3 h-1" />}
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular truncate text-right font-mono text-xs" title={v}>{v}</dd>
    </div>
  )
}
