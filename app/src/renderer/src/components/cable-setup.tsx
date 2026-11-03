import { useCallback, useEffect, useRef, useState } from 'react'
import { Cable, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { bridge } from '@/lib/bridge'
import { formatBytes } from '@/lib/utils'
import type { CableSetupInfo } from '@/lib/types'

/** Driver discovery and setup use the shell, so Python need not be installed. */
export function CableSetup() {
  const [info, setInfo] = useState<CableSetupInfo>({ stage: 'checking', detail: 'Проверяем устройства Windows…' })
  const [consent, setConsent] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const mounted = useRef(true)
  const apply = useCallback((next: CableSetupInfo) => {
    if (!mounted.current) return
    setInfo(next)
    if (next.stage !== 'available') setConsent(false)
  }, [])
  const fail = useCallback((error: unknown) => apply({ stage: 'error', detail: 'Не удалось проверить или настроить VB-CABLE.', error: error instanceof Error ? error.message : String(error) }), [apply])
  const check = useCallback(async () => {
    setConsent(false)
    setInfo({ stage: 'checking', detail: 'Проверяем устройства Windows…' })
    try { apply(await bridge.cableStatus()) } catch (error) { fail(error) }
  }, [apply, fail])

  useEffect(() => {
    mounted.current = true
    const off = bridge.onCableSetup(apply)
    check()
    return () => { mounted.current = false; off() }
  }, [apply, check])

  const start = async () => {
    if (!consent || info.stage !== 'available' || requesting) return
    setRequesting(true)
    try { apply(await bridge.setupCable()) } catch (error) { fail(error) }
    finally { if (mounted.current) setRequesting(false) }
  }
  const active = ['downloading', 'extracting', 'verifying', 'launching'].includes(info.stage)
  const canCancel = ['downloading', 'extracting', 'verifying'].includes(info.stage)
  const labels: Record<CableSetupInfo['stage'], string> = {
    checking: 'Проверка виртуального кабеля', installed: 'Виртуальный кабель уже установлен', available: 'Виртуальный кабель не найден',
    downloading: 'Загрузка VB-CABLE', extracting: 'Распаковка VB-CABLE', verifying: 'Проверка установщика',
    launching: 'Запуск установщика VB-CABLE', 'awaiting-restart': 'Установщик запущен — завершите установку',
    cancelled: 'Загрузка VB-CABLE отменена', error: 'Не удалось настроить VB-CABLE',
  }
  const total = info.total && info.total > 0 ? info.total : undefined
  const downloaded = Math.max(0, info.downloaded ?? 0)
  return (
    <section aria-label="Установка виртуального кабеля" className="space-y-3 rounded-lg border bg-card p-4 text-left">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Cable aria-hidden="true" className="size-4 text-muted-foreground" /> Виртуальный кабель · необязательно
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">VB-CABLE передаёт обработанный голос из Vocalis в Discord, Telegram и игры. Для локального прослушивания голоса в наушниках кабель не нужен.</p>
      <div role="status" aria-live="polite" className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          {info.stage === 'installed' ? <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-live" /> : (active || info.stage === 'checking') ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" /> : null}
          {labels[info.stage]}
        </div>
        <p className="break-words text-xs text-muted-foreground">{info.detail}</p>
        {info.stage === 'installed' && !!info.devices?.length && <p className="break-words text-xs text-muted-foreground">{info.devices.join(' · ')}</p>}
      </div>
      {info.stage === 'error' && info.error && <p role="alert" className="break-words text-xs text-destructive">{info.error}</p>}
      {active && <>
        <progress aria-label="Загрузка и подготовка VB-CABLE" value={info.stage === 'downloading' && total ? Math.min(downloaded, total) : undefined} max={total} className="h-1.5 w-full accent-primary" />
        {info.stage === 'downloading' && downloaded > 0 && <p className="tabular text-xs text-muted-foreground">{formatBytes(downloaded)}{total ? ` из ${formatBytes(total)}` : ' загружено'}</p>}
      </>}
      {info.stage === 'available' && <>
        <p className="text-xs leading-relaxed text-muted-foreground">По вашему выбору Vocalis скачает официальный архив VB-Audio, проверит и распакует его, затем откроет установщик. Windows запросит права администратора (UAC); нажмите Install Driver в установщике и перезагрузите компьютер. Кабель поставляется по условиям VB-Audio, donationware.</p>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" checked={consent} disabled={requesting} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-primary" />
          <span>Хочу установить VB-CABLE для Discord и игр</span>
        </label>
        <Button size="sm" disabled={!consent || requesting} onClick={start}>{requesting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ShieldAlert aria-hidden="true" />} Скачать и запустить установщик</Button>
      </>}
      {info.stage === 'awaiting-restart' && <p className="text-xs leading-relaxed text-muted-foreground">Завершите установку драйвера в отдельном окне. Подтвердите запрос UAC, нажмите Install Driver и перезагрузите Windows вручную. Запуск установщика ещё не означает, что драйвер установлен.</p>}
      {canCancel && <Button size="sm" variant="outline" onClick={() => bridge.cancelCableSetup().catch(fail)}>Отменить загрузку кабеля</Button>}
      {!active && info.stage !== 'checking' && info.stage !== 'available' && <Button size="sm" variant="outline" onClick={check}><RefreshCw aria-hidden="true" /> {info.stage === 'error' ? 'Повторить проверку' : 'Проверить кабель снова'}</Button>}
    </section>
  )
}
