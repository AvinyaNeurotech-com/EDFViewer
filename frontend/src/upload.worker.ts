import { headerLength, parseHeader } from './edf'
import type { EdfHeader } from './edf'
import { readAnnotationChannel, writeAnnotationChannel } from './edfAnnotations'
import type { ImportedAnnotation } from './edfAnnotations'

type Channel = { original: number; output: number; radius: number; kernels: Float64Array[] | null }

let file: File
let header: EdfHeader
let channels: Channel[]
let outputHeader: Uint8Array
let outputRecordBytes: number
let nextRecord = 0
let chunkRecords = 1
let discontinuous = false
let recordOnsets: Float64Array
let annotations: ImportedAnnotation[] = []
let annotationKeys = new Set<string>()

function addAnnotation(time: number, duration: number, label: string): void {
  const name = label.trim().slice(0, 80)
  if (!name) return
  if (time < 0 || time > header.duration) throw new Error('EDF+ annotation lies outside the recording timeline')
  const key = JSON.stringify([time, duration, name])
  if (annotationKeys.has(key)) return
  if (annotations.length >= 10000) throw new Error('Too many EDF+ annotations to import (limit: 10000)')
  annotationKeys.add(key)
  annotations.push({ id: annotations.length + 1, time, duration, label: name, visible: true })
}

function continuousTime(time: number): number {
  let low = 0
  let high = recordOnsets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (recordOnsets[middle] <= time) low = middle + 1
    else high = middle
  }
  const record = low - 1
  if (record < 0) {
    throw new Error('EDF+D annotation lies outside the recorded timeline')
  }
  return Number(Math.min(header.duration, record * header.recordDuration +
    Math.min(header.recordDuration, Math.max(0, time - recordOnsets[record]))).toFixed(6))
}

async function scanDiscontinuous(): Promise<void> {
  const primary = header.signals.find((signal) => signal.label.toLowerCase().includes('annotations') && signal.samplesPerRecord)
  if (!primary) throw new Error('EDF+D requires an annotation channel with record timestamps')
  if (header.recordCount > 5_000_000) throw new Error('EDF+D has too many data records to convert')
  recordOnsets = new Float64Array(header.recordCount)
  const events: { onset: number; duration: number; label: string }[] = []
  for (let first = 0; first < header.recordCount; first += chunkRecords) {
    const end = Math.min(header.recordCount, first + chunkRecords)
    const input = new Uint8Array(await file.slice(header.headerBytes + first * header.recordBytes,
      header.headerBytes + end * header.recordBytes).arrayBuffer())
    for (let record = first; record < end; record++) {
      const base = (record - first) * header.recordBytes
      const firstTals = readAnnotationChannel(input.subarray(base + primary.offset,
        base + primary.offset + primary.samplesPerRecord * header.bytesPerSample))
      if (!firstTals.length || firstTals[0].labels.length ||
          (record && firstTals[0].onset < recordOnsets[record - 1] + header.recordDuration - 1e-5)) {
        throw new Error('EDF+D record timestamps are missing, overlapping or out of order')
      }
      recordOnsets[record] = firstTals[0].onset
      if (record) {
        const gap = recordOnsets[record] - recordOnsets[record - 1] - header.recordDuration
        if (gap > 1e-5) addAnnotation(record * header.recordDuration, 0,
          `Recording gap (${Number(gap.toFixed(3))} s removed)`)
      }
      for (const signal of header.signals) {
        if (!signal.label.toLowerCase().includes('annotations') || !signal.samplesPerRecord) continue
        const tals = signal === primary ? firstTals : readAnnotationChannel(input.subarray(base + signal.offset,
          base + signal.offset + signal.samplesPerRecord * header.bytesPerSample))
        for (const tal of tals) for (const label of tal.labels) {
          if (events.length >= 10000) throw new Error('Too many EDF+ annotations to import (limit: 10000)')
          events.push({ onset: tal.onset, duration: tal.duration, label })
        }
      }
    }
  }
  for (const event of events) {
    const time = continuousTime(event.onset)
    addAnnotation(time, Number(Math.max(0, continuousTime(event.onset + event.duration) - time).toFixed(6)), event.label)
  }
}

function integerSample(view: DataView, offset: number, bytes: number): number {
  return bytes === 2 ? view.getInt16(offset, true) :
    view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16
}

function writeSample(view: DataView, offset: number, bytes: number, value: number): void {
  if (bytes === 2) view.setInt16(offset, value, true)
  else {
    view.setUint8(offset, value & 255)
    view.setUint8(offset + 1, value >>> 8 & 255)
    view.setUint8(offset + 2, value >>> 16 & 255)
  }
}

