import type { AeegPair, AeegPoint } from './aeeg'
import type { SpectralPair, SpectralTrendChunk } from './spectralTrends'
import { FREQUENCIES } from './spectralTrends'

type Kind = 'aeeg' | 'spectral'
type Metadata = { kind: Kind; revision: string; pairs: string[]; count: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const magic = [69, 84, 82, 49]

export function aeegLabels(pairs: AeegPair[]): string[] {
  return pairs.map((pair) => pair.label)
}

export function spectralLabels(pairs: SpectralPair[]): string[] {
  return pairs.flatMap(([left, right]) => [left.label, right.label])
}

function encode(metadata: Metadata, valueCount: number, valueAt: (index: number) => number): ArrayBuffer {
  const header = encoder.encode(JSON.stringify(metadata))
  const buffer = new ArrayBuffer(8 + header.length + valueCount * 4)
  const view = new DataView(buffer)
  magic.forEach((byte, index) => view.setUint8(index, byte))
  view.setUint32(4, header.length, true)
  new Uint8Array(buffer, 8, header.length).set(header)
  for (let index = 0; index < valueCount; index++)
    view.setFloat32(8 + header.length + index * 4, valueAt(index), true)
  return buffer
}

function decode(buffer: ArrayBuffer, kind: Kind, revision: string, pairs: string[], stride: number) {
  const view = new DataView(buffer)
  if (buffer.byteLength < 8 || magic.some((byte, index) => view.getUint8(index) !== byte))
    throw new Error('Invalid trend cache')
  const length = view.getUint32(4, true)
  if (length > 4096 || buffer.byteLength < length + 8) throw new Error('Invalid trend header')
  const metadata = JSON.parse(decoder.decode(new Uint8Array(buffer, 8, length))) as Metadata
  if (metadata.kind !== kind || metadata.revision !== revision ||
    JSON.stringify(metadata.pairs) !== JSON.stringify(pairs) ||
    !Number.isSafeInteger(metadata.count) || metadata.count < 0 ||
    buffer.byteLength !== 8 + length + metadata.count * stride * 4)
    throw new Error('Outdated trend cache')
  return { metadata, view, offset: 8 + length }
}

export function encodeAeeg(points: AeegPoint[][], revision: string, pairs: string[]): ArrayBuffer {
  const count = points[0]?.length ?? 0
  if (points.length !== pairs.length || points.some((series) => series.length !== count))
    throw new Error('Incomplete aEEG result')
  return encode({ kind: 'aeeg', revision, pairs, count }, count * pairs.length * 3, (index) => {
    const point = points[Math.floor(index / 3) % pairs.length][Math.floor(index / (pairs.length * 3))]
    return index % 3 === 0 ? point.time : index % 3 === 1 ? point.lower : point.upper
  })
}

export function decodeAeeg(buffer: ArrayBuffer, revision: string, pairs: string[], expectedCount: number): AeegPoint[][] {
  const { metadata, view, offset } = decode(buffer, 'aeeg', revision, pairs, pairs.length * 3)
  if (metadata.count > expectedCount || (metadata.count !== expectedCount && metadata.count % 30 !== 0))
    throw new Error('Invalid aEEG checkpoint')
  const points: AeegPoint[][] = pairs.map(() => [])
  for (let epoch = 0; epoch < metadata.count; epoch++) {
    for (let pair = 0; pair < pairs.length; pair++) {
      const position = offset + (epoch * pairs.length + pair) * 12
      points[pair].push({ time: view.getFloat32(position, true),
        lower: view.getFloat32(position + 4, true), upper: view.getFloat32(position + 8, true) })
    }
  }
  return points
}

export function encodeSpectral(chunks: SpectralTrendChunk[], revision: string, pairs: string[]): ArrayBuffer {
  const count = chunks.reduce((sum, chunk) => sum + chunk.count, 0)
  const epochs: { chunk: SpectralTrendChunk; epoch: number }[] = []
  for (const chunk of chunks) {
    if (chunk.asymmetry.length !== chunk.count * FREQUENCIES ||
      chunk.rhythm.some((series) => series.length !== chunk.count * FREQUENCIES))
      throw new Error('Incomplete spectral trend')
    for (let epoch = 0; epoch < chunk.count; epoch++) epochs.push({ chunk, epoch })
  }
  return encode({ kind: 'spectral', revision, pairs, count }, count * 3 * FREQUENCIES, (index) => {
    const { chunk, epoch } = epochs[Math.floor(index / (3 * FREQUENCIES))]
    const series = [chunk.asymmetry, ...chunk.rhythm][Math.floor(index / FREQUENCIES) % 3]
    return series[epoch * FREQUENCIES + index % FREQUENCIES]
  })
}

export function decodeSpectral(buffer: ArrayBuffer, revision: string, pairs: string[], expectedCount: number): SpectralTrendChunk[] {
  const { metadata, view, offset } = decode(buffer, 'spectral', revision, pairs, 3 * FREQUENCIES)
  if (metadata.count > expectedCount || (metadata.count !== expectedCount && metadata.count % 30 !== 0))
    throw new Error('Invalid spectral checkpoint')
  const chunks: SpectralTrendChunk[] = []
  for (let start = 0; start < metadata.count; start += 30) {
    const count = Math.min(30, metadata.count - start)
    const series = Array.from({ length: 3 }, () => new Float32Array(count * FREQUENCIES))
    for (let epoch = 0; epoch < count; epoch++) {
      for (let kind = 0; kind < 3; kind++) {
        for (let frequency = 0; frequency < FREQUENCIES; frequency++) {
          const index = ((start + epoch) * 3 + kind) * FREQUENCIES + frequency
          series[kind][epoch * FREQUENCIES + frequency] = view.getFloat32(offset + index * 4, true)
        }
      }
    }
    chunks.push({ start, count, asymmetry: series[0], rhythm: [series[1], series[2]] })
  }
  return chunks
}

export async function trendRevision(name: string, signal: AbortSignal): Promise<string> {
  const base = `/api/recordings/${encodeURIComponent(name)}/trends`
  const response = await fetch(`${base}/revision`, { signal, priority: 'low' })
  if (!response.ok) throw new Error('Unable to check trend cache revision')
  return (await response.json() as { revision: string }).revision
}

export async function readTrend(name: string, kind: Kind, signal: AbortSignal): Promise<ArrayBuffer | null> {
  const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/trends/${kind}`, { signal, priority: 'low' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Trend cache returned ${response.status}`)
  return response.arrayBuffer()
}

export async function writeTrend(name: string, kind: Kind, data: ArrayBuffer): Promise<void> {
  const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/trends/${kind}`, {
    method: 'PUT', body: data, headers: { 'Content-Type': 'application/octet-stream' }, priority: 'low',
  })
  if (!response.ok) throw new Error(`Unable to save ${kind} trend (${response.status})`)
}
