import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, ExternalLink, Globe, Loader2, RefreshCw, Search, Info, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { bridge } from '@/lib/bridge'
import { useStore } from '@/lib/store'
import { CATEGORY_LABELS, type CatalogEntry, type CatalogInstallSelection, type CatalogJob, type CatalogProvider, type CatalogSearchResult, type JobInfo, type Voice } from '@/lib/types'
import { cn, formatBytes } from '@/lib/utils'
import type { Page } from '@/App'

const activeJob = (job: JobInfo | null | undefined) => !!job && !['done', 'error', 'cancelled'].includes(job.stage)
const compatibilityLabel = (value: CatalogEntry['compatibility']) => ({ unverified: 'Совместимость не проверена', 'rvc-v1': 'RVC v1', 'rvc-v2': 'RVC v2', incompatible: 'Несовместима' })[value]
function jobLabel(stage: string) {
  if (stage.startsWith('verify:')) return 'Проверка файлов'
  if (stage.startsWith('retry:')) return 'Повтор загрузки'
  return ({ queued: 'В очереди', downloading: 'Скачивание', extracting: 'Распаковка', validating: 'Проверка RVC', installing: 'Установка', done: 'Установлено', error: 'Ошибка установки', cancelled: 'Загрузка отменена' } as Record<string, string>)[stage] || 'Подготовка модели'
}
function localEntry(voice: Voice): CatalogEntry {
  return { id: voice.id, voiceId: voice.id, provider: 'local', name: voice.nameRu, description: voice.description, category: voice.category,
    language: voice.language, author: null, sourceUrl: voice.model.upstream || '', license: voice.model.license || '',
    rights: { approved: false, reason: 'Локальная модель. Источник и условия использования проверяет её владелец.' },
    compatibility: voice.compatible === false ? 'incompatible' : voice.checkpoint?.version === 'v1' ? 'rvc-v1' : voice.checkpoint ? 'rvc-v2' : 'unverified',
    size: voice.diskSize, downloads: null, installed: voice.status === 'ready', canInstall: false, job: voice.job }
}