function greatestCommonDivisor(first: number, second: number): number {
  while (second) [first, second] = [second, first % second]
  return first
}

function makeKernels(source: number, target: number, radius: number): Float64Array[] {
  const phases = target / greatestCommonDivisor(source, target)
  const cutoff = 104 / (source / header.recordDuration)
  return Array.from({ length: phases }, (_, phase) => {
    const fractional = phase / phases
    const kernel = new Float64Array(2 * radius + 1)
    let total = 0
    for (let tap = -radius; tap <= radius; tap++) {
      const distance = tap - fractional
      const angle = 2 * Math.PI * cutoff * distance
      const sinc = distance ? Math.sin(angle) / (Math.PI * distance) : 2 * cutoff
      const window = 0.54 + 0.46 * Math.cos(Math.PI * distance / (radius + 1))
      kernel[tap + radius] = sinc * window
      total += kernel[tap + radius]
    }
    for (let tap = 0; tap < kernel.length; tap++) kernel[tap] /= total
    return kernel
  })
}

async function prepare(source: File): Promise<void> {
  file = source
  nextRecord = 0
  annotations = []
  annotationKeys = new Set()
  const prefix = new Uint8Array(await file.slice(0, 256).arrayBuffer())
  const size = headerLength(prefix)
  const originalHeader = new Uint8Array(await file.slice(0, size).arrayBuffer())
  discontinuous = ['EDF+D', 'BDF+D'].includes(new TextDecoder('latin1').decode(originalHeader.subarray(192, 197)))
  header = parseHeader(originalHeader, file.size, true)
  if (file.size !== size + header.recordCount * header.recordBytes) {
    throw new Error('The source must contain complete EDF/BDF records with no extra data')
  }
  if (header.recordCount > 99_999_999) throw new Error('EDF record count exceeds header capacity')
  const outputPerRecord = 256 * header.recordDuration
  channels = header.signals.map((signal) => {
    const sourceRate = signal.samplesPerRecord / header.recordDuration
    const reduce = sourceRate > 256 && !signal.label.toLowerCase().includes('annotations')
    if (reduce && (!Number.isSafeInteger(Math.round(outputPerRecord)) ||
        Math.abs(outputPerRecord - Math.round(outputPerRecord)) > 1e-7 || outputPerRecord > 99_999_999)) {
      throw new Error('This EDF record duration cannot represent exactly 256 Hz; upload cancelled')
    }
    const output = reduce ? Math.round(outputPerRecord) : signal.samplesPerRecord
    const radius = reduce ? Math.ceil(2 * sourceRate / (128 - 80)) : 0
    return { original: signal.samplesPerRecord, output, radius,
      kernels: reduce ? makeKernels(signal.samplesPerRecord, output, radius) : null }
  })
  outputHeader = originalHeader.slice()
  if (discontinuous) outputHeader[196] = 'C'.charCodeAt(0)
  const samplesOffset = 256 + 216 * channels.length
  for (let index = 0; index < channels.length; index++) {
    const number = String(channels[index].output).padEnd(8, ' ')
    outputHeader.set(new TextEncoder().encode(number), samplesOffset + index * 8)
  }
  outputHeader.set(new TextEncoder().encode(String(header.recordCount).padEnd(8, ' ')), 236)
  outputRecordBytes = channels.reduce((total, channel) => total + channel.output * header.bytesPerSample, 0)
  const outputSize = size + header.recordCount * outputRecordBytes
  if (!Number.isSafeInteger(outputSize) || outputSize > 2 * 1024 ** 3 ||
      header.recordBytes > 4 * 1024 ** 2 || outputRecordBytes > 4 * 1024 ** 2 || size > 4 * 1024 ** 2) {
    throw new Error('Converted recording exceeds the upload size limit')
  }
  chunkRecords = Math.max(1, Math.floor(1024 * 1024 / Math.max(header.recordBytes, outputRecordBytes)))
  if (discontinuous) await scanDiscontinuous()
  self.postMessage({ type: 'ready', header: outputHeader.buffer, name: file.name, size: outputSize,
    totalRecords: header.recordCount, discontinuous, downsampled: channels.some((channel) => channel.kernels !== null) },
  { transfer: [outputHeader.buffer] })
}

