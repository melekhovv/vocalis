import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Info } from 'lucide-react'
import { api } from '@/lib/api'
import type { EngineParams } from '@/lib/types'

export function setParam(patch: Partial<EngineParams>) {
  return api.params(patch).catch((e) => { toast.error('Не удалось применить настройку', { description: e.message }); return undefined })
}

export function ParamSlider({
  label, hint, value, min, max, step, format, onCommit, disabled,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  disabled?: boolean
  onCommit: (v: number) => unknown
}) {
  const latest = useRef(value)
  latest.current = value
  const [local, setLocal] = useState(value)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) setLocal(value)
  }, [value])
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5">
          {label}
          {hint && <Hint text={hint} />}
        </span>
        <span className="tabular font-mono text-xs text-muted-foreground">{format(local)}</span>
      </div>
      <Slider
        aria-label={label}
        disabled={disabled}
        value={[local]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => {
          setDragging(true)
          setLocal(v)
        }}
        onValueCommit={async ([v]) => {
          setDragging(false)
          const result = onCommit(v)
          if (result instanceof Promise && !(await result)) setLocal(latest.current)
        }}
      />
    </div>
  )
}

export function ParamSwitch({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-1.5">
        {label}
        {hint && <Hint text={hint} />}
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
}

export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="Подсказка" className="rounded text-muted-foreground/70" onClick={(e) => e.preventDefault()}><Info className="size-3.5" /></button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  )
}
