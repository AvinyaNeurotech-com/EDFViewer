import { decodeWindow, headerLength, parseHeader } from './edf'
import type { EdfHeader } from './edf'
import { RecordCache } from './recordCache'
import { canFilterSamples } from './signalFilters'
import type { FilterSettings } from './signalFilters'
import type { ChannelSelection } from './montage'

let header: EdfHeader | null = null
let fileUrl = ''
let controller: AbortController | null = null
let prefetchController: AbortController | null = null
let cache: RecordCache | null = null
const PREFETCH_BYTES = 2 * 1024 * 1024
const PREFETCH_THRESHOLD_BYTES = 3 * 1024 * 1024

async function readRange(start: number, end: number, signal: AbortSignal,
  priority: 'high' | 'low' = 'high'): Promise<ArrayBuffer> {
  const response = await fetch(fileUrl, { headers: { Range: `bytes=${start}-${end}` }, signal, priority })
  if (response.status !== 206) throw new Error(`Expected byte-range response (206), received ${response.status}`)
  return response.arrayBuffer()
}

self.onmessage = async (event: MessageEvent<
  | { type: 'open'; name: string; size: number }
  | { type: 'window'; start: number; duration: number; columns: number; requestId: number;
      channels: ChannelSelection[]; filters: FilterSettings }
  | { type: 'analysis'; start: number; duration: number; requestId: number }
>) => {
  if (event.data.type === 'analysis') {
    if (!header || !cache) return
    const { start, duration, requestId } = event.data
    const firstRecord = Math.max(0, Math.floor(start / header.recordDuration))
    const lastRecord = Math.min(header.recordCount - 1,
      Math.ceil((start + duration) / header.recordDuration) - 1)
    try {
      const data = cache.slice(firstRecord, lastRecord)
      self.postMessage({ type: 'analysis', requestId, firstRecord, data }, { transfer: [data] })
    } catch {}
    return
  }
  controller?.abort()
  prefetchController?.abort()
  controller = new AbortController()
  const signal = controller.signal
  try {
    if (event.data.type === 'open') {
      header = null
      cache = null
      fileUrl = `/api/recordings/${encodeURIComponent(event.data.name)}/file`
      const firstBytes = new Uint8Array(await readRange(0, 255, signal))
      const length = headerLength(firstBytes)
      if (length > event.data.size) throw new Error('EDF header exceeds file size')
      const fullHeader = new Uint8Array(await readRange(0, length - 1, signal))
      if (signal.aborted) return
      header = parseHeader(fullHeader, event.data.size)
      cache = new RecordCache(header.headerBytes, header.recordBytes, readRange)
      self.postMessage({ type: 'opened', header })
    } else if (header && cache) {
      const { start, duration, columns, requestId, channels, filters } = event.data
      const currentHeader = header
      const hasFilterableChannel = channels.some((channel) => canFilterSamples(
        currentHeader.signals[typeof channel === 'number' ? channel : channel.source].samplesPerRecord /
        currentHeader.recordDuration, filters))
      const padding = hasFilterableChannel
        ? Math.max(2, filters.highpass ? (filters.order === 4 ? 6 : 4) / filters.highpass : 0) : 0
      const first = Math.max(0, Math.floor((start - padding) / header.recordDuration))
      const last = Math.min(header.recordCount - 1,
        Math.ceil((start + duration + padding) / header.recordDuration) - 1)
      const chunkRecords = Math.max(1, Math.floor(PREFETCH_BYTES / header.recordBytes))
      const thresholdRecords = Math.ceil(PREFETCH_THRESHOLD_BYTES / header.recordBytes)
      cache.trim(Math.max(0, first - thresholdRecords - chunkRecords),
        Math.min(header.recordCount - 1, last + thresholdRecords + chunkRecords))
      await cache.ensure(first, last, signal)
      if (signal.aborted) return
      const traces = decodeWindow(header, cache.slice(first, last), first, start, duration,
        columns, channels, filters)
      self.postMessage({ type: 'window', requestId, start, duration, columns, traces }, {
        transfer: traces.flatMap((trace) => [trace.positions.buffer, trace.values.buffer] as ArrayBuffer[]),
      })
      if (signal.aborted) return
      prefetchController = new AbortController()
      const prefetchSignal = prefetchController.signal
      try {
        const bounds = cache.bounds(first)
        if (bounds.last - last < thresholdRecords && bounds.last < header.recordCount - 1) {
          await cache.ensure(bounds.last + 1, Math.min(header.recordCount - 1, bounds.last + chunkRecords),
            prefetchSignal, 'low')
        }
        if (prefetchSignal.aborted) return
        const updated = cache.bounds(first)
        if (first - updated.first < thresholdRecords && updated.first > 0) {
          await cache.ensure(Math.max(0, updated.first - chunkRecords), updated.first - 1, prefetchSignal, 'low')
        }
      } catch {}
    }
  } catch (error) {
    if (!signal.aborted && event.data.type === 'window') {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
}
