import { useEffect, useState } from 'react'
import { ShieldCheck, Trash2, Download, Upload, FolderOpen, Loader2, X, FileAudio, HardDrive, BookOpen, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { VoiceAvatar } from '@/components/voice-avatar'
import { stageLabel } from '@/pages/library'
import { useStore } from '@/lib/store'
import { api, type SystemInfo, type SourceRegistry } from '@/lib/api'
import { bridge } from '@/lib/bridge'
import { cn, formatBytes } from '@/lib/utils'
import { CATEGORY_LABELS, type Category, type Voice } from '@/lib/types'

export function ModelsPage() {
  const { voices, status } = useStore()
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [toDelete, setToDelete] = useState<Voice | null>(null)
  const readyCount = voices.filter((v) => v.status === 'ready').length
  useEffect(() => {
    api.system().then(setSys).catch(() => {})
  }, [readyCount])

  const base = status!.baseAssets
  const baseJob = base.job && !['done', 'error', 'cancelled'].includes(base.job.stage) ? base.job : null

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 px-8 pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Менеджер моделей</h1>
          <p className="mt-1 text-sm text-muted-foreground">Загрузка, проверка целостности, удаление и импорт моделей RVC.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setSourcesOpen(true)}><BookOpen /> Источники</Button>
          {sys && (
            <Button variant="outline" size="sm" onClick={() => bridge.openPath(sys.storage.dataDir)}>
              <FolderOpen /> Папка моделей
            </Button>
          )}
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Upload /> Импорт модели
          </Button>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 px-8 pb-8">
          <section className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <div className="text-sm font-medium">Базовые нейросети</div>
                <div className="text-xs text-muted-foreground">Извлечение признаков речи и высоты тона — общие для всех голосов.</div>
              </div>
              {base.ready ? (
                <Badge variant="outline" className="border-live/30 bg-live/10 text-live">Установлены</Badge>
              ) : (
                <Button size="sm" disabled={!!baseJob} onClick={() => api.downloadBase().catch((e) => toast.error('Не удалось начать загрузку', { description: e.message }))}>
                  {baseJob ? <Loader2 className="animate-spin" /> : <Download />} Загрузить
                </Button>
              )}
            </div>
            {baseJob && <Progress value={baseJob.progress * 100} className="h-0.5 rounded-none" />}
            <div className="divide-y">
              {base.items.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{i.title}</span>
                  <span className="tabular text-xs text-muted-foreground">{formatBytes(i.size)}</span>
                  <span className={cn('w-24 shrink-0 text-right text-xs', i.present ? 'text-live' : 'text-muted-foreground')}>{i.present ? 'Есть' : 'Не загружено'}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div className="text-sm font-medium">Голосовые модели</div>
              {sys && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <HardDrive className="size-3.5" /> {formatBytes(sys.storage.voicesBytes + sys.storage.baseBytes)} на диске
                </div>
              )}
            </div>
            <div className="divide-y">
              {voices.map((v) => (
                <ModelRow key={v.id} v={v} onDelete={() => setToDelete(v)} />
              ))}
            </div>
          </section>
        </div>
      </ScrollArea>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [overflow-wrap:anywhere]">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить модель «{toDelete?.nameRu}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.custom ? 'Импортированная модель будет удалена без возможности восстановления.' : 'Файлы будут удалены с диска. Модель можно будет загрузить снова из каталога.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                try {
                  await api.remove(toDelete!.id)
                  toast.success('Модель удалена')
                } catch (e) {
                  toast.error('Не удалось удалить', { description: (e as Error).message })
                }
                setToDelete(null)
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SourcesDialog open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </div>
  )
}

