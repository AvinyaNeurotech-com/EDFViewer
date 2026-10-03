import { writeTrend } from './trendCache'

export function trendCheckpoint(name: string, kind: 'aeeg' | 'spectral', total: number,
  encode: () => ArrayBuffer) {
  let saved = 0
  let pending: { count: number; data: ArrayBuffer } | null = null
  let writing = false
  const interval = Math.max(30, Math.min(300, Math.ceil(total * 0.05 / 30) * 30))
  const flush = async () => {
    writing = true
    while (pending) {
      const next = pending
      pending = null
      try {
        await writeTrend(name, kind, next.data)
      } catch {
        if (saved === next.count) saved = 0
      }
    }
    writing = false
  }
  return {
    restore(count: number) { saved = count },
    save(count: number, force = false) {
      if (count <= saved || (!force && count - saved < interval)) return
      pending = { count, data: encode() }
      saved = count
      if (!writing) void flush()
    },
  }
}
