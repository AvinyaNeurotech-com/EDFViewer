import { microvoltsPerUnit } from './aeeg'
import { derivedSample } from './edf'
import type { EdfHeader } from './edf'
import { selectionInputs } from './montage'
import type { ChannelSelection } from './montage'
import { canFilterSamples, filterSamples } from './signalFilters'
import type { FilterSettings } from './signalFilters'

type Request = { name: string; header: EdfHeader; channel: ChannelSelection;
  start: number; end: number; filters: FilterSettings }

function fft(real: Float64Array, imaginary: Float64Array,
  cosines: Float64Array, sines: Float64Array) {
  const length = real.length
  for (let index = 1, reverse = 0; index < length; index++) {
    let bit = length >> 1
    while (reverse & bit) { reverse ^= bit; bit >>= 1 }
    reverse ^= bit
    if (index < reverse) {
      ;[real[index], real[reverse]] = [real[reverse], real[index]]
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    for (let offset = 0; offset < length; offset += size) {
      for (let index = 0; index < size / 2; index++) {
        const cosine = cosines[index * length / size]
        const sine = sines[index * length / size]
        const right = offset + index + size / 2
        const rotatedReal = cosine * real[right] - sine * imaginary[right]
        const rotatedImaginary = sine * real[right] + cosine * imaginary[right]
        real[right] = real[offset + index] - rotatedReal
        imaginary[right] = imaginary[offset + index] - rotatedImaginary
        real[offset + index] += rotatedReal
        imaginary[offset + index] += rotatedImaginary
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { name, header, channel, start, end, filters } = event.data
  try {
    const source = header.signals[typeof channel === 'number' ? channel : channel.source]
    const inputs = selectionInputs(channel)
    const rate = source.samplesPerRecord / header.recordDuration
    const multiplier = microvoltsPerUnit(source.unit)
    if (multiplier === null || inputs.some(({ index }) => {
      const signal = header.signals[index]
      return signal.samplesPerRecord !== source.samplesPerRecord ||
        microvoltsPerUnit(signal.unit) !== multiplier ||
        signal.digitalMin === signal.digitalMax || signal.physicalMin === signal.physicalMax
    })) throw new Error('Spectrum unavailable for this channel')
    const firstSample = Math.max(0, Math.ceil(start * rate))
    const lastSample = Math.min(header.recordCount * source.samplesPerRecord, Math.ceil(end * rate))
    if (lastSample - firstSample < rate * 0.5) throw new Error('Select at least 0.5 seconds')

    const filter = canFilterSamples(rate, filters)
    const padding = filter ? Math.max(2, filters.highpass ? (filters.order === 4 ? 6 : 4) / filters.highpass : 0) : 0
    const firstRecord = Math.max(0, Math.floor((start - padding) / header.recordDuration))
    const lastRecord = Math.min(header.recordCount - 1, Math.ceil((end + padding) / header.recordDuration) - 1)
    const byteStart = header.headerBytes + firstRecord * header.recordBytes
    const byteEnd = header.headerBytes + (lastRecord + 1) * header.recordBytes - 1
    const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/file`, {
      headers: { Range: `bytes=${byteStart}-${byteEnd}` }, priority: 'low',
    })
    if (response.status !== 206) throw new Error(`Expected EDF byte range, got ${response.status}`)
    const data = await response.arrayBuffer()
    if (data.byteLength !== byteEnd - byteStart + 1) throw new Error('Incomplete EDF data range')
    const view = new DataView(data)
    const recordSamples = source.samplesPerRecord
    const allSamples = new Float32Array((lastRecord - firstRecord + 1) * recordSamples)
    for (let index = 0; index < allSamples.length; index++) {
      allSamples[index] = derivedSample(view, header, Math.floor(index / recordSamples),
        index % recordSamples, inputs)
    }
    const samples = filter ? filterSamples(allSamples, rate, filters) : allSamples
    const from = firstSample - firstRecord * recordSamples
    const count = lastSample - firstSample
    const length = 2 ** Math.floor(Math.log2(Math.min(count, rate * 2, 4096)))
    if (length < 16) throw new Error('Selection is too short for a spectrum')
    const window = Float64Array.from({ length }, (_, index) =>
      0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1)))
    const windowPower = window.reduce((sum, value) => sum + value * value, 0)
    const maxBin = Math.min(length / 2, Math.floor(100 * length / rate))
    const powers = new Float32Array(maxBin + 1)
    const frequencies = new Float32Array(maxBin + 1)
    const real = new Float64Array(length)
    const imaginary = new Float64Array(length)
    const cosines = Float64Array.from({ length: length / 2 }, (_, index) => Math.cos(2 * Math.PI * index / length))
    const sines = Float64Array.from({ length: length / 2 }, (_, index) => -Math.sin(2 * Math.PI * index / length))
    let segments = 0
    for (let offset = 0; offset + length <= count; offset += Math.max(1, Math.floor(length / 2))) {
      let mean = 0
      for (let index = 0; index < length; index++) mean += samples[from + offset + index] * multiplier
      mean /= length
      for (let index = 0; index < length; index++) {
        real[index] = (samples[from + offset + index] * multiplier - mean) * window[index]
      }
      imaginary.fill(0)
      fft(real, imaginary, cosines, sines)
      for (let bin = 0; bin <= maxBin; bin++) {
        powers[bin] += (bin === 0 || bin === length / 2 ? 1 : 2) *
          (real[bin] ** 2 + imaginary[bin] ** 2) / (rate * windowPower)
      }
      segments++
    }
    for (let bin = 0; bin <= maxBin; bin++) {
      frequencies[bin] = bin * rate / length
      powers[bin] = 10 * Math.log10(powers[bin] / segments + 1e-12)
    }
    self.postMessage({ frequencies, powers }, { transfer: [frequencies.buffer, powers.buffer] })
  } catch (reason) {
    self.postMessage({ error: reason instanceof Error ? reason.message : String(reason) })
  }
}