function ModelRow({ v, onDelete }: { v: Voice; onDelete: () => void }) {
  const [verifying, setVerifying] = useState(false)
  const verify = async () => {
    setVerifying(true)
    try {
      const r = await api.verify(v.id)
      if (r.ok) toast.success(`«${v.nameRu}»: файлы целы`, { description: 'Контрольные суммы SHA-256 совпадают.' })
      else toast.error(`«${v.nameRu}»: файлы повреждены`, { description: r.problems.join('\n') })
    } catch (e) {
      toast.error('Проверка не удалась', { description: (e as Error).message })
    } finally {
      setVerifying(false)
    }
  }
  const job = v.status === 'downloading' ? v.job : null
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 @min-[52rem]:grid-cols-[auto_minmax(0,1fr)_7rem_5rem_7rem]">
      <VoiceAvatar voice={v} className="size-10 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
          {v.nameRu}
          {v.custom && <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">Импорт</Badge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {v.model.title} · {v.model.format}
          {v.checkpoint && ` · ${v.checkpoint.version}, ${v.checkpoint.sampleRate / 1000} кГц, ${v.checkpoint.vocoder}`}
        </div>
        {job && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Progress value={job.progress * 100} className="h-1 w-48 max-w-full" />
            <span className="text-[11px] text-muted-foreground">{stageLabel(job.stage)}</span>
          </div>
        )}
        {v.lastError && !job && <div className="mt-1 text-xs text-destructive [overflow-wrap:anywhere]">{v.lastError}</div>}
      </div>
      <div className="col-start-2 row-start-2 text-xs @min-[52rem]:col-start-3 @min-[52rem]:row-start-1 @min-[52rem]:text-right">
        {v.status === 'ready' ? (
          <span className="text-live">Совместима</span>
        ) : v.status === 'corrupted' ? (
          <span className="text-destructive">Повреждена</span>
        ) : v.status === 'downloading' ? (
          <span className="text-muted-foreground">Загрузка</span>
        ) : (
          <span className="text-muted-foreground">Не загружена</span>
        )}
      </div>
      <div className="tabular col-start-3 row-start-2 text-right text-xs text-muted-foreground @min-[52rem]:col-start-4 @min-[52rem]:row-start-1">{formatBytes(v.status === 'ready' ? v.diskSize : v.downloadSize)}</div>
      <div className="col-start-3 row-start-1 flex justify-end gap-1 @min-[52rem]:col-start-5">
        {v.status === 'ready' || v.status === 'corrupted' ? (
          <>
            <Button variant="ghost" size="icon" className="size-8" onClick={verify} disabled={verifying} title="Проверить целостность">
              {verifying ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            </Button>
            {v.status === 'corrupted' && !v.custom && (
              <Button variant="ghost" size="icon" className="size-8" onClick={() => api.download(v.id).catch((e) => toast.error('Не удалось начать загрузку', { description: e.message }))} title="Загрузить заново">
                <Download />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" onClick={onDelete} title="Удалить">
              <Trash2 />
            </Button>
          </>
        ) : v.status === 'downloading' ? (
          <Button variant="ghost" size="icon" className="size-8" onClick={() => api.cancel(v.id).catch((e) => toast.error('Не удалось отменить загрузку', { description: e.message }))} title="Отменить">
            <X />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="size-8" onClick={() => api.download(v.id).catch((e) => toast.error(e.message))} title="Загрузить">
            <Download />
          </Button>
        )}
      </div>
    </div>
  )
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('')
  const [pth, setPth] = useState<string | null>(null)
  const [index, setIndex] = useState<string | null>(null)
  const [category, setCategory] = useState<Category>('other')
  const [busy, setBusy] = useState(false)

  const pick = async (kind: 'pth' | 'index') => {
    const p = await bridge.openFile({
      title: kind === 'pth' ? 'Файл модели RVC (.pth)' : 'Файл индекса (.index)',
      filters: [{ name: kind === 'pth' ? 'RVC model' : 'Faiss index', extensions: [kind] }],
    })
    if (!p) return
    if (kind === 'pth') {
      setPth(p)
      if (!name) setName(p.split(/[\\/]/).pop()!.replace(/\.pth$/i, '').replace(/[_-]+/g, ' '))
    } else setIndex(p)
  }

  const submit = async () => {
    setBusy(true)
    try {
      await api.importVoice({ name: name.trim(), pth: pth!, index, category })
      toast.success('Модель импортирована', { description: name })
      onOpenChange(false)
      setName('')
      setPth(null)
      setIndex(null)
    } catch (e) {
      toast.error('Импорт не удался', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Импорт модели RVC</DialogTitle>
          <DialogDescription>
            Поддерживаются модели RVC v1/v2 для инференса (.pth) и необязательный индекс (.index). Файл открывается в безопасном режиме — код из него не выполняется.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Гомер Симпсон" />
          </div>
          <FilePick label="Модель (.pth)" value={pth} onPick={() => pick('pth')} />
          <FilePick label="Индекс (.index) — необязательно" value={index} onPick={() => pick('index')} onClear={() => setIndex(null)} />
          <div className="space-y-1.5">
            <Label>Категория</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
                  <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            Загружайте модели только из источников, которым доверяете. Не используйте модели, клонирующие голоса реальных людей без их согласия.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button disabled={!pth || !name.trim() || busy} onClick={submit}>
            {busy && <Loader2 className="animate-spin" />} Импортировать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilePick({ label, value, onPick, onClear }: { label: string; value: string | null; onPick: () => void; onClear?: () => void }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      <div className="flex min-w-0 gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border bg-input/30 px-3 text-sm">
          <span title={value ?? undefined} className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>{value ?? 'Файл не выбран'}</span>
        </div>
        {value && onClear && (
          <Button variant="ghost" size="icon" className="shrink-0" onClick={onClear} aria-label="Убрать файл индекса"><X /></Button>
        )}
        <Button variant="outline" className="shrink-0" onClick={onPick}>Обзор…</Button>
      </div>
    </div>
  )
}

function SourcesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<SourceRegistry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setData(null)
    setError(null)
    api.sources().then((r) => { if (active) setData(r) }).catch((e) => { if (active) setError((e as Error).message) })
    return () => { active = false }
  }, [open, attempt])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Источники голосов</DialogTitle>
          <DialogDescription>Авторы моделей, каталоги и рекомендации по разборчивости речи. Ссылки открываются в браузере.</DialogDescription>
        </DialogHeader>
        {!data && !error && <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" /> Загружаем источники…</p>}
        {error && <div className="space-y-3 py-4" role="alert"><p className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p><Button variant="outline" onClick={() => setAttempt((v) => v + 1)}>Повторить</Button></div>}
        {data && <>
          <p className="text-xs text-muted-foreground">Проверено: {new Date(data.checkedAt).toLocaleDateString('ru-RU')}. {data.summary}</p>
          <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
            {data.sources.map((s) => <div key={s.id} className="rounded-lg border px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="text-sm font-medium">{s.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{s.kind}</p></div>
                <Button size="sm" variant="outline" onClick={() => bridge.openExternal(s.url)} aria-label={`Открыть ${s.name} в браузере`}><ExternalLink /> Открыть</Button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{s.notes}</p>
              {s.httpStatus !== 200 && <p className="mt-1 text-xs text-warn">Доступность при последней проверке не подтверждена</p>}
            </div>)}
          </div>
        </>}
      </DialogContent>
    </Dialog>
  )
}
