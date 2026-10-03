import type { EdfHeader } from './edf'
import { longitudinalMontage } from './montage'

export type AeegPair = { source: number; reference: number; label: string }
export type AeegPoint = { time: number; lower: number; upper: number }

export function microvoltsPerUnit(unit: string): number | null {
  const normalized = unit.trim().toLowerCase().replaceAll('µ', 'u').replaceAll('μ', 'u')
  if (normalized === 'uv') return 1
  if (normalized === 'mv') return 1000
  if (normalized === 'v') return 1_000_000
  return null
}

export function aeegPairs(header: EdfHeader): AeegPair[] {
  const pairs = longitudinalMontage(header).filter((pair): pair is AeegPair => typeof pair !== 'number')
  const candidates = [
    ['C3-P3', 'C4-P4'], ['FP1-F7', 'FP2-F8'], ['F3-C3', 'F4-C4'],
  ]
  for (const [left, right] of candidates) {
    const matched = [left, right].map((label) => pairs.find((pair) => pair.label === label))
    if (matched.every((pair) => pair !== undefined &&
      microvoltsPerUnit(header.signals[pair.source].unit) !== null &&
      header.signals[pair.source].physicalMin !== header.signals[pair.source].physicalMax &&
      header.signals[pair.reference].physicalMin !== header.signals[pair.reference].physicalMax &&
      header.signals[pair.source].digitalMin !== header.signals[pair.source].digitalMax &&
      header.signals[pair.reference].digitalMin !== header.signals[pair.reference].digitalMax &&
      header.signals[pair.source].samplesPerRecord / header.recordDuration > 40)) {
      return matched as AeegPair[]
    }
  }
  return []
}

function firKernel(rate: number, low: number, high: number, taps: number): Float64Array {
  const kernel = new Float64Array(taps)
  const midpoint = (taps - 1) / 2
  for (let index = 0; index < taps; index++) {
    const offset = index - midpoint
    const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * index / (taps - 1))
    const sinc = (frequency: number) => offset === 0 ? 2 * frequency / rate
      : Math.sin(2 * Math.PI * frequency * offset / rate) / (Math.PI * offset)
    kernel[index] = (sinc(high) - (low ? sinc(low) : 0)) * window
  }
  return kernel
}

function convolveAt(data: Float64Array, center: number, kernel: Float64Array): number {
  const middle = Math.floor(kernel.length / 2)
  let sum = 0
  for (let index = 0; index < kernel.length; index++) {
    const source = Math.max(0, Math.min(data.length - 1, center + index - middle))
    sum += data[source] * kernel[index]
  }
  return sum
}

export function aeegEpochs(samples: Float64Array, rate: number, firstSampleTime: number,
  start: number, end: number): AeegPoint[] {
  const factor = Math.max(1, Math.floor(rate / 100))
  const reducedRate = rate / factor
  const reduced = new Float64Array(Math.ceil(samples.length / factor))
  if (factor > 1) {
    const antiAlias = firKernel(rate, 0, Math.min(25, reducedRate * 0.4), 63)
    for (let index = 0; index < reduced.length; index++) {
      reduced[index] = convolveAt(samples, index * factor, antiAlias)
    }
  } else {
    reduced.set(samples)
  }
  const bandpass = firKernel(reducedRate, 2, 15, 201)
  const rectified = new Float64Array(reduced.length)
  for (let index = 0; index < rectified.length; index++) {
    rectified[index] = Math.abs(convolveAt(reduced, index, bandpass))
  }
  const radius = Math.max(1, Math.round(reducedRate / 4))
  const prefix = new Float64Array(rectified.length + 1)
  for (let index = 0; index < rectified.length; index++) prefix[index + 1] = prefix[index] + rectified[index]
  const epochs: AeegPoint[] = []
  for (let time = Math.ceil(start); time + 1 <= end; time++) {
    const first = Math.max(0, Math.ceil((time - firstSampleTime) * reducedRate))
    const last = Math.min(reduced.length, Math.ceil((time + 1 - firstSampleTime) * reducedRate))
    if (last <= first) continue
    const values: number[] = []
    for (let index = first; index < last; index++) {
      const left = Math.max(0, index - radius)
      const right = Math.min(rectified.length, index + radius + 1)
      values.push((prefix[right] - prefix[left]) / (right - left))
    }
    values.sort((left, right) => left - right)
    epochs.push({ time, lower: values[Math.floor((values.length - 1) * 0.1)],
      upper: values[Math.ceil((values.length - 1) * 0.9)] })
  }
  return epochs
}
