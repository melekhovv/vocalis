import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

const FLOOR = -70

export function dbToUnit(db: number) {
  return Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR))
}

export function LevelMeter({ label, db, gateDb, className }: { label: string; db: number; gateDb?: number; className?: string }) {
  const v = dbToUnit(db)
  const color = db > -6 ? 'bg-destructive' : db > -18 ? 'bg-warn' : 'bg-live'
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
        <span className="min-w-0 text-muted-foreground">{label}</span>
        <span className="tabular shrink-0 font-mono text-[11px] text-muted-foreground">{db <= -119 ? '−∞' : `${db.toFixed(0)} dB`}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-100', color)} style={{ width: `${v * 100}%` }} />
        {gateDb !== undefined && (
          <div className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${dbToUnit(gateDb) * 100}%` }} title="Порог Noise Gate" />
        )}
      </div>
    </div>
  )
}

/** Mirrored bar waveform of the recent level history, eased between frames. */
export function Waveform({ history, accent, active, className }: { history: number[]; accent: string; active: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const target = useRef<number[]>([])
  const shown = useRef<number[]>([])
  target.current = history

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const c = ref.current
      if (c) {
        const dpr = window.devicePixelRatio || 1
        const w = c.clientWidth
        const h = c.clientHeight
        if (c.width !== w * dpr || c.height !== h * dpr) {
          c.width = w * dpr
          c.height = h * dpr
        }
        const ctx = c.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        const bars = Math.floor(w / 6)
        const src = target.current.slice(-bars)
        while (shown.current.length < bars) shown.current.push(0)
        shown.current = shown.current.slice(-bars)
        const t = performance.now() / 1000
        for (let i = 0; i < bars; i++) {
          const raw = src[i - (bars - src.length)]
          const goal = raw === undefined ? 0 : dbToUnit(raw)
          shown.current[i] += (goal - shown.current[i]) * 0.25
          // idle shimmer keeps the visualizer alive without faking a signal
          const idle = active ? 0 : 0.03 + 0.02 * Math.sin(t * 2 + i * 0.35)
          const amp = Math.max(shown.current[i], idle)
          const bh = Math.max(2, amp * (h - 4))
          const x = i * 6 + 1
          const fade = 0.25 + 0.75 * (i / bars)
          ctx.fillStyle = active ? hexA(accent, fade) : `rgba(255,255,255,${0.12 * fade})`
          roundRect(ctx, x, (h - bh) / 2, 3, bh, 1.5)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [accent, active])

  return <canvas ref={ref} className={cn('block h-24 w-full', className)} />
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
