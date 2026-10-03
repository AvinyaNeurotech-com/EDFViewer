type RangeReader = (start: number, end: number, signal: AbortSignal,
  priority: 'high' | 'low') => Promise<ArrayBuffer>
type Segment = { first: number; last: number; data: Uint8Array<ArrayBuffer> }
type Pending = { first: number; last: number; controller: AbortController; promise: Promise<void> }

export class RecordCache {
  private segments: Segment[] = []
  private pending: Pending[] = []
  private retention = { first: 0, last: Infinity }
  private readonly headerBytes: number
  private readonly recordBytes: number
  private readonly readRange: RangeReader

  constructor(
    headerBytes: number,
    recordBytes: number,
    readRange: RangeReader,
  ) {
    this.headerBytes = headerBytes
    this.recordBytes = recordBytes
    this.readRange = readRange
  }

  private fetchRecords(first: number, last: number, priority: 'high' | 'low'): Pending {
    const controller = new AbortController()
    const pending: Pending = { first, last, controller, promise: Promise.resolve() }
    pending.promise = (async () => {
      try {
        const start = this.headerBytes + first * this.recordBytes
        const end = this.headerBytes + (last + 1) * this.recordBytes - 1
        const data = new Uint8Array(await this.readRange(start, end, controller.signal, priority))
        if (data.byteLength !== end - start + 1) throw new Error('Incomplete recording data')
        const keepFirst = Math.max(first, this.retention.first)
        const keepLast = Math.min(last, this.retention.last)
        if (keepFirst <= keepLast) {
          this.segments.push({ first: keepFirst, last: keepLast,
            data: keepFirst === first && keepLast === last ? data :
              data.slice((keepFirst - first) * this.recordBytes, (keepLast - first + 1) * this.recordBytes) })
          this.segments.sort((left, right) => left.first - right.first)
        }
      } finally {
        this.pending = this.pending.filter((item) => item !== pending)
      }
    })()
    this.pending.push(pending)
    return pending
  }

  async ensure(first: number, last: number, signal: AbortSignal, priority: 'high' | 'low' = 'high'): Promise<void> {
    if (first > last) throw new Error('Invalid recording range')
    let index = first
    while (index <= last) {
      if (signal.aborted) return
      const stored = this.segments.find((segment) => segment.first <= index && segment.last >= index)
      if (stored) { index = stored.last + 1; continue }
      const inFlight = this.pending.find((item) => item.first <= index && item.last >= index)
      const next = Math.min(last + 1,
        ...this.segments.filter((segment) => segment.first > index).map((segment) => segment.first),
        ...this.pending.filter((item) => item.first > index).map((item) => item.first))
      const pending = inFlight ?? this.fetchRecords(index, next - 1, priority)
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); resolve() }
        signal.addEventListener('abort', abort, { once: true })
        pending.promise.then(abort, (error: unknown) => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted || pending.controller.signal.aborted) resolve()
          else reject(error)
        })
        if (signal.aborted) abort()
      })
    }
  }

  slice(first: number, last: number): ArrayBuffer {
    const bytes = new Uint8Array((last - first + 1) * this.recordBytes)
    let index = first
    for (const segment of this.segments) {
      if (segment.last < index || segment.first > last) continue
      if (segment.first > index) throw new Error('Recording range is not cached')
      const end = Math.min(segment.last, last)
      bytes.set(segment.data.subarray((index - segment.first) * this.recordBytes,
        (end - segment.first + 1) * this.recordBytes), (index - first) * this.recordBytes)
      index = end + 1
      if (index > last) return bytes.buffer
    }
    throw new Error('Recording range is not cached')
  }

  bounds(first: number): { first: number; last: number } {
    const position = this.segments.findIndex((segment) => segment.first <= first && segment.last >= first)
    if (position < 0) throw new Error('Recording range is not cached')
    let { first: left, last: right } = this.segments[position]
    for (let index = position - 1; index >= 0 && this.segments[index].last >= left - 1; index--) {
      left = this.segments[index].first
    }
    for (let index = position + 1; index < this.segments.length && this.segments[index].first <= right + 1; index++) {
      right = Math.max(right, this.segments[index].last)
    }
    return { first: left, last: right }
  }

  trim(first: number, last: number): void {
    this.retention = { first, last }
    this.segments = this.segments.flatMap((segment) => {
      const keepFirst = Math.max(first, segment.first)
      const keepLast = Math.min(last, segment.last)
      if (keepFirst > keepLast) return []
      if (keepFirst === segment.first && keepLast === segment.last) return [segment]
      return [{ first: keepFirst, last: keepLast,
        data: segment.data.slice((keepFirst - segment.first) * this.recordBytes,
          (keepLast - segment.first + 1) * this.recordBytes) }]
    })
    for (const pending of this.pending) {
      if (pending.last < first || pending.first > last) pending.controller.abort()
    }
  }
}
