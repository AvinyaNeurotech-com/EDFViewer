export type ArtifactKind = 'flatline' | 'amplitude' | 'pop' | 'muscle'
export type ArtifactInterval = { start: number; end: number; kind: ArtifactKind }
export type ArtifactBox = ArtifactInterval & { channel: number }

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

export function detectArtifacts(samples: Float32Array, rate: number, start: number): ArtifactInterval[] {
  if (!Number.isFinite(rate) || rate < 16 || samples.length < 8) return []
  const windowSize = Math.min(samples.length, Math.max(8, Math.round(rate * 0.25)))
  const hop = Math.max(1, Math.floor(windowSize / 2))
  const metrics: { from: number; to: number; range: number; excursion: number; step: number; shift: number;
    muscle: number; flat: boolean }[] = []
  const baselineSamples: number[] = []
  const stride = Math.max(1, Math.ceil(samples.length / 4096))
  for (let index = 0; index < samples.length; index += stride) baselineSamples.push(samples[index])
  const baseline = median(baselineSamples)
  const highAlpha = 1 - Math.exp(-2 * Math.PI * Math.min(80, rate * 0.4) / rate)
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * 25 / rate)
  let high = samples[0]
  let low = high
  const band = new Float32Array(samples.length)
  if (rate >= 100) for (let index = 1; index < samples.length; index++) {
    high += highAlpha * (samples[index] - high)
    low += lowAlpha * (samples[index] - low)
    band[index] = high - low
  }

  for (let from = 0; from + windowSize <= samples.length; from += hop) {
    const to = from + windowSize
    let minimum = Infinity
    let maximum = -Infinity
    let excursion = 0
    let step = 0
    let musclePower = 0
    let firstMean = 0
    let lastMean = 0
    const side = Math.max(1, Math.floor(windowSize / 4))
    for (let index = from; index < to; index++) {
      const value = samples[index]
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
      excursion = Math.max(excursion, Math.abs(value - baseline))
      if (index > from) step = Math.max(step, Math.abs(value - samples[index - 1]))
      musclePower += band[index] ** 2
      if (index < from + side) firstMean += value
      if (index >= to - side) lastMean += value
    }
    metrics.push({ from, to, range: maximum - minimum, excursion, step,
      shift: Math.abs(lastMean - firstMean) / side, muscle: Math.sqrt(musclePower / windowSize),
      flat: maximum - minimum < 1 })
  }
  if (!metrics.length) return []
  const normalRange = percentile(metrics.map((item) => item.range), 0.3)
  const normalExcursion = percentile(metrics.map((item) => item.excursion), 0.3)
  const normalStep = percentile(metrics.map((item) => item.step), 0.3)
  const normalMuscle = percentile(metrics.map((item) => item.muscle), 0.3)
  const results: ArtifactInterval[] = []
  for (const item of metrics) {
    const push = (kind: ArtifactKind) => results.push({
      start: start + item.from / rate, end: start + item.to / rate, kind,
    })
    if (item.flat) push('flatline')
    else if (item.shift > Math.max(100, normalRange * 2.5) &&
      item.step > Math.max(35, normalStep * 6)) push('pop')
    else if (item.range > Math.max(120, normalRange * 3) ||
      item.excursion > Math.max(150, normalExcursion * 3.5)) push('amplitude')
    if (rate >= 100 && item.muscle > Math.max(8, normalMuscle * 4) &&
      item.muscle > item.range * 0.08) push('muscle')
  }
  results.sort((left, right) => left.kind.localeCompare(right.kind) || left.start - right.start)
  const merged: ArtifactInterval[] = []
  for (const item of results) {
    const previous = merged.at(-1)
    if (previous && item.kind === previous.kind && item.start <= previous.end + 0.02) {
      previous.end = Math.max(previous.end, item.end)
    }
    else merged.push({ ...item })
  }
  return merged.filter((item) => item.kind !== 'flatline' && item.kind !== 'muscle' ||
    item.end - item.start >= 0.45)
}
