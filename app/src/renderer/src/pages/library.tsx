import { useMemo, useState } from 'react'
import { Search, Star, Download, Check, Play, Square, Loader2, X, ShieldAlert, Info } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VoiceAvatar } from '@/components/voice-avatar'
import { usePreview } from '@/components/voice-preview'
import { useStore } from '@/lib/store'
import { api } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { CATEGORY_LABELS, type Category, type Voice } from '@/lib/types'
import type { Page } from '@/App'

type Sort = 'name' | 'franchise' | 'status' | 'size'

export function LibraryPage({ go }: { go: (p: Page) => void }) {
  const { voices, settings } = useStore()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<'all' | 'fav' | Category>('all')
  const [sort, setSort] = useState<Sort>('name')

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = voices.filter((v) => {
      if (cat === 'fav' && !settings?.favorites.includes(v.id)) return false
      if (cat !== 'all' && cat !== 'fav' && v.category !== cat) return false
      if (!needle) return true
      return [v.name, v.nameRu, v.franchise, v.description].some((s) => s.toLowerCase().includes(needle))
    })
    const rank = { ready: 0, downloading: 1, corrupted: 2, not_downloaded: 3 }
    return filtered.sort((a, b) => {
      if (sort === 'franchise') return a.franchise.localeCompare(b.franchise)
      if (sort === 'status') return rank[a.status] - rank[b.status] || a.nameRu.localeCompare(b.nameRu)
      if (sort === 'size') return (a.downloadSize ?? a.diskSize ?? 0) - (b.downloadSize ?? b.diskSize ?? 0)
      return a.nameRu.localeCompare(b.nameRu, 'ru')
    })
  }, [voices, q, cat, sort, settings?.favorites])

  const categories = (Object.keys(CATEGORY_LABELS) as Category[]).filter((c) => c === 'people' || voices.some((v) => v.category === c))

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 space-y-4 px-6 pb-4 xl:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 basis-80">
            <h1 className="text-2xl font-semibold tracking-tight">Библиотека голосов</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {voices.filter((v) => v.status === 'ready').length} из {voices.length} моделей загружено. Только русская озвучка. Нажмите ▶ на карточке, чтобы услышать пример.
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => go('models')}>Менеджер моделей</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-72">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по персонажу или франшизе" className="pl-8" />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger className="ml-auto w-44 shrink-0" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="name">По имени</SelectItem>
              <SelectItem value="franchise">По франшизе</SelectItem>
              <SelectItem value="status">Сначала загруженные</SelectItem>
              <SelectItem value="size">По размеру</SelectItem>
            </SelectContent>
          </Select>
          <Tabs className="order-last min-w-0 basis-full" value={cat} onValueChange={(v) => setCat(v as typeof cat)}>
            <TabsList className="max-w-full flex-wrap justify-start gap-1 group-data-[orientation=horizontal]/tabs:h-auto">
              <TabsTrigger className="h-8 flex-none" value="all">Все</TabsTrigger>
              <TabsTrigger className="h-8 flex-none" value="fav"><Star className="size-3.5" /> Избранное</TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger className="h-8 flex-none" key={c} value={c}>{CATEGORY_LABELS[c]}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4 px-6 pb-8 xl:px-8">
          {list.map((v) => (
            <VoiceCard key={v.id} voice={v} />
          ))}
          {!list.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">Ничего не найдено</p>}
        </div>
      </ScrollArea>
    </div>
  )
}

