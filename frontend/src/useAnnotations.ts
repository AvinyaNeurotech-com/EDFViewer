import { useCallback, useEffect, useRef, useState } from 'react'
import type { Annotation } from './Waveform'

type Snapshot = { name: string | null; revision: string; annotations: Annotation[]; ready: boolean }
type Document = { version: 1; revision: string; annotations: Annotation[] }

export function useAnnotations(name: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ name: null, revision: '', annotations: [], ready: false })
  const [error, setError] = useState<{ name: string; message: string } | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const current = useRef(snapshot)
  const writes = useRef(new Map<string, Promise<void>>())

  useEffect(() => {
    const controller = new AbortController()
    if (!name) return () => controller.abort()
    const load = async () => {
      try {
        await writes.current.get(name)
        if (controller.signal.aborted) return
        const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/annotations`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Unable to load annotations (${response.status})`)
        const document = await response.json() as Document
        if (controller.signal.aborted) return
        current.current = { name, revision: document.revision, annotations: document.annotations, ready: true }
        setSnapshot(current.current)
        setError(null)
      } catch (reason) {
        if (!controller.signal.aborted) setError({ name, message: reason instanceof Error ? reason.message : String(reason) })
      }
    }
    void load()
    return () => controller.abort()
  }, [name, retryCount])

  const update = useCallback((change: (previous: Annotation[]) => Annotation[]) => {
    const previous = current.current
    if (!previous.ready || previous.name !== name) return
    const recordingName = previous.name
    if (!recordingName) return
    const annotations = change(previous.annotations)
    if (annotations === previous.annotations) return
    current.current = { ...previous, annotations }
    setSnapshot(current.current)
    const document: Document = { version: 1, revision: previous.revision, annotations }
    const previousWrite = writes.current.get(recordingName) ?? Promise.resolve()
    writes.current.set(recordingName, previousWrite.catch(() => {}).then(async () => {
      const response = await fetch(`/api/recordings/${encodeURIComponent(recordingName)}/annotations`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document),
      })
      if (!response.ok) throw new Error(`Unable to save annotations (${response.status})`)
      if (current.current.name === recordingName) setError(null)
    }).catch((reason: unknown) => {
      if (current.current.name === recordingName) setError({
        name: recordingName, message: reason instanceof Error ? reason.message : String(reason),
      })
    }))
  }, [name])

  return {
    annotations: snapshot.name === name ? snapshot.annotations : [],
    ready: snapshot.name === name && snapshot.ready,
    error: error?.name === name ? error.message : null,
    update,
    retry: () => setRetryCount((count) => count + 1),
  }
}
