import { aeegPairs } from './aeeg'
import type { AeegPoint } from './aeeg'
import type { EdfHeader } from './edf'
import { spectralPairs } from './spectralTrends'
import type { SpectralTrendChunk } from './spectralTrends'
import { aeegLabels, encodeAeeg, encodeSpectral, spectralLabels, trendRevision, writeTrend } from './trendCache'

type Result = AeegPoint[][] | SpectralTrendChunk[]

class UploadTrendTask {
  private ready = false
  private finished = false
  private wake: (() => void) | null = null
  private resolveDone!: (value: Result | null) => void
  private done: Promise<Result | null>
  private values: AeegPoint[][] | SpectralTrendChunk[]
  private worker: Worker

  constructor(worker: Worker, kind: 'aeeg' | 'spectral', header: EdfHeader) {
    this.worker = worker
    const pairs = kind === 'aeeg' ? aeegPairs(header) : spectralPairs(header)
    this.values = kind === 'aeeg' ? pairs.map(() => [] as AeegPoint[]) : []
    this.done = new Promise((resolve) => { this.resolveDone = resolve })
    worker.onmessage = (event: MessageEvent<
      | { type: 'need' | 'done' }
      | { type: 'chunk'; points: AeegPoint[][]; chunk: SpectralTrendChunk }
      | { type: 'error'; message: string }
    >) => {
      if (event.data.type === 'chunk') {
        const message = event.data
        if (kind === 'aeeg') (this.values as AeegPoint[][]).forEach((series, index) =>
          series.push(...message.points[index]))
        else (this.values as SpectralTrendChunk[]).push(message.chunk)
      } else {
        this.finished = event.data.type !== 'need'
        this.ready = event.data.type === 'need' || event.data.type === 'done'
        if (this.finished) this.resolveDone(this.ready ? this.values : null)
        this.wake?.()
        this.wake = null
      }
    }
    worker.onerror = () => {
      this.finished = true
      this.resolveDone(null)
      this.wake?.()
      this.wake = null
    }
    worker.postMessage({ type: 'upload', header, pairs, start: 0 })
  }

  private wait(): Promise<void> {
    return this.ready || this.finished ? Promise.resolve() : new Promise((resolve) => { this.wake = resolve })
  }

  async append(first: number, data: ArrayBuffer): Promise<void> {
    await this.wait()
    if (this.finished) return
    this.ready = false
    this.worker.postMessage({ type: 'data', first, data }, [data])
    await this.wait()
  }

  result(): Promise<Result | null> { return this.done }

  terminate(): void { this.worker.terminate() }
}

export function uploadTrends(header: EdfHeader) {
  const aeeg = aeegPairs(header).length
    ? new UploadTrendTask(new Worker(new URL('./aeeg.worker.ts', import.meta.url), { type: 'module' }), 'aeeg', header) : null
  const spectral = spectralPairs(header).length
    ? new UploadTrendTask(new Worker(new URL('./spectralTrends.worker.ts', import.meta.url), { type: 'module' }), 'spectral', header) : null
  return {
    async append(first: number, data: ArrayBuffer) {
      const jobs = [aeeg, spectral].filter((task): task is UploadTrendTask => task !== null)
      await Promise.all(jobs.map((task, index) => task.append(first,
        index === jobs.length - 1 ? data : data.slice(0))))
    },
    async save(name: string) {
      const [points, chunks] = await Promise.all([aeeg?.result(), spectral?.result()])
      if (!points && !chunks) return
      const revision = await trendRevision(name, new AbortController().signal)
      await Promise.allSettled([
        async () => {
          if (points && (points as AeegPoint[][])[0]?.length === Math.floor(header.duration))
            await writeTrend(name, 'aeeg', encodeAeeg(points as AeegPoint[][], revision, aeegLabels(aeegPairs(header))))
        },
        async () => {
          if (chunks && (chunks as SpectralTrendChunk[]).reduce((sum, chunk) => sum + chunk.count, 0) === Math.floor(header.duration))
            await writeTrend(name, 'spectral', encodeSpectral(chunks as SpectralTrendChunk[], revision, spectralLabels(spectralPairs(header))))
        },
      ].map((save) => save()))
    },
    terminate() { aeeg?.terminate(); spectral?.terminate() },
  }
}
