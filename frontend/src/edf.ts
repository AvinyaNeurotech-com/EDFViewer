import { canFilterSamples, filterSamples, NO_FILTERS } from './signalFilters'
import type { FilterSettings } from './signalFilters'
import { selectionInputs } from './montage'
import type { ChannelSelection } from './montage'

export type Signal = {
  label: string
  unit: string
  samplesPerRecord: number
  offset: number
  physicalMin: number
  physicalMax: number
  digitalMin: number
  digitalMax: number
}

export type EdfHeader = {
  headerBytes: number
  recordBytes: number
  recordCount: number
  recordDuration: number
  bytesPerSample: number
  signals: Signal[]
  visibleSignals: number[]
  duration: number
}

const decoder = new TextDecoder('latin1')

function text(bytes: Uint8Array, start: number, length: number): string {
  return decoder.decode(bytes.subarray(start, start + length)).trim()
}

function numberField(bytes: Uint8Array, start: number, length: number): number {
  const value = Number(text(bytes, start, length))
  if (!Number.isFinite(value)) throw new Error('Invalid EDF header value')
  return value
}

export function headerLength(bytes: Uint8Array): number {
  if (bytes.length < 256) throw new Error('EDF header is incomplete')
  const length = numberField(bytes, 184, 8)
  const signalCount = numberField(bytes, 252, 4)
  if (!Number.isSafeInteger(signalCount) || signalCount < 1 || signalCount > 4096 || length !== 256 * (signalCount + 1)) {
    throw new Error('Invalid EDF header size or signal count')
  }
  return length
}

export function parseHeader(bytes: Uint8Array, fileSize: number, allowDiscontinuous = false): EdfHeader {
  const headerBytes = headerLength(bytes)
  if (bytes.length < headerBytes) throw new Error('EDF header is incomplete')
  const signalCount = numberField(bytes, 252, 4)
  const recordDuration = numberField(bytes, 244, 8)
  const declaredRecords = numberField(bytes, 236, 8)
  if (recordDuration <= 0 || !Number.isSafeInteger(declaredRecords) || declaredRecords < -1) {
    throw new Error('Invalid EDF data record information')
  }
  if (!allowDiscontinuous && (text(bytes, 192, 5) === 'EDF+D' || text(bytes, 192, 5) === 'BDF+D')) {
    throw new Error('Discontinuous EDF recordings are not supported yet')
  }

  const bytesPerSample = bytes[0] === 0xff ? 3 : 2
  let position = 256
  const fields = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32].map((width) => {
    const values = Array.from({ length: signalCount }, (_, index) => text(bytes, position + index * width, width))
    position += signalCount * width
    return values
  })

  let recordBytes = 0
  const signals = Array.from({ length: signalCount }, (_, index) => {
    const samplesPerRecord = Number(fields[8][index])
    const physicalMin = Number(fields[3][index])
    const physicalMax = Number(fields[4][index])
    const digitalMin = Number(fields[5][index])
    const digitalMax = Number(fields[6][index])
    if (!Number.isSafeInteger(samplesPerRecord) || samplesPerRecord < 0 ||
        ![physicalMin, physicalMax, digitalMin, digitalMax].every(Number.isFinite)) {
      throw new Error('Invalid EDF signal information')
    }
    const signal: Signal = {
      label: fields[0][index], unit: fields[2][index], samplesPerRecord,
      offset: recordBytes, physicalMin, physicalMax, digitalMin, digitalMax,
    }
    recordBytes += samplesPerRecord * bytesPerSample
    return signal
  })
  if (!Number.isSafeInteger(recordBytes) || recordBytes <= 0) throw new Error('Invalid EDF record size')
  const availableRecords = Math.floor((fileSize - headerBytes) / recordBytes)
  if (availableRecords <= 0) throw new Error('No complete EDF data records found')
  const recordCount = declaredRecords === -1 ? availableRecords : Math.min(declaredRecords, availableRecords)
  if (recordCount <= 0) throw new Error('No EDF data records declared')
  const visibleSignals = signals.flatMap((signal, index) =>
    signal.label.toLowerCase().includes('annotations') || signal.samplesPerRecord === 0 ? [] : [index],
  )
  if (!visibleSignals.length) throw new Error('No waveform channels found')

  return {
    headerBytes, recordBytes, recordCount, recordDuration, bytesPerSample,
    signals, visibleSignals, duration: recordCount * recordDuration,
  }
}

export type Trace = {
  label: string
  unit: string
  mode: TraceMode
  positions: Float32Array
  values: Float32Array
  low: number
  high: number
}

export type TraceMode = 'four-point' | 'min-max'

export function traceMode(sampleRate: number, duration: number, columns: number): TraceMode {
  return sampleRate * duration / columns >= 9 ? 'min-max' : 'four-point'
}

type PixelBucket = {
  firstIndex: number
  firstPosition: number
  firstValue: number
  lastIndex: number
  lastPosition: number
  lastValue: number
  minIndex: number
  minPosition: number
  minValue: number
  maxIndex: number
  maxPosition: number
  maxValue: number
}

export function sampleValue(view: DataView, offset: number, bytesPerSample: number, signal: Signal): number {
  const digital = bytesPerSample === 2
    ? view.getInt16(offset, true)
    : (view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16)
  return signal.digitalMin === signal.digitalMax ? digital :
    signal.physicalMin + (digital - signal.digitalMin) *
    (signal.physicalMax - signal.physicalMin) / (signal.digitalMax - signal.digitalMin)
}