export function CatalogPage({ go }: { go: (page: Page, tab?: string) => void }) {
  const { voices, settings, toggleFavorite, refreshVoices, status } = useStore()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [category, setCategory] = useState('all')
  const [view, setView] = useState('all')
  const [sort, setSort] = useState<'name' | 'downloads'>('name')
  const [languageOrder, setLanguageOrder] = useState('ru-first')
  const [providers, setProviders] = useState<CatalogProvider[]>([])
  const [result, setResult] = useState<CatalogSearchResult>({ items: [], providers: [], cached: false })
  const [loading, setLoading] = useState(true)
  const [searchError, setSearchError] = useState('')
  const [providerError, setProviderError] = useState('')
  const [jobError, setJobError] = useState('')
  const [revision, setRevision] = useState(0)
  const [variantLabels, setVariantLabels] = useState<Record<string, string>>({})
  const [installTargets, setInstallTargets] = useState<Record<string, string>>({})
  const [jobs, setJobs] = useState<Record<string, CatalogJob>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [favoriteMetadata, setFavoriteMetadata] = useState<CatalogEntry[]>(readFavoriteMetadata)
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const [detail, setDetail] = useState<{ key: string; entry: CatalogEntry | null; error: string; loading: boolean }>({ key: '', entry: null, error: '', loading: false })
  const [detailRevision, setDetailRevision] = useState(0)
  const [fileSelection, setFileSelection] = useState<{ key: string; value: CatalogInstallSelection | null }>({ key: '', value: null })
  const completed = useRef(new Set<string>())
  const searchQueue = useRef<Promise<void>>(Promise.resolve())
  const lastSearchAt = useRef(0)

  useEffect(() => {
    if (!settings) return
    const favorites = new Set(settings.favorites)
    setFavoriteMetadata((current) => {
      const next = new Map(current.filter((entry) => favorites.has(entry.voiceId)).map((entry) => [entry.voiceId, entry]))
      for (const entry of result.items) if (favorites.has(entry.voiceId)) next.set(entry.voiceId, snapshotEntry(entry))
      const entries = [...next.values()].slice(-100)
      try { localStorage.setItem(FAVORITE_CACHE, JSON.stringify(entries)) } catch { /* Favorites still work for this session. */ }
      return entries
    })
  }, [result.items, settings?.favorites])
  const favorite = (entry: CatalogEntry) => {
    const favoriteId = settings?.favorites.includes(entry.voiceId) ? entry.voiceId : entry.discoveryVoiceId || entry.voiceId
    if (!settings?.favorites.includes(favoriteId) && entry.provider !== 'local') {
      setFavoriteMetadata((current) => {
        const entries = [...current.filter((item) => item.voiceId !== favoriteId), snapshotEntry(entry)].slice(-100)
        try { localStorage.setItem(FAVORITE_CACHE, JSON.stringify(entries)) } catch { /* Storage may be full. */ }
        return entries
      })
    }
    toggleFavorite(favoriteId)
  }
  useEffect(() => {
    let closed = false
    api.catalogProviders().then(({ providers: items }) => { if (!closed) { setProviders(items); setProviderError('') } }).catch((error) => { if (!closed) setProviderError(error.message) })
    return () => { closed = true }
  }, [revision])
  useEffect(() => {
    let closed = false
    setLoading(true)
    setSearchError('')
    const timer = setTimeout(() => {
      // Queue the latest query behind an in-flight request and respect provider rate limits.
      searchQueue.current = searchQueue.current.catch(() => {}).then(async () => {
        if (closed) return
        const delay = Math.max(0, 1100 - (Date.now() - lastSearchAt.current))
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        if (closed) return
        lastSearchAt.current = Date.now()
        try { const data = await api.catalogSearch(query.trim(), provider, category, sort); if (!closed) setResult(data) }
        catch (error) { if (!closed) setSearchError((error as Error).message) }
        finally { if (!closed) setLoading(false) }
      })
    }, 300)
    return () => { closed = true; clearTimeout(timer) }
  }, [query, provider, category, sort, revision])
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const data = await api.catalogJobs()
        if (closed) return
        setJobs(Object.fromEntries(data.jobs.map((job) => [job.voiceId, job])))
        setJobError('')
        let refresh = false
        for (const job of data.jobs) {
          if (job.stage === 'done' && !completed.current.has(job.voiceId)) { completed.current.add(job.voiceId); refresh = true }
          if (job.stage !== 'done') completed.current.delete(job.voiceId)
        }
        if (refresh) await refreshVoices()
      } catch (error) { if (!closed) setJobError((error as Error).message) }
      finally { if (!closed) timer = setTimeout(poll, 1500) }
    }
    poll()
    return () => { closed = true; clearTimeout(timer) }
  }, [refreshVoices])
  useEffect(() => {
    if (!selected || selected.provider === 'local') return
    let closed = false
    const key = `${selected.provider}:${selected.id}`
    setDetail({ key, entry: null, error: '', loading: true })
    api.catalogDetail(selected.provider, selected.id).then((entry) => { if (!closed) setDetail({ key, entry, error: '', loading: false }) }).catch((error) => { if (!closed) setDetail({ key, entry: null, error: error.message, loading: false }) })
    return () => { closed = true }
  }, [selected?.provider, selected?.id, detailRevision])

  const providerName = (id: string) => id === 'local' ? 'Локальная библиотека' : providers.find((item) => item.id === id)?.name || id
  const enrich = (entry: CatalogEntry): CatalogEntry => {
    const sourceJobs = Object.values(jobs).filter((job) => job.provider === entry.provider && job.id === entry.id)
    const target = installTargets[`${entry.provider}:${entry.id}`] || sourceJobs.at(-1)?.voiceId || entry.voiceId
    return { ...entry, discoveryVoiceId: entry.discoveryVoiceId || entry.voiceId, voiceId: target,
      installed: (target === entry.voiceId && entry.installed) || voices.some((voice) => voice.id === target && voice.status === 'ready'), job: jobs[target] || entry.job }
  }
  const list = useMemo(() => {
    const merged = new Map<string, CatalogEntry>()
    if (view === 'favorites') for (const entry of favoriteMetadata) merged.set(entry.voiceId, entry)
    if (view === 'installed' || view === 'favorites') for (const voice of voices) merged.set(voice.id, localEntry(voice))
    for (const entry of result.items) merged.set(entry.voiceId, entry)
    const needle = query.trim().toLocaleLowerCase()
    const entries = [...new Map([...merged.values()].map(enrich).map((entry) => [entry.voiceId, entry])).values()].filter((entry) => {
      if (view === 'installed' && !entry.installed) return false
      if (view === 'favorites' && !settings?.favorites.includes(entry.discoveryVoiceId || entry.voiceId) && !settings?.favorites.includes(entry.voiceId)) return false
      if (entry.cachedMetadata) {
        if (provider !== 'all' && entry.provider !== provider) return false
        if (category !== 'all' && entry.category !== category) return false
        return !needle || [entry.name, entry.description, entry.id].some((text) => text.toLocaleLowerCase().includes(needle))
      }
      if (entry.provider !== 'local') return true // Remote provider owns search/category semantics.
      if (provider !== 'all') return false
      if (category !== 'all' && entry.category !== category) return false
      return !needle || [entry.name, entry.description, entry.author || '', entry.id].some((text) => text.toLocaleLowerCase().includes(needle))
    })
    return entries.sort((a, b) => {
      const languageRank = languageOrder === 'ru-first' ? Number(russianMetadata(b)) - Number(russianMetadata(a)) : 0
      return languageRank || (sort === 'downloads' ? (b.downloads ?? -1) - (a.downloads ?? -1) || a.name.localeCompare(b.name, 'ru') : a.name.localeCompare(b.name, 'ru'))
    })
  }, [result, view, voices, settings?.favorites, query, provider, category, sort, jobs, favoriteMetadata, languageOrder, installTargets])
  const install = async (entry: CatalogEntry, selection?: CatalogInstallSelection) => {
    if (!entry.canInstall || busy[entry.voiceId]) return
    setBusy((current) => ({ ...current, [entry.voiceId]: true }))
    try {
      const data = await api.catalogInstall(entry.provider, entry.id, selection)
      setVariantLabels((current) => ({ ...current, [data.voiceId]: selection?.archive || [selection?.pth, selection?.index].filter(Boolean).join(' · ') || entry.name }))
      setInstallTargets((current) => ({ ...current, [`${entry.provider}:${entry.id}`]: data.voiceId }))
      setJobs((current) => ({ ...current, [data.voiceId]: { ...data.job, voiceId: data.voiceId, provider: entry.provider, id: entry.id } }))
      if (data.job.stage === 'done') await refreshVoices()
    } catch (error) { toast.error('Не удалось установить голос', { description: (error as Error).message }) }
    finally { setBusy((current) => ({ ...current, [entry.voiceId]: false })) }
  }
  const cancel = async (entry: CatalogEntry) => {
    setBusy((current) => ({ ...current, [entry.voiceId]: true }))
    try { await api.catalogCancel(entry.voiceId) }
    catch (error) { toast.error('Не удалось отменить загрузку', { description: (error as Error).message }) }
    finally { setBusy((current) => ({ ...current, [entry.voiceId]: false })) }
  }
  const use = async (entry: CatalogEntry) => {
    if (status?.engine.state === 'loading') return
    setBusy((current) => ({ ...current, [entry.voiceId]: true }))
    try { await api.selectVoice(entry.voiceId); await bridge.rememberVoice(entry.voiceId); setSelected(null); go('home') }
    catch (error) { toast.error('Не удалось выбрать голос', { description: (error as Error).message }) }
    finally { setBusy((current) => ({ ...current, [entry.voiceId]: false })) }
  }
  const actions = (entry: CatalogEntry, detailMode = false) => {
    const selectionRequired = detailMode && entry.requiresSelection
    const selection = fileSelection.key === `${entry.provider}:${entry.id}:${entry.revision || ''}` ? fileSelection.value : null
    const inspect = !detailMode && (entry.cachedMetadata || entry.requiresSelection || (entry.provider === 'huggingface' && !entry.files && !entry.canInstall))
    const actionEntry = detailMode && entry.requiresSelection ? { ...entry, installed: false, job: null } : entry
    return <CatalogActions entry={actionEntry} busy={!!busy[entry.voiceId] || (detailMode && detailLoading)} loadingVoice={status?.engine.state === 'loading'} active={status?.engine.voiceId === entry.voiceId} inspect={!!inspect} openDetails={() => { setSelected(entry); setDetailRevision(0) }} selectionMissing={!!selectionRequired && !selection} install={() => install(entry, selectionRequired ? selection || undefined : undefined)} cancel={() => cancel(entry)} use={() => use(entry)} />
  }
  const resetFilters = () => { setQuery(''); setProvider('all'); setCategory('all'); setView('all') }
  const selectedKey = selected ? `${selected.provider}:${selected.id}` : ''
  const selectedEntry = selected && enrich(detail.key === selectedKey && detail.entry ? detail.entry : selected)
  const detailLoading = selected?.provider !== 'local' && (detail.key !== selectedKey || detail.loading)

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-4 px-8 pb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h1 className="text-2xl font-semibold tracking-tight">Каталог голосов</h1><p className="mt-1 text-sm text-muted-foreground">Голоса из разных источников в одном списке. Скачивание и локальная установка RVC.</p></div>
          <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Обновить каталог</Button><Button variant="outline" size="sm" onClick={() => go('library')}>Локальная библиотека</Button></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1"><Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Поиск голосов в каталоге" placeholder="Название, автор или персонаж" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" /></div>
          <Select value={provider} onValueChange={setProvider}><SelectTrigger aria-label="Источник каталога" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Все источники</SelectItem>{providers.map((item) => <SelectItem key={item.id} value={item.id} disabled={!item.available}>{item.name}</SelectItem>)}</SelectContent></Select>
          <Select value={category} onValueChange={setCategory}><SelectTrigger aria-label="Категория голоса" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Все категории</SelectItem>{Object.entries(CATEGORY_LABELS).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select>
          <Select value={languageOrder} onValueChange={setLanguageOrder}><SelectTrigger aria-label="Приоритет языка" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ru-first">Сначала русские</SelectItem><SelectItem value="all">Любой язык</SelectItem></SelectContent></Select>
          <Select value={sort} onValueChange={(value) => setSort(value as 'name' | 'downloads')}><SelectTrigger aria-label="Сортировка каталога" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="name">По названию</SelectItem><SelectItem value="downloads">По загрузкам источника</SelectItem></SelectContent></Select>
        </div>
        <Tabs value={view} onValueChange={setView}><TabsList><TabsTrigger value="all">Все голоса</TabsTrigger><TabsTrigger value="favorites"><Star aria-hidden="true" className="size-3.5" /> Избранное</TabsTrigger><TabsTrigger value="installed">Мои голоса</TabsTrigger></TabsList></Tabs>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div className="mb-4 space-y-2">
          <p className="rounded-lg border bg-card p-3 text-xs leading-relaxed text-muted-foreground">Сведения о языке и лицензии получены из метаданных источников. Это не независимая проверка прав или качества звучания. Приоритет русского языка определяется по метаданным; совместимость файлов проверяется при установке.</p>
          {provider !== 'all' && providers.find((item) => item.id === provider)?.description && <p className="text-xs leading-relaxed text-muted-foreground">{providers.find((item) => item.id === provider)?.description}</p>}
          {result.cached && <p role="status" className="text-xs text-warn">Показаны сохранённые метаданные. При восстановлении сети обновите каталог.</p>}
          {result.providers.filter((item) => item.state !== 'online').map((item) => <p key={item.id} role="status" className={cn('text-xs', item.id === 'approved' ? 'text-muted-foreground' : 'text-warn')}>{providerName(item.id)} · {item.state === 'cache' ? 'сохранённые метаданные' : 'источник недоступен'}: {item.message}</p>)}
          {(searchError || providerError) && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-warn/30 p-3 text-sm"><span className="flex-1">Не удалось обновить каталог: {searchError || providerError}. Локальные голоса доступны в разделе «Мои голоса».</span><Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}><RefreshCw aria-hidden="true" /> Повторить</Button></div>}
          {jobError && <p role="status" className="text-xs text-warn">Статусы установок временно недоступны: {jobError}. Проверяем снова автоматически.</p>}
        </div>
        <div role="status" aria-live="polite" className="mb-3 text-xs text-muted-foreground">{loading ? 'Ищем модели…' : `Найдено: ${list.length}`}</div>
        {loading && view !== 'installed' ? <div aria-label="Загрузка каталога" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">{[0, 1, 2, 3].map((key) => <div key={key} className="h-56 animate-pulse space-y-4 rounded-xl border p-4"><div className="h-10 w-10 rounded-lg bg-muted" /><div className="h-4 w-2/3 rounded bg-muted" /><div className="h-16 rounded bg-muted" /></div>)}</div> : <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">{list.map((entry) => <article key={entry.voiceId} aria-label={entry.name} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex items-start gap-3"><CatalogAvatar entry={entry} /><div className="min-w-0 flex-1"><button className="break-words text-left text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setSelected(entry); setDetailRevision(0) }}>{entry.name}</button><p className="mt-1 break-words text-xs text-muted-foreground">{providerName(entry.provider)}{entry.author ? ` · ${entry.author}` : ''}</p></div><Button variant="ghost" size="icon" aria-label={`Избранное: ${entry.name}`} aria-pressed={!!settings?.favorites.includes(entry.discoveryVoiceId || entry.voiceId) || !!settings?.favorites.includes(entry.voiceId)} onClick={() => favorite(entry)} className="size-8 shrink-0"><Star className={cn('size-4', (settings?.favorites.includes(entry.discoveryVoiceId || entry.voiceId) || settings?.favorites.includes(entry.voiceId)) && 'fill-warn text-warn')} /></Button></div>
            {entry.cachedMetadata && <p className="text-xs text-warn">Сохранённые метаданные · откройте сведения для проверки доступности</p>}
            <div className="flex flex-wrap gap-1.5"><Badge variant="secondary">{CATEGORY_LABELS[entry.category] || 'Другие'}</Badge><Badge variant="outline">{entry.language || 'Язык не указан'}</Badge>{russianMetadata(entry) && <Badge variant="secondary">Русский · по метаданным</Badge>}{entry.installed && <Badge variant="secondary"><Check aria-hidden="true" className="size-3" /> Установлено</Badge>}</div>
            <p className="line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{entry.description || 'Описание не указано источником.'}</p>
            <p className="text-xs text-muted-foreground">{compatibilityLabel(entry.compatibility)} · {entry.size === null ? 'Размер неизвестен' : formatBytes(entry.size)}</p>
            <p className="text-xs text-muted-foreground">{entry.downloads === null ? 'Нет данных о загрузках' : `${entry.downloads.toLocaleString('ru-RU')} загрузок по данным источника`}</p>
            <p className="text-xs text-muted-foreground">Лицензия источника: {entry.license || 'не указана'}</p>
            {!entry.installed && !entry.canInstall && <p className="text-xs leading-relaxed text-muted-foreground"><Info aria-hidden="true" className="mr-1 inline size-3.5" />{entry.installReason || (entry.cachedMetadata ? 'Откройте сведения для проверки доступности файлов.' : 'Откройте сведения модели для проверки файлов RVC.')}</p>}
            <div className="mt-auto space-y-2">{actions(entry)}<Button variant="ghost" size="sm" onClick={() => { setSelected(entry); setDetailRevision(0) }}>Подробнее</Button></div>
          </article>)}</div>
          {!list.length && <div className="rounded-xl border border-dashed p-8 text-center"><Globe aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground" /><h2 className="text-sm font-medium">{view === 'installed' ? 'Пока нет установленных голосов' : view === 'favorites' ? 'В этом поиске нет избранных голосов' : 'Модели не найдены'}</h2><p className="mt-2 text-sm text-muted-foreground">{view === 'installed' ? 'Установите доступную модель из каталога или импортируйте свою в менеджере моделей.' : 'Попробуйте другое название, источник или категорию. Наличие моделей зависит от метаданных источника.'}</p><div className="mt-4 flex flex-wrap justify-center gap-2"><Button variant="outline" size="sm" onClick={resetFilters}>Сбросить фильтры</Button><Button variant="ghost" size="sm" onClick={() => go('models')}>Импорт своей модели</Button></div></div>}
        </>}
      </div>
      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null) }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle className="break-words pr-6">{selected?.name}</DialogTitle><DialogDescription>Источник, совместимость и условия использования модели</DialogDescription></DialogHeader>
        {selectedEntry && <>
          {detailLoading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" /> Обновляем сведения модели…</p>}
          {detail.key === selectedKey && detail.error && <div role="alert" className="space-y-2 text-sm text-warn"><p>Не удалось обновить сведения: {detail.error}. Ниже сохранённые метаданные.</p><Button size="sm" variant="outline" onClick={() => setDetailRevision((value) => value + 1)}>Повторить проверку модели</Button></div>}
          {selectedEntry.sourceState && selectedEntry.sourceState.state !== 'online' && <p role="status" className="text-xs text-warn">Состояние источника: {selectedEntry.sourceState.message}</p>}
          <div className="flex items-center gap-3"><CatalogAvatar entry={selectedEntry} /><div className="text-sm"><div>{providerName(selectedEntry.provider)}</div><div className="text-xs text-muted-foreground">{selectedEntry.author || 'Автор не указан'}</div></div></div>
          {selectedEntry.cachedMetadata && <p role="status" className="text-xs text-warn">Сохранённые метаданные. Установка недоступна до успешного обновления сведений источника.</p>}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{selectedEntry.description || 'Источник не предоставил описание.'}</p>
          <dl className="grid grid-cols-2 gap-3 text-xs"><Detail label="Категория" value={CATEGORY_LABELS[selectedEntry.category] || 'Другие'} /><Detail label="Язык" value={selectedEntry.language || 'Не указан'} /><Detail label="Совместимость" value={compatibilityLabel(selectedEntry.compatibility)} /><Detail label="Размер" value={selectedEntry.size === null ? 'Не указан' : formatBytes(selectedEntry.size)} /><Detail label="Лицензия весов" value={selectedEntry.license || 'Не указана'} /><Detail label="Загрузки источника" value={selectedEntry.downloads === null ? 'Нет данных' : selectedEntry.downloads.toLocaleString('ru-RU')} /></dl>
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed"><p className="font-medium">{selectedEntry.provider === 'local' ? 'Условия локальной модели' : 'Сведения об условиях использования'}</p><p>{selectedEntry.rights.reason || 'Источник не предоставил сведения об условиях использования.'}</p><p>Сведения источника о лицензии не являются независимой проверкой прав на голос или исходные записи.</p>{selectedEntry.rights.verifiedAt && <p>Дата сведений: {selectedEntry.rights.verifiedAt}</p>}{selectedEntry.rights.evidenceUrl && <ExternalSource url={selectedEntry.rights.evidenceUrl} label="Сведения источника о правах" />}</div>
          {selectedEntry.sourceUrl && <ExternalSource url={selectedEntry.sourceUrl} label="Открыть источник модели" />}
          <p className="text-xs leading-relaxed text-muted-foreground">Аудиопример доступен для установленной модели в локальной библиотеке. Преобразование выполняется на вашем компьютере.</p>
          {selectedEntry.requiresSelection && Object.values(jobs).some((job) => job.provider === selectedEntry.provider && job.id === selectedEntry.id && activeJob(job)) && <section aria-label="Загрузки вариантов" className="space-y-3 rounded-lg border p-3"><h3 className="text-sm font-medium">Загрузки вариантов</h3>{Object.values(jobs).filter((job) => job.provider === selectedEntry.provider && job.id === selectedEntry.id && activeJob(job)).map((job, index) => <div key={job.voiceId} className="space-y-2"><p className="break-words text-xs text-muted-foreground">{variantLabels[job.voiceId] || `Вариант ${index + 1}`}</p><CatalogActions entry={{ ...selectedEntry, name: variantLabels[job.voiceId] || selectedEntry.name, voiceId: job.voiceId, installed: false, job }} busy={!!busy[job.voiceId]} loadingVoice={false} active={false} inspect={false} openDetails={() => {}} selectionMissing={false} install={() => {}} cancel={() => cancel({ ...selectedEntry, voiceId: job.voiceId })} use={() => {}} /></div>)}</section>}
          {!!selectedEntry.installedVariants?.length && <section aria-label="Установленные варианты" className="space-y-2 rounded-lg border p-3"><h3 className="text-sm font-medium">Установленные варианты</h3>{selectedEntry.installedVariants.map((variant) => <div key={variant.voiceId} className="space-y-1"><p className="break-words text-xs text-muted-foreground">{variant.files.join(' · ')}</p><Button size="sm" variant="outline" disabled={status?.engine.state === 'loading' || !!busy[variant.voiceId]} onClick={() => use({ ...selectedEntry, voiceId: variant.voiceId, installed: true })}>Использовать {variant.name}</Button></div>)}</section>}
          {selectedEntry.requiresSelection && selectedEntry.canInstall && <CatalogFilePicker key={`${selectedEntry.provider}:${selectedEntry.id}:${selectedEntry.revision || ''}`} entry={selectedEntry} onSelection={(value) => setFileSelection({ key: `${selectedEntry.provider}:${selectedEntry.id}:${selectedEntry.revision || ''}`, value })} />}
          {!selectedEntry.canInstall && selectedEntry.installReason && <p role="status" className="text-xs text-muted-foreground">{selectedEntry.installReason}</p>}
          {actions(selectedEntry, true)}
        </>}
      </DialogContent></Dialog>
    </div>
  )
}
function CatalogAvatar({ entry }: { entry: CatalogEntry }) {
  return <div aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-sm font-semibold text-primary">{entry.name.split(/\s+/).slice(0, 2).map((word) => [...word][0] || '').join('').toLocaleUpperCase()}</div>
}
function Detail({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words">{value}</dd></div> }
function ExternalSource({ url, label }: { url: string; label: string }) {
  if (!/^https:\/\//i.test(url)) return null
  return <Button size="sm" variant="link" className="h-auto justify-start p-0" onClick={() => bridge.openExternal(url).catch((error) => toast.error('Не удалось открыть ссылку', { description: error.message }))}><ExternalLink aria-hidden="true" /> {label}</Button>
}
function CatalogActions({ entry, busy, loadingVoice, active, inspect, openDetails, selectionMissing, install, cancel, use }: { entry: CatalogEntry; busy: boolean; loadingVoice: boolean; active: boolean; inspect: boolean; openDetails: () => void; selectionMissing: boolean; install: () => void; cancel: () => void; use: () => void }) {
  const job = entry.job
  if (activeJob(job)) return <div className="space-y-2"><div role="status" className="text-xs text-muted-foreground">{jobLabel(job!.stage)}</div><progress aria-label={`Установка: ${entry.name}`} value={job!.stage === 'downloading' && job!.total > 0 ? Math.min(job!.done, job!.total) : undefined} max={job!.total > 0 ? job!.total : undefined} className="h-1.5 w-full accent-primary" />{job!.total > 0 && job!.stage === 'downloading' && <p className="tabular text-xs text-muted-foreground">{formatBytes(job!.done)} из {formatBytes(job!.total)}</p>}<Button size="sm" variant="outline" disabled={busy} onClick={cancel}><X aria-hidden="true" /> Отменить загрузку</Button></div>
  return <div className="space-y-2">{job?.stage === 'error' && <p role="alert" className="break-words text-xs text-destructive">{job.error || 'Установка не завершена. Повторите загрузку.'}</p>}{job?.stage === 'cancelled' && <p className="text-xs text-muted-foreground">Загрузка отменена</p>}{entry.installed ? <Button size="sm" disabled={busy || loadingVoice || entry.compatibility === 'incompatible'} onClick={use}>{busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check aria-hidden="true" />} {active ? 'Голос выбран · открыть' : 'Использовать голос'}</Button> : inspect ? <Button size="sm" variant="outline" disabled={busy} onClick={openDetails}><Download aria-hidden="true" /> Проверить файлы</Button> : <Button size="sm" disabled={!entry.canInstall || busy || selectionMissing || entry.compatibility === 'incompatible'} onClick={install}>{busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />} {job?.stage === 'error' || job?.stage === 'cancelled' ? 'Повторить загрузку' : entry.canInstall ? 'Скачать и установить' : 'Скачивание недоступно'}</Button>}</div>
}

const FAVORITE_CACHE = 'vocalis.catalog.favorites.v1'
function snapshotEntry(entry: CatalogEntry): CatalogEntry {
  const text = (value: unknown, max = 1000) => typeof value === 'string' ? value.slice(0, max) : ''
  return {
    id: text(entry.id, 200), provider: text(entry.provider, 40), voiceId: text(entry.discoveryVoiceId || entry.voiceId, 100), name: text(entry.name, 200), description: text(entry.description),
    category: Object.hasOwn(CATEGORY_LABELS, entry.category) ? entry.category : 'other', language: text(entry.language, 100) || null, author: text(entry.author, 120) || null,
    sourceUrl: text(entry.sourceUrl, 1000), license: text(entry.license, 120), rights: { approved: false, reason: 'Сохранённые метаданные. Обновите сведения об условиях использования и доступности файлов у источника.' },
    compatibility: ['rvc-v1', 'rvc-v2', 'incompatible'].includes(entry.compatibility) ? entry.compatibility : 'unverified',
    size: typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
    downloads: typeof entry.downloads === 'number' && Number.isSafeInteger(entry.downloads) && entry.downloads >= 0 ? entry.downloads : null,
    installed: false, job: null, canInstall: false, cachedMetadata: true, languageConfidence: entry.languageConfidence === 'declared' ? 'declared' : 'unknown',
  }
}
function readFavoriteMetadata(): CatalogEntry[] {
  try {
    const value = localStorage.getItem(FAVORITE_CACHE)
    if (!value || value.length > 500000) return []
    const entries: unknown = JSON.parse(value)
    if (!Array.isArray(entries)) return []
    return entries.slice(-100).filter((entry) => entry && typeof entry === 'object' && ['approved', 'huggingface'].includes(entry.provider) && typeof entry.id === 'string' && typeof entry.voiceId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.voiceId)).map(snapshotEntry)
  } catch { return [] }
}

function russianMetadata(entry: CatalogEntry): boolean {
  if (entry.languageConfidence === 'unknown') return false
  return /(?:^|[\s,;])(?:ru(?:[-_]ru)?|russian|русский|русская|рус)(?:$|[\s,;])/i.test(entry.language || '')
}

function CatalogFilePicker({ entry, onSelection }: { entry: CatalogEntry; onSelection: (value: CatalogInstallSelection | null) => void }) {
  const files = entry.files || []
  const models = files.filter((file) => file.kind === 'pth')
  const indexes = files.filter((file) => file.kind === 'index')
  const archives = files.filter((file) => file.kind === 'archive')
  const [mode, setMode] = useState(models.length ? 'pth' : 'archive')
  const [pth, setPth] = useState(models.length === 1 ? models[0].path : '')
  const [index, setIndex] = useState('none')
  const [archive, setArchive] = useState(archives.length === 1 ? archives[0].path : '')
  useEffect(() => {
    onSelection(mode === 'archive' ? (archive ? { archive } : null) : (pth ? { pth, index: index === 'none' ? null : index } : null))
  }, [mode, pth, index, archive])
  return <section aria-label="Файлы модели" className="space-y-3 rounded-lg border p-3">
    <h3 className="text-sm font-medium">Выберите вариант модели</h3><p className="text-xs leading-relaxed text-muted-foreground">В источнике несколько файлов. Выберите один вариант голоса; индекс необязателен. Файлы будут загружены и проверены приложением.</p>
    {models.length > 0 && archives.length > 0 && <Select value={mode} onValueChange={setMode}><SelectTrigger aria-label="Способ установки модели"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pth">Отдельные файлы RVC</SelectItem><SelectItem value="archive">ZIP-архив</SelectItem></SelectContent></Select>}
    {mode === 'pth' ? <>
      <Select value={pth} onValueChange={setPth}><SelectTrigger aria-label="Файл модели .pth" className="w-full"><SelectValue placeholder="Выберите модель .pth" /></SelectTrigger><SelectContent>{models.map((file) => <SelectItem key={file.path} value={file.path}>{file.path} · {formatBytes(file.size)}</SelectItem>)}</SelectContent></Select>
      <Select value={index} onValueChange={setIndex}><SelectTrigger aria-label="Необязательный индекс модели"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Без индекса</SelectItem>{indexes.map((file) => <SelectItem key={file.path} value={file.path}>{file.path} · {formatBytes(file.size)}</SelectItem>)}</SelectContent></Select>
    </> : <Select value={archive} onValueChange={setArchive}><SelectTrigger aria-label="Архив модели .zip"><SelectValue placeholder="Выберите ZIP-архив" /></SelectTrigger><SelectContent>{archives.map((file) => <SelectItem key={file.path} value={file.path}>{file.path} · {formatBytes(file.size)}</SelectItem>)}</SelectContent></Select>}
  </section>
}
