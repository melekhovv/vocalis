import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AudioLines, Boxes, Cpu, Library, Settings, Star, History, Loader2, TriangleAlert, Download, Globe } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { StoreProvider, useStore } from '@/lib/store'
import { bridge } from '@/lib/bridge'
import { api } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { VoiceAvatar } from '@/components/voice-avatar'
import { PreviewProvider } from '@/components/voice-preview'
import { CableSetup } from '@/components/cable-setup'
import { HomePage } from '@/pages/home'
import { LibraryPage } from '@/pages/library'
import { CatalogPage } from '@/pages/catalog'
import { ModelsPage } from '@/pages/models'
import { SettingsPage } from '@/pages/settings'
import { SystemPage } from '@/pages/system'

export type Page = 'home' | 'catalog' | 'library' | 'models' | 'settings' | 'system'

const NAV: { id: Page; label: string; icon: typeof Library }[] = [
  { id: 'home', label: 'Главная', icon: AudioLines },
  { id: 'catalog', label: 'Каталог голосов', icon: Globe },
  { id: 'library', label: 'Библиотека голосов', icon: Library },
  { id: 'models', label: 'Менеджер моделей', icon: Boxes },
  { id: 'settings', label: 'Настройки', icon: Settings },
  { id: 'system', label: 'Система', icon: Cpu },
]

export default function App() {
  return (
    <StoreProvider>
      <TooltipProvider delayDuration={300}>
        <Shell />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </StoreProvider>
  )
}

function Shell() {
  const { info, connected, status } = useStore()
  const [page, setPage] = useState<Page>('home')
  const [settingsTab, setSettingsTab] = useState('devices')
  const [pendingCableSetup, setPendingCableSetup] = useState(false)
  const engineReady = !!info && info.state === 'ready' && connected && !!status
  useEffect(() => bridge.onCableSetup((cable) => {
    // Keep an explicitly started driver operation visible when Python finishes.
    // Discovery alone never changes the user's page.
    if (!engineReady && ['downloading', 'extracting', 'verifying', 'launching', 'awaiting-restart'].includes(cable.stage)) setPendingCableSetup(true)
    else if (['installed', 'available', 'cancelled', 'error'].includes(cable.stage)) setPendingCableSetup(false)
  }), [engineReady])
  useEffect(() => {
    if (!engineReady || !pendingCableSetup) return
    setSettingsTab('virtual')
    setPage('settings')
    setPendingCableSetup(false)
  }, [engineReady, pendingCableSetup])
  const go = (p: Page, tab?: string) => {
    if (tab) setSettingsTab(tab)
    setPage(p)
  }

  if (!info || info.state !== 'ready' || !connected || !status) return <EngineGate />

  return (
    <PreviewProvider>
    <div className="flex h-full">
      <Sidebar page={page} go={go} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="drag h-10 shrink-0" />
        <BaseAssetsBanner />
        <div className="min-h-0 flex-1">
          {page === 'home' && <HomePage go={go} />}
          {page === 'catalog' && <CatalogPage go={go} />}
          {page === 'library' && <LibraryPage go={go} />}
          {page === 'models' && <ModelsPage />}
          {page === 'settings' && <SettingsPage tab={settingsTab} onTab={setSettingsTab} />}
          {page === 'system' && <SystemPage />}
        </div>
      </main>
      <RuntimeNotices go={go} />
      <NoticeDialog />
    </div>
    </PreviewProvider>
  )
}

