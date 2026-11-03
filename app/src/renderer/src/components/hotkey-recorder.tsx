import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { bridge } from '@/lib/bridge'
import { cn } from '@/lib/utils'

const CODE_MAP: Record<string, string> = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Space: 'Space', Enter: 'Enter',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp',
  PageDown: 'PageDown', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
}

function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`
  if (/^F\d{1,2}$/.test(code)) return code
  return CODE_MAP[code] ?? null
}

export function formatAccel(a: string) {
  return a ? a.split('+').join(' + ') : 'Не назначено'
}

/** Records an Electron accelerator. Existing global shortcuts are suspended while recording. */
export function HotkeyRecorder({ value, onChange }: { value: string; onChange: (accel: string) => void }) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    bridge.suspendHotkeys(true)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.code === 'Escape') return setRecording(false)
      const key = codeToKey(e.code)
      if (!key) return // modifier alone — keep waiting
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
      const isF = /^F\d+$/.test(key)
      if (!mods.length && !isF) return // global shortcuts without modifiers would hijack typing
      onChange([...mods, key].join('+'))
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      bridge.suspendHotkeys(false)
    }
  }, [recording, onChange])
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setRecording(true)}
        className={cn(
          'h-8 min-w-44 rounded-md border bg-input/30 px-3 font-mono text-xs transition-colors',
          recording && 'border-primary text-primary',
          !value && !recording && 'text-muted-foreground',
        )}
      >
        {recording ? 'Нажмите сочетание… (Esc — отмена)' : formatAccel(value)}
      </button>
      {value && !recording && (
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onChange('')}>Сбросить</Button>
      )}
    </div>
  )
}

const VK_NAMES: Record<number, string> = {
  0x05: 'Кнопка мыши 4', 0x06: 'Кнопка мыши 5', 0x14: 'Caps Lock', 0x20: 'Пробел', 0x12: 'Alt', 0x11: 'Ctrl', 0x10: 'Shift',
  0xa0: 'Левый Shift', 0xa1: 'Правый Shift', 0xa2: 'Левый Ctrl', 0xa3: 'Правый Ctrl', 0xa4: 'Левый Alt', 0xa5: 'Правый Alt', 0xc0: '`',
}

export function vkName(vk: number) {
  if (VK_NAMES[vk]) return VK_NAMES[vk]
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk)
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk)
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`
  return `VK 0x${vk.toString(16).toUpperCase()}`
}

/** Records a single key (Win32 virtual-key code) or a mouse side button for Push-to-Talk. */
export function KeyRecorder({ value, onChange }: { value: number; onChange: (vk: number) => void }) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.code === 'Escape') return setRecording(false)
      // Chromium on Windows reports the native virtual-key code in keyCode.
      const sided: Record<string, number> = { ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5 }
      onChange(sided[e.code] ?? e.keyCode)
      setRecording(false)
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault()
        onChange(e.button === 3 ? 0x05 : 0x06)
        setRecording(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [recording, onChange])
  return (
    <button
      onClick={() => setRecording(true)}
      className={cn('h-8 min-w-44 rounded-md border bg-input/30 px-3 font-mono text-xs', recording && 'border-primary text-primary')}
    >
      {recording ? 'Нажмите клавишу или кнопку мыши…' : vkName(value)}
    </button>
  )
}
