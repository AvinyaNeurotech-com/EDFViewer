import { microvoltsPerUnit } from './aeeg'
import { derivedSample } from './edf'
import type { EdfHeader } from './edf'
import { auxiliaryKind, selectionInputs } from './montage'
import type { ChannelSelection } from './montage'

type Request = { name: string; header: EdfHeader; start: number; duration: number; columns: number;
  channels: ChannelSelection[]; spectrogram: boolean; bandPower: boolean }
const BANDS = [[0.5, 4], [4, 8], [8, 13], [13, 30]]
const twiddleCache = new Map<number, { cosines: Float64Array; sines: Float64Array }>()

function transform(real: Float64Array, imaginary: Float64Array) {
  const length = real.length
  let twiddles = twiddleCache.get(length)
  if (!twiddles) {
    twiddles = {
      cosines: Float64Array.from({ length: length / 2 }, (_, index) => Math.cos(2 * Math.PI * index / length)),
      sines: Float64Array.from({ length: length / 2 }, (_, index) => -Math.sin(2 * Math.PI * index / length)),
    }
    twiddleCache.set(length, twiddles)
  }
  for (let index = 1, reverse = 0; index < length; index++) {
    let bit = length >> 1
    for (; reverse & bit; bit >>= 1) reverse ^= bit
    reverse ^= bit
    if (index < reverse) {
      ;[real[index], real[reverse]] = [real[reverse], real[index]]
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    for (let offset = 0; offset < length; offset += size) {
      for (let index = 0; index < size / 2; index++) {
        const cosine = twiddles.cosines[index * (length / size)]
        const sine = twiddles.sines[index * (length / size)]
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
  const { name, header, start, duration, columns, channels, spectrogram, bandPower } = event.data
  try {
    const firstRecord = Math.max(0, Math.floor(start / header.recordDuration))
    const lastRecord = Math.min(header.recordCount - 1,
      Math.ceil((start + duration) / header.recordDuration) - 1)
    const byteStart = header.headerBytes + firstRecord * header.recordBytes
    const byteEnd = header.headerBytes + (lastRecord + 1) * header.recordBytes - 1
    const response = await fetch(`/api/recordings/${encodeURIComponent(name)}/file`, {
      headers: { Range: `bytes=${byteStart}-${byteEnd}` },
    })
    if (response.status !== 206) throw new Error(`Expected EDF byte-range response, got ${response.status}`)
    const data = await response.arrayBuffer()
    if (data.byteLength !== byteEnd - byteStart + 1) throw new Error('Incomplete spectral data range')
    const view = new DataView(data)
    const columnCount = Math.min(320, Math.max(1, Math.ceil(columns / 4)))
    const rowCount = 40
    const tiles = spectrogram ? channels.map((selection) => {
      const source = header.signals[typeof selection === 'number' ? selection : selection.source]
      const inputs = selectionInputs(selection)
      const multiplier = microvoltsPerUnit(source.unit)
      const rate = source.samplesPerRecord / header.recordDuration
      const maxFrequency = Math.min(40, rate / 2)
      const values = new Uint8Array(columnCount * rowCount)
      if (multiplier === null || rate < 2 || maxFrequency < 1 ||
        inputs.some(({ index }) => {
          const signal = header.signals[index]
          return signal.digitalMin === signal.digitalMax || signal.physicalMin === signal.physicalMax ||
            signal.samplesPerRecord !== source.samplesPerRecord || microvoltsPerUnit(signal.unit) !== multiplier
        })) return values
      const length = 2 ** Math.floor(Math.log2(Math.min(1024, rate, duration * rate)))
      if (length < 32) return values
      const real = new Float64Array(length)
      const imaginary = new Float64Array(length)
      const window = Float64Array.from({ length }, (_, index) =>
        0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1)))
      const windowPower = window.reduce((sum, weight) => sum + weight * weight, 0)
      const power = new Float64Array(length / 2 + 1)
      const recordSamples = source.samplesPerRecord
      const firstSample = Math.max(0, Math.ceil(start * rate - 0.000001))
      const lastSample = Math.min(header.recordCount * recordSamples, Math.ceil((start + duration) * rate - 0.000001))
      for (let column = 0; column < columnCount; column++) {
        const center = Math.floor((start + (column + 0.5) / columnCount * duration) * rate)
        const windowStart = Math.max(firstSample, Math.min(lastSample - length, center - Math.floor(length / 2)))
        let average = 0
        for (let index = 0; index < length; index++) {
          const sample = windowStart + index
          const record = Math.floor(sample / recordSamples)
          real[index] = derivedSample(view, header, record - firstRecord, sample % recordSamples, inputs) * multiplier
          average += real[index]
        }
        average /= length
        for (let index = 0; index < length; index++) real[index] = (real[index] - average) * window[index]
        imaginary.fill(0)
        transform(real, imaginary)
        for (let index = 0; index < power.length; index++) {
          power[index] = 2 * (real[index] ** 2 + imaginary[index] ** 2) /
            (rate * windowPower)
        }
        for (let row = 0; row < rowCount; row++) {
          const low = (row + 0.5) * maxFrequency / rowCount
          const high = (row + 1.5) * maxFrequency / rowCount
          if (low >= rate / 2) continue
          const firstBin = Math.max(1, Math.round(low * length / rate))
          const lastBin = Math.min(power.length - 1, Math.max(firstBin, Math.floor(high * length / rate)))
          let sum = 0
          for (let bin = firstBin; bin <= lastBin; bin++) sum += power[bin]
          const powerValue = sum / (lastBin - firstBin + 1)
          const db = 10 * Math.log10(powerValue + 1e-10)
          values[row * columnCount + column] = Math.max(1, Math.min(255, Math.round((db + 30) / 75 * 254 + 1)))
        }
      }
      return values
    }) : []
    const bandColumns = Math.min(120, Math.max(1, Math.ceil(duration)))
    const bandValues = Array.from({ length: BANDS.length }, () => new Float32Array(bandColumns).fill(NaN))
    if (bandPower) {
      const observations = Array.from({ length: BANDS.length }, () =>
        Array.from({ length: bandColumns }, () => [] as number[]))
      for (const selection of channels) {
        const source = header.signals[typeof selection === 'number' ? selection : selection.source]
        const inputs = selectionInputs(selection)
        const rate = source.samplesPerRecord / header.recordDuration
        if (inputs.some(({ index }) => auxiliaryKind(header.signals[index].label)) ||
          microvoltsPerUnit(source.unit) === null ||
          inputs.some(({ index }) => {
            const signal = header.signals[index]
            return signal.samplesPerRecord !== source.samplesPerRecord ||
              microvoltsPerUnit(signal.unit) !== microvoltsPerUnit(source.unit) ||
              signal.digitalMin === signal.digitalMax || signal.physicalMin === signal.physicalMax
          })) continue
        const firstSample = Math.max(0, Math.ceil(start * rate - 0.000001))
        const lastSample = Math.min(header.recordCount * source.samplesPerRecord,
          Math.ceil((start + duration) * rate - 0.000001))
        const sampleCount = Math.min(lastSample - firstSample, Math.ceil(rate * 4))
        if (sampleCount < 32 || sampleCount / rate < 1) continue
        const length = 2 ** Math.ceil(Math.log2(sampleCount))
        const window = Float64Array.from({ length: sampleCount }, (_, index) =>
          0.5 - 0.5 * Math.cos(2 * Math.PI * index / (sampleCount - 1)))
        const windowPower = window.reduce((sum, weight) => sum + weight * weight, 0)
        const real = new Float64Array(length)
        const imaginary = new Float64Array(length)
        const multiplier = microvoltsPerUnit(source.unit)!
        for (let column = 0; column < bandColumns; column++) {
          const center = Math.floor((start + (bandColumns === 1 ? 0.5 : column / (bandColumns - 1)) * duration) * rate)
          const windowStart = Math.max(firstSample, Math.min(lastSample - sampleCount,
            center - Math.floor(sampleCount / 2)))
          let average = 0
          for (let index = 0; index < sampleCount; index++) {
            const sample = windowStart + index
            const record = Math.floor(sample / source.samplesPerRecord)
            real[index] = derivedSample(view, header, record - firstRecord,
              sample % source.samplesPerRecord, inputs) * multiplier
            average += real[index]
          }
          average /= sampleCount
          for (let index = 0; index < sampleCount; index++) real[index] = (real[index] - average) * window[index]
          real.fill(0, sampleCount)
          imaginary.fill(0)
          transform(real, imaginary)
          for (let band = 0; band < BANDS.length; band++) {
            const [low, high] = BANDS[band]
            if ((band === 0 && sampleCount / rate < 4) || high > rate / 2) continue
            const firstBin = Math.ceil(low * length / rate)
            const lastBin = Math.min(length / 2, Math.ceil(high * length / rate) - 1)
            if (firstBin > lastBin) continue
            let power = 0
            for (let bin = Math.max(1, firstBin); bin <= lastBin; bin++) {
              power += 2 * (real[bin] ** 2 + imaginary[bin] ** 2) / (rate * windowPower)
            }
            observations[band][column].push(power * rate / length)
          }
        }
      }
      for (let band = 0; band < BANDS.length; band++) {
        for (let column = 0; column < bandColumns; column++) {
          const values = observations[band][column].sort((left, right) => left - right)
          if (values.length) bandValues[band][column] = values[Math.floor(values.length / 2)]
        }
      }
    }
    self.postMessage({ type: 'spectral', tiles, columnCount, rowCount, bands: bandValues }, {
      transfer: [...tiles.map((tile) => tile.buffer), ...bandValues.map((band) => band.buffer)],
    })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
