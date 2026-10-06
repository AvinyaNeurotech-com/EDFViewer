export class UploadTrendRecords {
  private chunks: { first: number; last: number; data: Uint8Array }[] = []
  private waiting: { first: number; last: number; resolve: (data: ArrayBuffer) => void } | null = null

  private recordBytes: number

  constructor(recordBytes: number) { this.recordBytes = recordBytes }

  private slice(first: number, last: number): ArrayBuffer | null {
    if (!this.chunks.length || this.chunks[0].first > first || this.chunks.at(-1)!.last < last) return null
    const result = new Uint8Array((last - first + 1) * this.recordBytes)
    for (const chunk of this.chunks) {
      const from = Math.max(first, chunk.first)
      const to = Math.min(last, chunk.last)
      if (from <= to) result.set(chunk.data.subarray((from - chunk.first) * this.recordBytes,
        (to - chunk.first + 1) * this.recordBytes), (from - first) * this.recordBytes)
    }
    this.chunks = this.chunks.filter((chunk) => chunk.last >= first)
    return result.buffer
  }

  read(first: number, last: number): Promise<ArrayBuffer> {
    const available = this.slice(first, last)
    if (available) return Promise.resolve(available)
    return new Promise((resolve) => {
      this.waiting = { first, last, resolve }
      self.postMessage({ type: 'need' })
    })
  }

  append(first: number, data: ArrayBuffer): void {
    this.chunks.push({ first, last: first + data.byteLength / this.recordBytes - 1,
      data: new Uint8Array(data) })
    if (!this.waiting) return
    const available = this.slice(this.waiting.first, this.waiting.last)
    if (available) {
      this.waiting.resolve(available)
      this.waiting = null
    } else self.postMessage({ type: 'need' })
  }
}
