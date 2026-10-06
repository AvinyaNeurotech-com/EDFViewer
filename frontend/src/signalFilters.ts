import { auxiliaryKind } from './montage'
import type { ChannelSelection } from './montage'
import type { EdfHeader } from './edf'

export type FilterSettings = {
  highpass: number | null
  lowpass: number | null
  notch: number | null
  order: 2 | 4
}

export const NO_FILTERS: FilterSettings = { highpass: null, lowpass: null, notch: null, order: 2 }

export type FilterType = 'eeg' | 'ecg' | 'aux'
export type ChannelFilters = Record<FilterType, FilterSettings>

export function filterType(header: EdfHeader, channel: ChannelSelection): FilterType {
  if (typeof channel !== 'number') return 'eeg'
  const label = header.signals[channel].label
  const kind = auxiliaryKind(label)
  if (kind === 'ecg') return 'ecg'
  if (kind) return 'aux'
  const electrode = label.trim().toUpperCase().replace(/^EEG\s+/, '').split(/[\s-]/)[0]
  return /^(?:(?:FP|AF|FT|FC|CP|PO|TP|F|C|P|O|T|A|M)\d{1,2}|(?:FP|AF|FC|CP|PO|F|C|P|O)Z)$/.test(electrode)
    ? 'eeg' : 'aux'
}

export function channelFilters(header: EdfHeader, channel: ChannelSelection, filters: ChannelFilters): FilterSettings {
  return filters[filterType(header, channel)]
}

export function canFilterSamples(rate: number, settings: FilterSettings): boolean {
  return [settings.highpass, settings.lowpass, settings.notch]
    .some((frequency) => frequency !== null) &&
    [settings.highpass, settings.lowpass, settings.notch]
      .every((frequency) => frequency === null || (frequency > 0 && frequency < rate / 2))
}

type Coefficients = { b0: number; b1: number; b2: number; a1: number; a2: number }

function coefficients(kind: 'highpass' | 'lowpass' | 'notch', frequency: number, rate: number, quality: number): Coefficients {
  const omega = 2 * Math.PI * frequency / rate
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * quality)
  const denominator = 1 + alpha
  const first = kind === 'highpass' ? (1 + cosine) / 2 : kind === 'lowpass' ? (1 - cosine) / 2 : 1
  const middle = kind === 'highpass' ? -(1 + cosine) : kind === 'lowpass' ? 1 - cosine : -2 * cosine
  return {
    b0: first / denominator,
    b1: middle / denominator,
    b2: first / denominator,
    a1: -2 * cosine / denominator,
    a2: (1 - alpha) / denominator,
  }
}

function pass(data: Float64Array, section: Coefficients, reverse: boolean): void {
  let stateOne = 0
  let stateTwo = 0
  for (let step = 0; step < data.length; step++) {
    const index = reverse ? data.length - 1 - step : step
    const input = data[index]
    const output = section.b0 * input + stateOne
    stateOne = section.b1 * input - section.a1 * output + stateTwo
    stateTwo = section.b2 * input - section.a2 * output
    data[index] = output
  }
}

export function filterSamples(input: Float32Array, rate: number, settings: FilterSettings): Float32Array {
  const stages = (['highpass', 'lowpass', 'notch'] as const)
    .filter((kind) => settings[kind] !== null)
    .flatMap((kind) => {
      const frequency = settings[kind]!
      if (frequency <= 0 || frequency >= rate / 2) {
        throw new Error(`Filter at ${frequency} Hz is unavailable for a ${rate} Hz channel`)
      }
      if (kind === 'notch') return [coefficients(kind, frequency, rate, 30)]
      const qualities = settings.order === 4
        ? [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos(3 * Math.PI / 8))]
        : [Math.SQRT1_2]
      return qualities.map((quality) => coefficients(kind, frequency, rate, quality))
    })
  if (!stages.length || input.length < 2) return input
  if (settings.highpass !== null && settings.lowpass !== null && settings.highpass >= settings.lowpass) {
    throw new Error('High-pass cutoff must be below low-pass cutoff')
  }

  const padSeconds = settings.highpass ? Math.max(2, (settings.order === 4 ? 5 : 3) / settings.highpass) : 2
  const padding = Math.min(input.length - 1, Math.ceil(rate * padSeconds))
  const data = new Float64Array(input.length + 2 * padding)
  data.set(input, padding)
  for (let offset = 0; offset < padding; offset++) {
    data[padding - offset - 1] = input[offset + 1]
    data[padding + input.length + offset] = input[input.length - offset - 2]
  }
  for (const stage of stages) {
    pass(data, stage, false)
    pass(data, stage, true)
  }
  return Float32Array.from(data.subarray(padding, padding + input.length))
}
