import { useEffect, useMemo, useState } from 'react'
import { aeegPairs } from './aeeg'
import type { AeegPoint } from './aeeg'
import type { EdfHeader } from './edf'
import { aeegLabels, decodeAeeg, encodeAeeg, readTrend, trendRevision } from './trendCache'
import { trendCheckpoint } from './trendCheckpoint'
import { TrendPacer } from './trendPacing'

type Snapshot = { points: AeegPoint[][]; error: string | null }

export class AeegStore {
  private snapshot: Snapshot = { points: [], error: null }
  private listeners = new Set<() => void>()

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }

  reset(count: number) {
    this.publish({ points: Array.from({ length: count }, () => []), error: null })
  }

  append(incoming: AeegPoint[][]) {
    if (!this.listeners.size) {
      this.snapshot.points.forEach((old, index) => old.push(...incoming[index]))
      return
    }
    this.publish({ ...this.snapshot,
      points: this.snapshot.points.map((old, index) => [...old, ...incoming[index]]),
    })
  }

  fail(error: string) {
    this.publish({ ...this.snapshot, error })
  }
}

export function useAeeg(name: string | null, header: EdfHeader | null, enabled: boolean, foregroundReady: boolean) {
  const pairs = useMemo(() => header ? aeegPairs(header) : [], [header])
  const [store] = useState(() => new AeegStore())
  const [pacer] = useState(() => new TrendPacer())

  useEffect(() => {
    pacer.setReady(foregroundReady)
    return () => pacer.setReady(false)
  }, [foregroundReady, pacer])

  useEffect(() => {
    store.reset(pairs.length)
    if (!enabled || !header || !name || !pairs.length) return
    const controller = new AbortController()
    let worker: Worker | null = null
    let active = true
    const labels = aeegLabels(pairs)
    let checkpoint: ReturnType<typeof trendCheckpoint> | null = null
    const start = async () => {
      let revision: string | null = null
      try {
        revision = await trendRevision(name, controller.signal)
        const cached = await readTrend(name, 'aeeg', controller.signal)
        if (cached) {
          let points: AeegPoint[][] | null = null
          try {
            points = decodeAeeg(cached, revision, labels, Math.floor(header.duration))
          } catch {
            points = null
          }
          if (points) {
            if (!active) return
            store.append(points)
            if (points[0].length === Math.floor(header.duration)) return
          }
        }
      } catch { revision = null }
      if (!active) return
      if (revision) {
        checkpoint = trendCheckpoint(name, 'aeeg', Math.floor(header.duration),
          () => encodeAeeg(store.getSnapshot().points, revision!, labels))
        checkpoint.restore(store.getSnapshot().points[0]?.length ?? 0)
      }
      worker = new Worker(new URL('./aeeg.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<
        | { type: 'chunk'; points: AeegPoint[][] }
        | { type: 'paused' }
        | { type: 'done' }
        | { type: 'error'; message: string }
      >) => {
        if (!active) return
        const message = event.data
        if (message.type === 'paused') pacer.wait(worker!)
        else if (message.type === 'error') {
          store.fail(message.message)
          pacer.clear()
          worker?.terminate()
        }
        else if (message.type === 'chunk') {
          store.append(message.points)
          checkpoint?.save(store.getSnapshot().points[0].length)
          pacer.wait(worker!)
        }
        else {
          pacer.clear()
          worker?.terminate()
          checkpoint?.save(store.getSnapshot().points[0].length, true)
        }
      }
      pacer.start(worker, { name, header, pairs, start: store.getSnapshot().points[0]?.length ?? 0 })
    }
    void start()
    return () => {
      active = false
      controller.abort()
      pacer.clear()
      worker?.terminate()
      checkpoint?.save(store.getSnapshot().points[0]?.length ?? 0, true)
    }
  }, [name, header, pairs, store, enabled, pacer])

  return { pairs, store }
}