async function convertChunk(): Promise<void> {
  if (nextRecord >= header.recordCount) {
    annotations.sort((first, second) => first.time - second.time)
    self.postMessage({ type: 'done', annotations })
    return
  }
  const end = Math.min(nextRecord + chunkRecords, header.recordCount)
  const halo = Math.max(...channels.map((channel) => Math.ceil(channel.radius / Math.max(1, channel.original))))
  const firstInput = Math.max(0, nextRecord - halo)
  const lastInput = Math.min(header.recordCount, end + halo)
  const input = new Uint8Array(await file.slice(header.headerBytes + firstInput * header.recordBytes,
    header.headerBytes + lastInput * header.recordBytes).arrayBuffer())
  const inputView = new DataView(input.buffer)
  const output = new ArrayBuffer((end - nextRecord) * outputRecordBytes)
  const outputBytes = new Uint8Array(output)
  const outputView = new DataView(output)
  const bytes = header.bytesPerSample
  if (!discontinuous) {
    for (let record = nextRecord; record < end; record++) {
      for (const signal of header.signals) {
        if (!signal.label.toLowerCase().includes('annotations') || !signal.samplesPerRecord) continue
        const sourceOffset = (record - firstInput) * header.recordBytes + signal.offset
        const tals = readAnnotationChannel(input.subarray(sourceOffset,
          sourceOffset + signal.samplesPerRecord * bytes))
        for (const tal of tals) for (const label of tal.labels) {
          if (tal.onset >= 0 && tal.onset <= header.duration) {
            addAnnotation(tal.onset, Math.min(tal.duration, header.duration - tal.onset), label)
          }
        }
      }
    }
  }
  let channelOffset = 0
  for (let index = 0; index < channels.length; index++) {
    const channel = channels[index]
    const signal = header.signals[index]
    if (discontinuous && signal.label.toLowerCase().includes('annotations')) {
      for (let record = nextRecord; record < end; record++) {
        const sourceOffset = (record - firstInput) * header.recordBytes + signal.offset
        const tals = readAnnotationChannel(input.subarray(sourceOffset, sourceOffset + channel.original * bytes))
        const primary = header.signals.findIndex((item) => item.label.toLowerCase().includes('annotations')) === index
        const mapped = tals.map((tal, talIndex) => {
          const onset = primary && talIndex === 0 ? record * header.recordDuration : continuousTime(tal.onset)
          return { ...tal, onset, duration: tal.duration ? continuousTime(tal.onset + tal.duration) - onset : 0 }
        })
        const replacement = writeAnnotationChannel(mapped, channel.original, bytes)
        outputBytes.set(replacement, (record - nextRecord) * outputRecordBytes + channelOffset)
      }
    } else if (!channel.kernels) {
      for (let record = nextRecord; record < end; record++) {
        const sourceOffset = (record - firstInput) * header.recordBytes + signal.offset
        outputBytes.set(input.subarray(sourceOffset, sourceOffset + channel.original * bytes),
          (record - nextRecord) * outputRecordBytes + channelOffset)
      }
    } else {
      const sourceSamples = new Float64Array((lastInput - firstInput) * channel.original)
      for (let record = firstInput; record < lastInput; record++) {
        const sourceOffset = (record - firstInput) * header.recordBytes + signal.offset
        for (let sample = 0; sample < channel.original; sample++) {
          sourceSamples[(record - firstInput) * channel.original + sample] =
            integerSample(inputView, sourceOffset + sample * bytes, bytes)
        }
      }
      const minimum = Math.max(signal.digitalMin, bytes === 2 ? -32768 : -8388608)
      const maximum = Math.min(signal.digitalMax, bytes === 2 ? 32767 : 8388607)
      const totalSamples = header.recordCount * channel.original
      const divisor = greatestCommonDivisor(channel.original, channel.output)
      for (let record = nextRecord; record < end; record++) {
        const destinationOffset = (record - nextRecord) * outputRecordBytes + channelOffset
        for (let sample = 0; sample < channel.output; sample++) {
          const numerator = (record * channel.output + sample) * channel.original
          const center = Math.floor(numerator / channel.output)
          const kernel = channel.kernels[numerator % channel.output / divisor]
          let value = 0
          for (let tap = -channel.radius; tap <= channel.radius; tap++) {
            const minimumSample = discontinuous ? record * channel.original : 0
            const maximumSample = discontinuous ? (record + 1) * channel.original - 1 : totalSamples - 1
            const absolute = Math.max(minimumSample, Math.min(maximumSample, center + tap))
            value += kernel[tap + channel.radius] * sourceSamples[absolute - firstInput * channel.original]
          }
          writeSample(outputView, destinationOffset + sample * bytes, bytes,
            Math.max(minimum, Math.min(maximum, Math.round(value))))
        }
      }
    }
    channelOffset += channel.output * bytes
  }
  nextRecord = end
  self.postMessage({ type: 'chunk', data: output, completedRecords: end }, { transfer: [output] })
}

self.onmessage = async (event: MessageEvent<{ type: 'start'; file: File } | { type: 'next' }>) => {
  try {
    if (event.data.type === 'start') await prepare(event.data.file)
    else await convertChunk()
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
