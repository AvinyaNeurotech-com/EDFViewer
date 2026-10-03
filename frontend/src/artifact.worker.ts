import { derivedSample } from './edf'
import type { EdfHeader } from './edf'
import { microvoltsPerUnit } from './aeeg'
import { auxiliaryKind, selectionInputs } from './montage'
import type { ChannelSelection } from './montage'
import { detectArtifacts } from './artifactDetection'
import type { ArtifactBox } from './artifactDetection'

type Request = { header: EdfHeader; start: number; duration: number; firstRecord: number;
  data: ArrayBuffer; channels: ChannelSelection[]; muted: boolean[] }

self.onmessage = (event: MessageEvent<Request>) => {
  const { header, start, duration, firstRecord, data, channels, muted } = event.data
  try {
    const lastRecord = Math.min(header.recordCount, Math.ceil((start + duration) / header.recordDuration))
    if (data.byteLength !== (lastRecord - firstRecord) * header.recordBytes) {
      throw new Error('Incomplete cached analysis window')
    }
    const view = new DataView(data)
    const boxes: ArtifactBox[] = []
    for (let channel = 0; channel < channels.length; channel++) {
      if (muted[channel]) continue
      const selection = channels[channel]
      const inputs = selectionInputs(selection)
      const source = header.signals[inputs[0].index]
      const label = typeof selection === 'number' ? source.label : selection.label
      const multiplier = microvoltsPerUnit(source.unit)
      if (auxiliaryKind(label) || multiplier === null || !source.samplesPerRecord ||
        inputs.some(({ index }) => {
          const signal = header.signals[index]
          return signal.samplesPerRecord !== source.samplesPerRecord ||
            microvoltsPerUnit(signal.unit) !== multiplier ||
            signal.digitalMin === signal.digitalMax || signal.physicalMin === signal.physicalMax
        })) continue
      const rate = source.samplesPerRecord / header.recordDuration
      const first = Math.max(0, Math.ceil((start - firstRecord * header.recordDuration) * rate))
      const end = Math.min((lastRecord - firstRecord) * source.samplesPerRecord,
        Math.ceil((start + duration - firstRecord * header.recordDuration) * rate))
      if (end <= first) continue
      const samples = new Float32Array(end - first)
      for (let sample = first; sample < end; sample++) {
        samples[sample - first] = derivedSample(view, header,
          Math.floor(sample / source.samplesPerRecord), sample % source.samplesPerRecord, inputs) * multiplier
      }
      for (const item of detectArtifacts(samples, rate, firstRecord * header.recordDuration + first / rate)) {
        boxes.push({ ...item, channel })
      }
    }
    self.postMessage({ type: 'result', boxes })
  } catch (reason) {
    self.postMessage({ type: 'error', message: reason instanceof Error ? reason.message : String(reason) })
  }
}