function VoiceCard({ voice: v }: { voice: Voice }) {
  const { settings, toggleFavorite, status, selectVoice } = useStore()
  const pv = usePreview()
  const fav = settings?.favorites.includes(v.id)
  const active = status!.engine.voiceId === v.id
  const downloading = v.status === 'downloading'
  const job = v.job

  const download = async () => {
    try {
      await api.download(v.id)
    } catch (e) {
      toast.error('Ошибка загрузки', { description: (e as Error).message })
    }
  }

  return (
    <div
      className={cn('group relative flex flex-col rounded-xl border bg-card p-4 transition-colors hover:border-foreground/15', active && 'border-primary/50')}
      style={active ? { boxShadow: `inset 0 0 0 1px ${v.accent}40` } : undefined}
    >
      <div className="flex gap-3.5">
        <VoiceAvatar voice={v} className="size-16 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{v.nameRu}</div>
              <div className="truncate text-xs text-muted-foreground">{v.franchise}</div>
            </div>
            <button
              onClick={() => toggleFavorite(v.id)}
              className={cn('-mt-0.5 -mr-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground', fav && 'text-warn hover:text-warn')}
              aria-label="В избранное"
            >
              <Star className="size-4" fill={fav ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{CATEGORY_LABELS[v.category]}</Badge>
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{v.model.format.split(' (')[0].replace(/ \d+ kHz/, '')}</Badge>
            {v.language && <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">{v.language}</Badge>}
            <StatusBadge v={v} />
          </div>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">{v.description}</p>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{v.model.title}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="size-3.5 shrink-0" />
          </TooltipTrigger>
          <TooltipContent className="max-w-80 space-y-1 text-xs leading-relaxed">
            <div><b>Источник:</b> {v.model.repo ? `huggingface.co/${v.model.repo}` : v.model.upstream}</div>
            {v.model.revision && <div><b>Ревизия:</b> {v.model.revision.slice(0, 12)}</div>}
            <div><b>Формат:</b> {v.model.format}</div>
            <div><b>Лицензия:</b> {v.model.license}</div>
            <div className="text-muted-foreground">{v.model.licenseNote}</div>
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto shrink-0 tabular">{formatBytes(v.status === 'ready' ? v.diskSize : v.downloadSize)}</span>
      </div>

      {downloading && job && (
        <div className="mt-3 space-y-1">
          <Progress value={job.progress * 100} className="h-1" />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{stageLabel(job.stage)}</span>
            <span className="tabular">{formatBytes(job.done)} / {formatBytes(job.total)}</span>
          </div>
        </div>
      )}
      {v.lastError && !downloading && <p className="mt-2 text-xs text-destructive">{v.lastError}</p>}

      <div className="mt-4 flex gap-2">
        {v.status === 'ready' ? (
          <>
            <Button className="flex-1" size="sm" variant={active ? 'secondary' : 'default'} disabled={active} onClick={() => selectVoice(v.id)}>
              {active ? <><Check /> Выбран</> : 'Выбрать голос'}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button size="sm" variant="outline" disabled={pv.converting !== null} onClick={() => pv.play(v.id)} aria-label={`Прослушать голос: ${v.nameRu}`} aria-busy={pv.converting === v.id} aria-pressed={pv.playing === v.id}>
                    {pv.converting === v.id ? <Loader2 className="animate-spin" /> : pv.playing === v.id ? <Square /> : <Play />}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{'Прослушать: «Привет! Ну что, готов к приключениям? Тогда поехали!»'}</TooltipContent>
            </Tooltip>
          </>
        ) : downloading ? (
          <Button className="flex-1" size="sm" variant="outline" onClick={() => api.cancel(v.id)}>
            <X /> Отменить
          </Button>
        ) : (
          <Button className="flex-1" size="sm" variant="secondary" onClick={download}>
            <Download /> {v.status === 'corrupted' ? 'Загрузить заново' : `Загрузить · ${formatBytes(v.downloadSize)}`}
          </Button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ v }: { v: Voice }) {
  if (v.status === 'ready')
    return <Badge className="h-5 border-live/30 bg-live/10 px-1.5 text-[10px] font-normal text-live" variant="outline">Загружен</Badge>
  if (v.status === 'corrupted')
    return (
      <Badge className="h-5 border-destructive/30 bg-destructive/10 px-1.5 text-[10px] font-normal text-destructive" variant="outline">
        <ShieldAlert className="size-3" /> Повреждён
      </Badge>
    )
  if (v.status === 'downloading') return <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">Загрузка…</Badge>
  return null
}

export function stageLabel(stage: string) {
  if (stage.startsWith('download')) return 'Загрузка…'
  if (stage.startsWith('verify')) return 'Проверка SHA-256…'
  if (stage.startsWith('retry')) return 'Соединение прервано, продолжаем…'
  if (stage === 'extract') return 'Распаковка .pth и .index…'
  if (stage === 'validate') return 'Проверка совместимости…'
  return 'В очереди…'
}
