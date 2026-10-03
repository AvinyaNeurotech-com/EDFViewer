import { microvoltsPerUnit } from './aeeg'
import { sampleValue } from './edf'
import type { EdfHeader } from './edf'
import { FREQUENCIES, peakProminence, spectralPowers } from './spectralTrends'
import type { SpectralPair, SpectralTrendChunk } from './spectralTrends'

const CHUNK_SECONDS = 30
const WINDOW_SECONDS = 4
let advance: (() => void) | null = null
let request: AbortController | null = null

self.onmessage = async (event: MessageEvent<
  { name: string; header: EdfHeader; pairs: SpectralPair[]; start: number } | { type: 'continue' | 'pause' }>) => {
  if ('type' in event.data) {
    if (event.data.type === 'pause') {
      request?.abort()
    } else {
      advance?.()
    }
    return
  }
  const { name, header, pairs } = event.data
  const previous = [new Float64Array(FREQUENCIES).fill(NaN), new Float64Array(FREQUENCIES).fill(NaN)]
  try {
    for (let start = Math.max(0, event.data.start - CHUNK_SECONDS); start + 1 <= header.duration; start += CHUNK_SECONDS) {
      const end = Math.min(header.duration, start + CHUNK_SECONDS)
      const count = Math.floor(end) - start
      const firstRecord = Math.max(0, Math.floor((start - WINDOW_SECONDS) / header.recordDuration))
      const lastRecord = Math.min(header.recordCount - 1,
        Math.ceil((end + WINDOW_SECONDS) / header.recordDuration) - 1)
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
      if (bytes.byteLength !== byteEnd - byteStart + 1) throw new Error('Incomplete spectral trend data range')
      const view = new DataView(bytes)
      const powers = pairs.flat().map((pair) => {
        const source = header.signals[pair.source]
        const reference = header.signals[pair.reference]
        const rate = source.samplesPerRecord / header.recordDuration
        const sampleCount = Math.min(Math.round(WINDOW_SECONDS * rate), header.recordCount * source.samplesPerRecord)
        const length = 2 ** Math.ceil(Math.log2(sampleCount))
        const window = Float64Array.from({ length: sampleCount }, (_, index) =>
          0.5 - 0.5 * Math.cos(2 * Math.PI * index / (sampleCount - 1)))
        const samples = new Float64Array(sampleCount)
        const real = new Float64Array(length)
        const imaginary = new Float64Array(length)
        const multiplier = microvoltsPerUnit(source.unit)!
        return Array.from({ length: count }, (_, epoch) => {
          const center = Math.floor((start + epoch + 0.5) * rate)
          const windowStart = Math.max(0, Math.min(header.recordCount * source.samplesPerRecord - sampleCount,
            center - Math.floor(sampleCount / 2)))
          for (let index = 0; index < sampleCount; index++) {
            const sample = windowStart + index
            const record = Math.floor(sample / source.samplesPerRecord)
            const offset = (record - firstRecord) * header.recordBytes
            const position = sample % source.samplesPerRecord * header.bytesPerSample
            samples[index] = (sampleValue(view, offset + source.offset + position, header.bytesPerSample, source) -
              sampleValue(view, offset + reference.offset + position, header.bytesPerSample, reference)) * multiplier
          }
          return spectralPowers(samples, rate, window, real, imaginary)
        })
      })
      const chunk: SpectralTrendChunk = {
        start, count,
        asymmetry: new Float32Array(count * FREQUENCIES).fill(NaN),
        rhythm: [new Float32Array(count * FREQUENCIES).fill(NaN),
          new Float32Array(count * FREQUENCIES).fill(NaN)],
      }
      for (let epoch = 0; epoch < count; epoch++) {
        for (let frequency = 0; frequency < FREQUENCIES; frequency++) {
          const position = epoch * FREQUENCIES + frequency
          let asymmetry = 0
          let matched = 0
          const scores = [0, 0]
          const scoreCounts = [0, 0]
          for (let pair = 0; pair < pairs.length; pair++) {
            const left = powers[2 * pair][epoch][frequency]
            const right = powers[2 * pair + 1][epoch][frequency]
            if (!Number.isFinite(left) || !Number.isFinite(right)) continue
            asymmetry += (right - left) / (right + left + 1e-9)
            matched++
            for (let side = 0; side < 2; side++) {
              const score = peakProminence(powers[2 * pair + side][epoch], frequency)
              if (!Number.isFinite(score)) continue
              scores[side] += score
              scoreCounts[side]++
            }
          }
          if (matched) chunk.asymmetry[position] = asymmetry / matched
          for (let side = 0; side < 2; side++) {
            const score = scoreCounts[side] ? scores[side] / scoreCounts[side] : NaN
            if (Number.isFinite(score) && Number.isFinite(previous[side][frequency])) {
              chunk.rhythm[side][position] = Math.min(score, previous[side][frequency])
            }
            previous[side][frequency] = score
          }
        }
      }
      if (start >= event.data.start) self.postMessage({ type: 'chunk', chunk }, {
        transfer: [chunk.asymmetry.buffer, ...chunk.rhythm.map((values) => values.buffer)],
      })
      if (start >= event.data.start) {
        await new Promise<void>((resolve) => { advance = resolve })
        advance = null
      }
    }
    self.postMessage({ type: 'done' })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