export function derivedSample(view: DataView, header: EdfHeader, recordOffset: number,
  sample: number, inputs: { index: number; weight: number }[]): number {
  let value = 0
  for (const { index, weight } of inputs) {
    const signal = header.signals[index]
    value += weight * sampleValue(view,
      recordOffset * header.recordBytes + signal.offset + sample * header.bytesPerSample,
      header.bytesPerSample, signal)
  }
  return value
}

export function decodeWindow(
  header: EdfHeader,
  data: ArrayBuffer,
  firstRecord: number,
  start: number,
  duration: number,
  columns: number,
  channels: ChannelSelection[] = header.visibleSignals,
  filters: FilterSettings = NO_FILTERS,
): Trace[] {
  const view = new DataView(data)
  return channels.map((selection) => {
    const index = typeof selection === 'number' ? selection : selection.source
    const signal = header.signals[index]
    const inputs = selectionInputs(selection)
    const recordCount = data.byteLength / header.recordBytes
    const sampleRate = signal.samplesPerRecord / header.recordDuration
    const mode = traceMode(sampleRate, duration, columns)
    let filtered: Float32Array | null = null
    if (canFilterSamples(sampleRate, filters)) {
      const samples = new Float32Array(recordCount * signal.samplesPerRecord)
      for (let recordOffset = 0; recordOffset < recordCount; recordOffset++) {
        for (let sample = 0; sample < signal.samplesPerRecord; sample++) {
          samples[recordOffset * signal.samplesPerRecord + sample] =
            derivedSample(view, header, recordOffset, sample, inputs)
        }
      }
      filtered = filterSamples(samples, sampleRate, filters)
    }
    const drawAll = mode === 'four-point' && sampleRate * duration <= columns
    const rawPositions = drawAll ? new Float32Array(recordCount * signal.samplesPerRecord) : null
    const rawValues = drawAll ? new Float32Array(recordCount * signal.samplesPerRecord) : null
    const buckets: (PixelBucket | undefined)[] = drawAll ? [] : new Array(columns)
    let count = 0
    let low = Infinity
    let high = -Infinity
    for (let recordOffset = 0; recordOffset < recordCount; recordOffset++) {
      const recordStart = (firstRecord + recordOffset) * header.recordDuration
      for (let sample = 0; sample < signal.samplesPerRecord; sample++) {
        const time = recordStart + sample * header.recordDuration / signal.samplesPerRecord
        const column = Math.floor((time - start) / duration * columns)
        if (column < 0 || column >= columns) continue
        const value = filtered
          ? filtered[recordOffset * signal.samplesPerRecord + sample]
          : derivedSample(view, header, recordOffset, sample, inputs)
        const position = (time - start) / duration * columns
        if (rawPositions && rawValues) {
          rawPositions[count] = position
          rawValues[count] = value
        } else {
          const bucket = buckets[column]
          if (bucket) {
            bucket.lastIndex = count
            bucket.lastPosition = position
            bucket.lastValue = value
            if (value < bucket.minValue) {
              bucket.minIndex = count
              bucket.minPosition = position
              bucket.minValue = value
            }
            if (value > bucket.maxValue) {
              bucket.maxIndex = count
              bucket.maxPosition = position
              bucket.maxValue = value
            }
          } else {
            buckets[column] = {
              firstIndex: count, firstPosition: position, firstValue: value,
              lastIndex: count, lastPosition: position, lastValue: value,
              minIndex: count, minPosition: position, minValue: value,
              maxIndex: count, maxPosition: position, maxValue: value,
            }
          }
        }
        count++
        low = Math.min(low, value)
        high = Math.max(high, value)
      }
    }
    const label = typeof selection === 'number' ? signal.label || `Channel ${index + 1}` : selection.label
    if (rawPositions && rawValues) {
      return { label, unit: signal.unit, mode,
        positions: rawPositions.slice(0, count), values: rawValues.slice(0, count), low, high }
    }

    const positions = new Float32Array(columns * (mode === 'four-point' ? 4 : 1))
    const values = new Float32Array(columns * (mode === 'four-point' ? 4 : 2))
    let pointCount = 0
    for (let column = 0; column < columns; column++) {
      const bucket = buckets[column]
      if (!bucket) continue
      if (mode === 'min-max') {
        positions[pointCount] = column
        values[pointCount * 2] = bucket.minValue
        values[pointCount * 2 + 1] = bucket.maxValue
        pointCount++
      } else {
        const points = [
          { index: bucket.firstIndex, position: bucket.firstPosition, value: bucket.firstValue },
          { index: bucket.minIndex, position: bucket.minPosition, value: bucket.minValue },
          { index: bucket.maxIndex, position: bucket.maxPosition, value: bucket.maxValue },
          { index: bucket.lastIndex, position: bucket.lastPosition, value: bucket.lastValue },
        ].sort((left, right) => left.index - right.index)
        let previousIndex = -1
        for (const point of points) {
          if (point.index === previousIndex) continue
          positions[pointCount] = point.position
          values[pointCount] = point.value
          pointCount++
          previousIndex = point.index
        }
      }
    }
    return {
      label, unit: signal.unit, mode,
      positions: positions.slice(0, pointCount),
      values: values.slice(0, pointCount * (mode === 'min-max' ? 2 : 1)), low, high,
    }
  })
}
