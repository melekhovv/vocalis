export { cn } from 'cn'

export function formatBytes(n: number | null | undefined) {
  if (!n) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
