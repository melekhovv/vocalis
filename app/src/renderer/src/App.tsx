import { useState } from 'react'
import { toast } from 'sonner'
import { AudioLines, Boxes, Cpu, Library, Settings, Star, History, Loader2, TriangleAlert, Download } from 'lucide-react'
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
import { HomePage } from '@/pages/home'
import { LibraryPage } from '@/pages/library'
import { ModelsPage } from '@/pages/models'
import { SettingsPage } from '@/pages/settings'
import { SystemPage } from '@/pages/system'

export type Page = 'home' | 'library' | 'models' | 'settings' | 'system'

const NAV: { id: Page; label: string; icon: typeof Library }[] = [
  { id: 'home', label: 'Главная', icon: AudioLines },
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
        <Toaster position="top-right" />
      </TooltipProvider>
    </StoreProvider>
  )
}

function Shell() {
  const { info, connected, status } = useStore()
  const [page, setPage] = useState<Page>('home')
  const [settingsTab, setSettingsTab] = useState('devices')
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
          {page === 'library' && <LibraryPage go={go} />}
          {page === 'models' && <ModelsPage />}
          {page === 'settings' && <SettingsPage tab={settingsTab} onTab={setSettingsTab} />}
          {page === 'system' && <SystemPage />}
        </div>
      </main>
      <NoticeDialog />
    </div>
    </PreviewProvider>
  )
}

function Sidebar({ page, go }: { page: Page; go: (p: Page) => void }) {
  const { voices, settings, status } = useStore()
  const st = status!.engine.state
  const fav = voices.filter((v) => settings?.favorites.includes(v.id) && v.status === 'ready')
  const recent = [...new Set(settings?.recent ?? [])].map((id) => voices.find((v) => v.id === id)).filter((v) => v && v.status === 'ready').slice(0, 4)

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
      <div className="shrink-0 border-t p-3">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-md bg-card px-2.5 py-2 text-xs">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              st === 'running' ? 'bg-live shadow-[0_0_8px] shadow-live' : st === 'loading' ? 'animate-pulse bg-warn' : st === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
            )}
          />
          <span className="text-muted-foreground">
            {st === 'running' ? 'Преобразование активно' : st === 'loading' ? 'Загрузка модели…' : st === 'error' ? 'Ошибка' : 'Остановлено'}
          </span>
          {st === 'running' && <span className="tabular col-start-2 font-mono text-muted-foreground">{Math.round(status!.engine.stats.totalLatencyMs)} мс</span>}
        </div>
      </div>
    </aside>
  )
}

// Defined at module scope so status updates preserve row DOM, focus and avatars.
function VoiceRow({ id }: { id: string }) {
  const { voices, status, selectVoice } = useStore()
  const v = voices.find((x) => x.id === id)!
  const active = status!.engine.voiceId === id
  return (
    <button
      onClick={() => selectVoice(id)}
      aria-pressed={active}
      title={v.nameRu}
      className={cn(
        'no-drag flex min-w-0 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
        active && 'bg-accent',
      )}
    >
      <VoiceAvatar voice={v} className="size-6 rounded" />
      <span className="min-w-0 flex-1 truncate">{v.nameRu}</span>
      {active && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />}
    </button>
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
      <Button size="sm" disabled={!!job} onClick={() => api.downloadBase().catch((e) => toast.error('Не удалось начать загрузку', { description: e.message }))}>
        {job ? `${Math.round(job.progress * 100)}%` : 'Загрузить'}
      </Button>
    </div>
  )
}

function EngineGate() {
  const { info } = useStore()
  const state = info?.state ?? 'starting'
  const busy = state === 'starting' || state === 'installing' || (state === 'ready')
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-10" />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-lg space-y-5 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <AudioLines className="size-6" strokeWidth={2.5} />
          </div>
          {state === 'needs-setup' ? (
            <>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Установка аудиодвижка</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Для нейросетевого преобразования нужен локальный движок на Python и PyTorch с поддержкой CUDA (около 4 ГБ). Установка выполняется один раз; голос пользователя никогда не отправляется в интернет. Нужны Windows x64, интернет для первой установки и свободное место для движка и моделей. NVIDIA работает через CUDA, AMD/Intel — через CPU. Для Discord и игр отдельно установите VB-CABLE (Настройки → Виртуальный микрофон).
                </p>
              </div>
              <Button size="lg" onClick={() => bridge.setupEngine()}>Установить движок</Button>
            </>
          ) : state === 'crashed' ? (
            <>
              <div className="flex items-center justify-center gap-2 text-destructive">
                <TriangleAlert className="size-5" /> Аудиодвижок остановился
              </div>
              <Button onClick={() => bridge.restartEngine()}>Перезапустить</Button>
            </>
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {state === 'installing' ? 'Устанавливаем зависимости — это может занять несколько минут…' : busy ? 'Запускаем аудиодвижок…' : ''}
            </div>
          )}
          {state === 'installing' && <div className="space-y-2 text-left" role="status" aria-live="polite">
            <Progress className="animate-pulse" aria-label="Установка зависимостей" />
            <p className="text-xs text-muted-foreground">{info?.log.at(-1) || 'Подготавливаем Python и список пакетов…'}</p>
            <p className="text-xs text-muted-foreground">Загрузка → распаковка → установка → запуск. Точный общий процент установщик пакетов не предоставляет.</p>
          </div>}
          {!!info?.log.length && (state !== 'starting') && (
            <pre className="max-h-48 overflow-auto rounded-lg border bg-card p-3 text-left font-mono text-[11px] text-muted-foreground">
              {info.log.slice(-20).join('\n')}
            </pre>
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
              <p>Голоса персонажей в библиотеке — <b className="text-foreground">неофициальные фан-модели RVC</b> с Hugging Face. Права на персонажей и их озвучку принадлежат правообладателям и актёрам.</p>
              <p>Используйте их только для личного некоммерческого развлечения и не выдавайте себя за реальных людей.</p>
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
