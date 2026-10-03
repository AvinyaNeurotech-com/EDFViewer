import { useLayoutEffect, useRef, useState } from 'react'

type Props = { label: string; onSave: (label: string) => void; onCancel: () => void }

export function AnnotationNameEditor({ label, onSave, onCancel }: Props) {
  const [value, setValue] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [])

  function save() {
    if (finished.current) return
    finished.current = true
    if (value.trim()) onSave(value.trim())
    else onCancel()
  }

  return <input ref={inputRef} className="annotation-name-input" aria-label="Edit annotation name"
    maxLength={80} value={value} onChange={(event) => setValue(event.target.value)}
    onBlur={save} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finished.current = true
        onCancel()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        save()
      }
    }} />
}
