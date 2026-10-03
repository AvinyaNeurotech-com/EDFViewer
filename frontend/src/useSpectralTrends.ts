import { useEffect, useMemo, useState } from 'react'
import type { EdfHeader } from './edf'
import { spectralPairs } from './spectralTrends'
import type { SpectralTrendChunk } from './spectralTrends'
import { decodeSpectral, encodeSpectral, readTrend, spectralLabels, trendRevision } from './trendCache'
import { trendCheckpoint } from './trendCheckpoint'
import { TrendPacer } from './trendPacing'

type Snapshot = { chunks: SpectralTrendChunk[]; error: string | null }

export class SpectralTrendStore {
  private snapshot: Snapshot = { chunks: [], error: null }
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

  reset() {
    this.publish({ chunks: [], error: null })
  }

  load(chunks: SpectralTrendChunk[]) {
    this.publish({ chunks, error: null })
  }

  append(chunk: SpectralTrendChunk) {
    if (!this.listeners.size) {
      this.snapshot.chunks.push(chunk)
      return
    }
    this.publish({ ...this.snapshot, chunks: [...this.snapshot.chunks, chunk] })
  }

  fail(error: string) {
    this.publish({ ...this.snapshot, error })
  }
}

export function useSpectralTrends(name: string | null, header: EdfHeader | null, enabled: boolean,
  foregroundReady: boolean) {
  const pairs = useMemo(() => header ? spectralPairs(header) : [], [header])
  const [store] = useState(() => new SpectralTrendStore())
  const [pacer] = useState(() => new TrendPacer())

  useEffect(() => {
    pacer.setReady(foregroundReady)
    return () => pacer.setReady(false)
  }, [foregroundReady, pacer])

  useEffect(() => {
    store.reset()
    if (!enabled || !header || !name || !pairs.length) return
    const controller = new AbortController()
    let worker: Worker | null = null
    let active = true
    const labels = spectralLabels(pairs)
    let checkpoint: ReturnType<typeof trendCheckpoint> | null = null
    const start = async () => {
      let revision: string | null = null
      try {
        revision = await trendRevision(name, controller.signal)
        const cached = await readTrend(name, 'spectral', controller.signal)
        if (cached) {
          let chunks: SpectralTrendChunk[] | null = null
          try {
            chunks = decodeSpectral(cached, revision, labels, Math.floor(header.duration))
          } catch {
            chunks = null
          }
          if (chunks) {
            if (!active) return
            store.load(chunks)
            if (chunks.reduce((sum, chunk) => sum + chunk.count, 0) === Math.floor(header.duration)) return
          }
        }
      } catch { revision = null }
      if (!active) return
      if (revision) {
        checkpoint = trendCheckpoint(name, 'spectral', Math.floor(header.duration),
          () => encodeSpectral(store.getSnapshot().chunks, revision!, labels))
        checkpoint.restore(store.getSnapshot().chunks.reduce((sum, chunk) => sum + chunk.count, 0))
      }
      worker = new Worker(new URL('./spectralTrends.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<
        | { type: 'chunk'; chunk: SpectralTrendChunk }
        | { type: 'paused' }
        | { type: 'done' }
        | { type: 'error'; message: string }
      >) => {
        if (!active) return
        if (event.data.type === 'paused') pacer.wait(worker!)
        else if (event.data.type === 'error') {
          store.fail(event.data.message)
          pacer.clear()
          worker?.terminate()
        }
        else if (event.data.type === 'chunk') {
          store.append(event.data.chunk)
          checkpoint?.save(store.getSnapshot().chunks.reduce((sum, chunk) => sum + chunk.count, 0))
          pacer.wait(worker!)
        }
        else {
          pacer.clear()
          worker?.terminate()
          checkpoint?.save(store.getSnapshot().chunks.reduce((sum, chunk) => sum + chunk.count, 0), true)
        }
      }
      pacer.start(worker, { name, header, pairs,
        start: store.getSnapshot().chunks.reduce((sum, chunk) => sum + chunk.count, 0) })
    }
    void start()
    return () => {
      active = false
      controller.abort()
      pacer.clear()
      worker?.terminate()
      checkpoint?.save(store.getSnapshot().chunks.reduce((sum, chunk) => sum + chunk.count, 0), true)
    }
  }, [name, header, pairs, store, enabled, pacer])

  return { pairs, store }
}
