import { useEffect, useId, useRef, useState } from 'react'

type Props = {
  label: string
  value: number | null
  presets: number[]
  onCommit: (value: number | null) => void
  validate: (value: number) => string | null
  unit: string
  allowOff?: boolean
  disabled?: boolean
}

export function EditablePreset({ label, value, presets, onCommit, validate, unit, allowOff = false, disabled = false }: Props) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const wheelValueRef = useRef(value)
  const [editing, setEditing] = useState<{ value: number | null; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const draft = editing?.value === value ? editing.text : value === null ? 'Off' : String(value)

  useEffect(() => {
    wheelValueRef.current = value
    const input = inputRef.current
    if (!input || disabled) return
    const step = (event: WheelEvent) => {
      if (!event.deltaY) return
      event.preventDefault()
      const next = Number(((wheelValueRef.current ?? 0) + (event.deltaY < 0 ? 1 : -1)).toFixed(2))
      if (validate(next)) return
      wheelValueRef.current = next
      setEditing({ value: next, text: String(next) })
      setError(null)
      setOpen(false)
      onCommit(next)
    }
    input.addEventListener('wheel', step, { passive: false })
    return () => input.removeEventListener('wheel', step)
  }, [value, disabled, validate, onCommit])

  function apply(text: string) {
    const input = text.trim()
    if (allowOff && (input === '' || input.toLowerCase() === 'off')) {
      onCommit(null)
      setEditing({ value: null, text: 'Off' })
      setError(null)
      setOpen(false)
      return
    }
    const number = Number(input)
    const message = !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(input) || !Number.isFinite(number)
      ? 'Enter a valid number.' : validate(number)
    if (message) {
      setError(message)
      return
    }
    setError(null)
    setEditing({ value: number, text: String(number) })
    setOpen(false)
    onCommit(number)
  }

  return <label className="control-group editable-control">{label}
    <span className="editable-field" onBlur={(event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      setEditing(null)
      setError(null)
      setOpen(false)
    }}>
      <input ref={inputRef} aria-label={label} aria-invalid={!!error} aria-describedby={error ? `${listId}-error` : undefined}
        inputMode="decimal" value={draft} disabled={disabled}
        style={{ width: `calc(${Math.max(2, Math.min(draft.length, 12))}ch + 12px)` }}
        onChange={(event) => {
          const next = event.target.value
          setEditing({ value, text: next })
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            apply(draft)
          }
          if (event.key === 'Escape') {
            setEditing(null)
            setError(null)
            setOpen(false)
          }
        }} />
      <button type="button" className="preset-trigger" disabled={disabled} aria-label={`Show ${label} presets`}
        aria-expanded={open} onClick={() => setOpen((current) => !current)}>▾</button>
      {open && <div className="preset-menu">
        {allowOff && <button type="button" onClick={() => apply('Off')}>Off</button>}
        {presets.map((preset) => <button type="button" key={preset} onClick={() => apply(String(preset))}>
          {preset} {unit}</button>)}
      </div>}
      {error && <span className="filter-validation" id={`${listId}-error`} role="alert">{error}</span>}
    </span>
    <span className="control-unit">{unit}</span>
  </label>
}
