import { microvoltsPerUnit } from './aeeg'
import type { AeegPair } from './aeeg'
import type { EdfHeader } from './edf'
import { longitudinalMontage } from './montage'

export const FREQUENCIES = 25

export type SpectralPair = [AeegPair, AeegPair]

export function spectralPairs(header: EdfHeader): SpectralPair[] {
  const montage = longitudinalMontage(header).filter((selection): selection is AeegPair =>
    typeof selection !== 'number')
  const byLabel = new Map(montage.map((pair) => [pair.label, pair]))
  const mirrored = [
    ['FP1-F7', 'FP2-F8'], ['F7-T3', 'F8-T4'], ['T3-T5', 'T4-T6'], ['T5-O1', 'T6-O2'],
    ['FP1-F3', 'FP2-F4'], ['F3-C3', 'F4-C4'], ['C3-P3', 'C4-P4'], ['P3-O1', 'P4-O2'],
  ]
  const eligible = (pair: AeegPair) => {
    const source = header.signals[pair.source]
    const reference = header.signals[pair.reference]
    return microvoltsPerUnit(source.unit) !== null &&
      source.samplesPerRecord / header.recordDuration > 40 &&
      source.physicalMin !== source.physicalMax && reference.physicalMin !== reference.physicalMax &&
      source.digitalMin !== source.digitalMax && reference.digitalMin !== reference.digitalMax
  }
  return mirrored.flatMap(([left, right]) => {
    const leftPair = byLabel.get(left)
    const rightPair = byLabel.get(right)
    return leftPair && rightPair && eligible(leftPair) && eligible(rightPair)
      ? [[leftPair, rightPair] as SpectralPair] : []
  })
}

export type SpectralTrendChunk = {
  start: number
  count: number
  asymmetry: Float32Array
  rhythm: [Float32Array, Float32Array]
}

export function fft(real: Float64Array, imaginary: Float64Array) {
  const length = real.length
  for (let index = 1, reverse = 0; index < length; index++) {
    let bit = length >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      ;[real[index], real[reverse]] = [real[reverse], real[index]]
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const angle = -2 * Math.PI / size
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    for (let offset = 0; offset < length; offset += size) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let index = 0; index < size / 2; index++) {
        const right = offset + index + size / 2
        const rotatedReal = twiddleReal * real[right] - twiddleImaginary * imaginary[right]
        const rotatedImaginary = twiddleReal * imaginary[right] + twiddleImaginary * real[right]
        real[right] = real[offset + index] - rotatedReal
        imaginary[right] = imaginary[offset + index] - rotatedImaginary
        real[offset + index] += rotatedReal
        imaginary[offset + index] += rotatedImaginary
        ;[twiddleReal, twiddleImaginary] = [twiddleReal * cosine - twiddleImaginary * sine,
          twiddleReal * sine + twiddleImaginary * cosine]
      }
    }
  }
}

export function spectralPowers(samples: Float64Array, rate: number, window: Float64Array,
  real: Float64Array, imaginary: Float64Array): Float64Array {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
  for (let index = 0; index < samples.length; index++) real[index] = (samples[index] - mean) * window[index]
  real.fill(0, samples.length)
  imaginary.fill(0)
  fft(real, imaginary)
  const powers = new Float64Array(FREQUENCIES)
  const windowPower = window.reduce((sum, weight) => sum + weight * weight, 0)
  for (let frequency = 1; frequency <= FREQUENCIES; frequency++) {
    if (frequency + 0.5 >= rate / 2) {
      powers[frequency - 1] = NaN
      continue
    }
    const firstBin = Math.max(1, Math.ceil((frequency - 0.5) * real.length / rate))
    const lastBin = Math.min(real.length / 2 - 1, Math.ceil((frequency + 0.5) * real.length / rate) - 1)
    if (firstBin > lastBin) {
      powers[frequency - 1] = NaN
      continue
    }
    for (let bin = firstBin; bin <= lastBin; bin++) {
      powers[frequency - 1] += 2 * (real[bin] ** 2 + imaginary[bin] ** 2) / windowPower
    }
    powers[frequency - 1] /= real.length
  }
  return powers
}

export function peakProminence(powers: Float64Array, frequency: number): number {
  const background = [frequency - 3, frequency - 2, frequency + 2, frequency + 3]
    .filter((index) => index >= 0 && index < FREQUENCIES && Number.isFinite(powers[index]))
  if (background.length < 2 || !Number.isFinite(powers[frequency])) return NaN
  const average = background.reduce((sum, index) => sum + powers[index], 0) / background.length
  return Math.max(0, Math.min(1, (powers[frequency] - average) / (powers[frequency] + average + 1e-9)))
}
