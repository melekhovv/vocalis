import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Voice } from '@/lib/types'

// Character art is the lead image of the character's Wikipedia article (any
// license, since most character art is non-free) cached as a data URL, so it
// keeps working offline after the first successful load.
const CACHE_KEY = 'vocalis.avatar.v3.'
const inflight = new Map<string, Promise<string | null>>()

async function loadAvatar(title: string): Promise<string | null> {
  const key = CACHE_KEY + title
  try {
    const cached = localStorage.getItem(key)
    if (cached) return cached === 'none' ? null : cached
  } catch {
    /* storage unavailable */
  }
  if (!inflight.has(title)) {
    inflight.set(
      title,
      (async () => {
        try {
          const q = new URLSearchParams({
            action: 'query', format: 'json', origin: '*', redirects: '1',
            prop: 'pageimages', pilicense: 'any', pithumbsize: '500', titles: title, // Wikimedia only serves standard thumbnail widths
          })
          const r = await fetch(`https://en.wikipedia.org/w/api.php?${q}`)
          if (!r.ok) throw new Error()
          const j = await r.json()
          const page = Object.values(j.query?.pages ?? {})[0] as { thumbnail?: { source: string } } | undefined
          const src = page?.thumbnail?.source
          if (!src) {
            localStorage.setItem(key, 'none')
            return null
          }
          const img = await fetch(src)
          if (!img.ok) throw new Error()
          const blob = await img.blob()
          const data = await new Promise<string>((res) => {
            const fr = new FileReader()
            fr.onload = () => res(fr.result as string)
            fr.readAsDataURL(blob)
          })
          try {
            localStorage.setItem(key, data)
          } catch {
            /* quota */
          }
          return data
        } catch {
          return null // offline: fall back to the monogram, retry next launch
        }
      })(),
    )
  }
  return inflight.get(title)!
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

export function VoiceAvatar({ voice, className, ring }: { voice: Voice | null; className?: string; ring?: boolean }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    if (voice?.wikipedia) loadAvatar(voice.wikipedia).then((data) => {
      if (!cancelled) setSrc(data)
    })
    return () => { cancelled = true }
  }, [voice?.wikipedia])

  const accent = voice?.accent ?? '#71717a'
  return (
    <div
      className={cn('@container relative shrink-0 overflow-hidden rounded-lg bg-muted', className)}
      style={{
        boxShadow: ring ? `0 0 0 1px ${accent}55, 0 0 48px -8px ${accent}66` : undefined,
        background: src ? undefined : `linear-gradient(135deg, ${accent}40, ${accent}12)`,
      }}
    >
      {src ? (
        <img src={src} alt={voice?.nameRu} draggable={false} className="size-full object-cover object-top" />
      ) : (
        <div className="flex size-full items-center justify-center font-semibold tracking-tight" style={{ color: accent }}>
          <span className="text-[30cqw] leading-none">{voice ? initials(voice.name) : '?'}</span>
        </div>
      )}
    </div>
  )
}