function RuntimeNotices({ go }: { go: (p: Page, tab?: string) => void }) {
  const { status } = useStore()
  const running = status?.engine.state === 'running'
  const output = status?.engine.devices.output
  const overloaded = running && !status?.engine.params.bypass && (status?.engine.stats.realtimeFactor ?? 0) > 0.85
  const overloadNotified = useRef(false)

  useEffect(() => {
    if (!running) {
      overloadNotified.current = false
      toast.dismiss('realtime-warning')
      toast.dismiss('cable-warning')
      return
    }
    let cancelled = false
    api.devices().then((devices) => {
      if (cancelled || devices.outputs.find((d) => d.id === output)?.isVirtualCable) return
      const installed = devices.outputs.some((d) => d.isVirtualCable)
      toast.warning('Для передачи голоса в Discord и игры нужен виртуальный кабель', {
        id: 'cable-warning', duration: 10000,
        description: installed ? 'Кабель найден, но вывод направлен в другое устройство. Для локального прослушивания кабель не нужен.' : 'Установите VB-CABLE и выберите CABLE Input как вывод Vocalis. Для локального прослушивания кабель не нужен.',
        action: { label: 'Настроить', onClick: () => go('settings', 'virtual') },
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [running, output])

  useEffect(() => {
    if (!overloaded || overloadNotified.current) return
    // Ignore brief spikes during model startup; warn once per conversion session.
    const timer = setTimeout(() => {
      overloadNotified.current = true
      toast.warning('Нейросеть не успевает обрабатывать голос', {
        id: 'realtime-warning', duration: 10000,
        description: 'Возможны прерывания звука. Выберите режим «Скорость» или закройте тяжёлые приложения.',
        action: { label: 'Настройки', onClick: () => go('settings', 'performance') },
      })
    }, 3000)
    return () => clearTimeout(timer)
  }, [overloaded])
  return null
}

// Keep the component type stable across the frequent engine status updates.
// Defining it inside Sidebar remounts the button (and avatar) between mouse down
// and mouse up, losing both the loaded image and the click.
function VoiceRow({ id }: { id: string }) {
  const { voices, status, selectVoice } = useStore()
  const v = voices.find((x) => x.id === id)
  if (!v) return null
  const active = status!.engine.voiceId === id
  return (
    <button
      disabled={status!.engine.state === 'loading'}
      onClick={() => selectVoice(id)}
      aria-label={v.nameRu}
      aria-pressed={active}
      className={cn(
        'no-drag flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
        active && 'bg-accent',
      )}
    >
      <VoiceAvatar voice={v} className="size-6 rounded" />
      <span className="truncate">{v.nameRu}</span>
      {active && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
    </button>
  )
}

function Sidebar({ page, go }: { page: Page; go: (p: Page) => void }) {
  const { voices, settings, status } = useStore()
  const st = status!.engine.state
  const fav = voices.filter((v) => settings?.favorites.includes(v.id) && v.status === 'ready')
  const recent = (settings?.recent ?? []).map((id) => voices.find((v) => v.id === id)).filter((v) => v && v.status === 'ready').slice(0, 4)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar">
      <div className="drag flex h-14 items-center gap-2.5 px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <AudioLines className="size-4" strokeWidth={2.5} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">Vocalis</div>
          <div className="text-[11px] text-muted-foreground">AI Voice Changer</div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        <nav className="space-y-0.5 py-2">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => go(n.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                page === n.id && 'bg-accent text-foreground',
              )}
            >
              <n.icon className="size-4" />
              {n.label}
            </button>
          ))}
        </nav>
        <SideSection icon={Star} title="Избранное">
          {fav.length ? fav.map((v) => <VoiceRow key={v.id} id={v.id} />) : <p className="px-2 py-1 text-xs text-muted-foreground">Отметьте голоса звёздочкой в библиотеке</p>}
        </SideSection>
        <SideSection icon={History} title="Недавние">
          {recent.length ? recent.map((v) => <VoiceRow key={v!.id} id={v!.id} />) : <p className="px-2 py-1 text-xs text-muted-foreground">Пока пусто</p>}
        </SideSection>
      </ScrollArea>
      <div className="border-t p-3">
        <div className="flex items-center gap-2 rounded-md bg-card px-2.5 py-2 text-xs">
          <span
            className={cn(
              'size-2 rounded-full',
              st === 'running' ? 'bg-live shadow-[0_0_8px] shadow-live' : st === 'loading' ? 'animate-pulse bg-warn' : st === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-muted-foreground">
            {st === 'running' ? 'Преобразование активно' : st === 'loading' ? 'Загрузка модели…' : st === 'error' ? 'Ошибка' : 'Остановлено'}
          </span>
          {st === 'running' && <span className="tabular ml-auto font-mono text-muted-foreground">{Math.round(status!.engine.stats.totalLatencyMs)} мс</span>}
        </div>
      </div>
    </aside>
  )
}

function SideSection({ icon: Icon, title, children }: { icon: typeof Star; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3" />
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function BaseAssetsBanner() {
  const { status } = useStore()
  const b = status!.baseAssets
  if (b.ready) return null
  const job = b.job && !['done', 'error', 'cancelled'].includes(b.job.stage) ? b.job : null
  const total = b.items.filter((i) => !i.present).reduce((s, i) => s + i.size, 0)
  return (
    <div className="mx-6 mb-2 flex items-center gap-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
      <Download className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Нужны базовые нейросети: ContentVec и RMVPE/FCPE ({formatBytes(total)})</div>
        <div className="text-xs text-muted-foreground">Они общие для всех голосов и загружаются один раз. После этого приложение работает без интернета.</div>
        {job && <Progress value={job.progress * 100} className="mt-2 h-1" />}
        {b.job?.stage === 'error' && <div className="mt-1 text-xs text-destructive">{b.job.error}</div>}
      </div>
      <Button size="sm" disabled={!!job} onClick={() => api.downloadBase().catch((e) => toast.error(e.message))}>
        {job ? `${Math.round(job.progress * 100)}%` : 'Загрузить'}
      </Button>
    </div>
  )
}

function EngineGate() {
  const { info } = useStore()
  const [profile, setProfile] = useState<'nvidia' | 'amd' | 'laptop' | 'cpu'>('nvidia')
  const state = info?.state ?? 'starting'
  const setup = info?.setup
  const startSetup = async () => {
    try {
      await bridge.setupEngine(profile)
    } catch (e) {
      toast.error('Не удалось установить движок', { description: (e as Error).message })
    }
  }
  const profiles = [
    { id: 'nvidia' as const, title: 'NVIDIA', description: 'PyTorch с CUDA для совместимой видеокарты и драйвера NVIDIA.' },
    { id: 'amd' as const, title: 'AMD', description: 'Версия для CPU. Ускорение AMD в Windows этим движком не поддерживается.' },
    { id: 'laptop' as const, title: 'Ноутбук', description: 'Версия для CPU, без CUDA. Если есть NVIDIA, выберите профиль NVIDIA.' },
    { id: 'cpu' as const, title: 'Только CPU', description: 'Для проверки моделей и примеров. Скорость живого преобразования зависит от процессора.' },
  ]
  const stages = { preparing: 'Подготовка', downloading: 'Загрузка зависимостей', installing: 'Установка зависимостей', verifying: 'Проверка окружения', complete: 'Окружение установлено', cancelled: 'Установка отменена', error: 'Ошибка установки' }
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-10 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto p-8">
        <div className="mx-auto w-full max-w-xl space-y-5 py-4 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <AudioLines className="size-6" strokeWidth={2.5} />
          </div>
          {state === 'needs-setup' ? (
            <>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Установка аудиодвижка</h1>
                <p className="mt-2 text-sm text-muted-foreground">Выберите оборудование. Python и зависимости загрузятся один раз; преобразование голоса выполняется локально.</p>
              </div>
              <fieldset className="space-y-2 text-left">
                <legend className="mb-2 text-sm font-medium">Профиль зависимостей</legend>
                {profiles.map((item) => (
                  <label key={item.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', profile === item.id && 'border-primary bg-primary/5')}>
                    <input type="radio" name="setup-profile" value={item.id} checked={profile === item.id} onChange={() => setProfile(item.id)} className="mt-1 accent-primary" />
                    <span><span className="block text-sm font-medium">{item.title}</span><span className="block text-xs text-muted-foreground">{item.description}</span></span>
                  </label>
                ))}
              </fieldset>
              <div className="rounded-lg border bg-card p-3 text-left text-xs text-muted-foreground">
                Нужны Windows x64, доступ к интернету для установки, свободное место для Python, PyTorch и моделей (несколько ГБ), микрофон. Для Discord и игр дополнительно нужен виртуальный кабель. Установить зависимости можно без системного Python.
              </div>
              <Button size="lg" onClick={startSetup}>Установить зависимости</Button>
              {setup?.error && <p role="alert" className="text-sm text-destructive">{setup.error}</p>}
              {setup?.stage === 'cancelled' && <p role="status" className="text-sm text-muted-foreground">Установка отменена. Можно выбрать профиль и повторить.</p>}
            </>
          ) : state === 'crashed' ? (
            <>
              <div className="flex items-center justify-center gap-2 text-destructive"><TriangleAlert className="size-5" /> Аудиодвижок остановился</div>
              <Button onClick={() => bridge.restartEngine().catch((e) => toast.error(e.message))}>Перезапустить</Button>
            </>
          ) : (
            <div className="space-y-3" role="status" aria-live="polite">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {state === 'installing' && setup ? stages[setup.stage] : state === 'installing' ? 'Устанавливаем зависимости…' : 'Запускаем аудиодвижок…'}
              </div>
              {state === 'installing' && <>
                <progress aria-label="Установка зависимостей" className="h-1.5 w-full accent-primary" />
                <p className="break-words text-xs text-muted-foreground">{setup?.detail || 'Это может занять несколько минут. Ход установки отображается в журнале ниже.'}</p>
                <Button variant="outline" size="sm" onClick={() => bridge.cancelSetup().catch((e) => toast.error(e.message))}>Отменить установку</Button>
              </>}
            </div>
          )}
          {(state === 'needs-setup' || state === 'installing') && <CableSetup />}
          {!!info?.log.length && state !== 'starting' && (
            <pre className="max-h-48 overflow-auto rounded-lg border bg-card p-3 text-left font-mono text-[11px] text-muted-foreground">{info.log.slice(-20).join('\n')}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

function NoticeDialog() {
  const { settings, updateSettings } = useStore()
  if (!settings || settings.acceptedNotice) return null
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Перед началом</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>Готовые голоса не предустановлены. Каталог объединяет модели из разных источников. Язык и условия использования указаны по их метаданным; это не независимая проверка прав на голос.</p>
              <p>Перед импортом модели проверьте её источник, условия использования и необходимые права и согласие на использование голоса.</p>
              <p>Преобразование выполняется локально на вашем компьютере — аудио никуда не отправляется.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => updateSettings({ acceptedNotice: true })}>Понятно</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
