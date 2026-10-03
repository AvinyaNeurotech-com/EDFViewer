export type ImportedAnnotation = { id: number; time: number; duration: number; label: string; visible: boolean }

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export type Tal = { onset: number; duration: number; labels: string[] }

function parseTals(bytes: Uint8Array): Tal[] {
  const entries: Tal[] = []
  for (let start = 0; start < bytes.length;) {
    while (start < bytes.length && bytes[start] === 0) start++
    if (start >= bytes.length) break
    let end = start
    while (end < bytes.length && bytes[end] !== 0) end++
    if (end === bytes.length) throw new Error('Incomplete EDF+ annotation TAL')
    const separator = bytes.indexOf(20, start)
    if (separator < 0 || separator >= end) throw new Error('Invalid EDF+ annotation TAL')
    const prefix = decoder.decode(bytes.subarray(start, separator))
    const [onsetText, durationText] = prefix.split('\x15')
    const onset = Number(onsetText)
    const duration = durationText === undefined ? 0 : Number(durationText)
    if (!/^[+-]\d+(?:\.\d+)?$/.test(onsetText) ||
        (durationText !== undefined && !/^\d+(?:\.\d+)?$/.test(durationText)) ||
        !Number.isFinite(onset) || !Number.isFinite(duration)) {
      throw new Error('Invalid EDF+ annotation time')
    }
    const labels = decoder.decode(bytes.subarray(separator + 1, end)).split('\x14').filter(Boolean)
    entries.push({ onset, duration, labels })
    start = end + 1
  }
  return entries
}

export function readAnnotationChannel(record: Uint8Array): Tal[] {
  return parseTals(record)
}

export function writeAnnotationChannel(tals: Tal[], capacity: number, bytesPerSample: number): Uint8Array {
  const text = new Uint8Array(capacity * bytesPerSample)
  let position = 0
  for (const tal of tals) {
    const time = `${tal.onset >= 0 ? '+' : ''}${Number(tal.onset.toFixed(6))}`
    const encoded = encoder.encode(`${time}${tal.duration ? `\x15${tal.duration}` : ''}\x14${tal.labels.join('\x14')}\x14\0`)
    if (position + encoded.length > capacity) {
      throw new Error('EDF+ annotation channel cannot fit rewritten timestamps')
    }
    text.set(encoded, position)
    position += encoded.length
  }
  return text
}
