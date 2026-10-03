import { aeegEpochs, microvoltsPerUnit } from './aeeg'
import type { AeegPair } from './aeeg'
import { sampleValue } from './edf'
import type { EdfHeader } from './edf'

const CHUNK_SECONDS = 30
const OVERLAP_SECONDS = 4
let advance: (() => void) | null = null
let request: AbortController | null = null

self.onmessage = async (event: MessageEvent<
  { name: string; header: EdfHeader; pairs: AeegPair[]; start: number } | { type: 'continue' | 'pause' }>) => {
  if ('type' in event.data) {
    if (event.data.type === 'pause') {
      request?.abort()
    } else {
      advance?.()
    }
    return
  }
  const { name, header, pairs } = event.data
  try {
    for (let start = event.data.start; start + 1 <= header.duration; start += CHUNK_SECONDS) {
      const end = Math.min(header.duration, start + CHUNK_SECONDS)
      const firstRecord = Math.max(0, Math.floor((start - OVERLAP_SECONDS) / header.recordDuration))
      const lastRecord = Math.min(header.recordCount - 1,
        Math.ceil((end + OVERLAP_SECONDS) / header.recordDuration) - 1)
      const byteStart = header.headerBytes + firstRecord * header.recordBytes
      const byteEnd = header.headerBytes + (lastRecord + 1) * header.recordBytes - 1
      request = new AbortController()
      let bytes: ArrayBuffer
      try {
        const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/file`, {
          headers: { Range: `bytes=${byteStart}-${byteEnd}` }, priority: 'low', signal: request.signal,
        })
        if (response.status !== 206) throw new Error(`Expected EDF byte-range response, got ${response.status}`)
        bytes = await response.arrayBuffer()
      } catch (error) {
        if (!request.signal.aborted) throw error
        self.postMessage({ type: 'paused' })
        await new Promise<void>((resolve) => { advance = resolve })
        advance = null
        start -= CHUNK_SECONDS
        continue
      } finally {
        request = null
      }
      if (bytes.byteLength !== byteEnd - byteStart + 1) throw new Error('Incomplete aEEG data range')
      const view = new DataView(bytes)
      const points = pairs.map((pair) => {
        const source = header.signals[pair.source]
        const reference = header.signals[pair.reference]
        const rate = source.samplesPerRecord / header.recordDuration
        const count = (lastRecord - firstRecord + 1) * source.samplesPerRecord
        const samples = new Float64Array(count)
        const multiplier = microvoltsPerUnit(source.unit)!
        for (let record = firstRecord; record <= lastRecord; record++) {
          const offset = (record - firstRecord) * header.recordBytes
          for (let index = 0; index < source.samplesPerRecord; index++) {
            const first = sampleValue(view, offset + source.offset + index * header.bytesPerSample,
              header.bytesPerSample, source)
            const second = sampleValue(view, offset + reference.offset + index * header.bytesPerSample,
              header.bytesPerSample, reference)
            samples[(record - firstRecord) * source.samplesPerRecord + index] = (first - second) * multiplier
          }
        }
        return aeegEpochs(samples, rate, firstRecord * header.recordDuration, start, end)
      })
      self.postMessage({ type: 'chunk', points })
      await new Promise<void>((resolve) => { advance = resolve })
      advance = null
    }
    self.postMessage({ type: 'done' })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
