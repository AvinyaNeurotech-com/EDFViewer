import type { EdfHeader } from './edf'

export type ChannelSelection = number | { source: number; reference: number; label: string } |
  { source: number; neighbors: number[]; label: string }

export type AuxiliaryKind = 'ecg' | 'eog' | 'emg' | 'respiration' | 'other'

type Hemisphere = 'left' | 'right' | 'midline'

export function auxiliaryKind(label: string): AuxiliaryKind | null {
  const name = label.trim().toUpperCase().replace(/^EEG\s+/, '')
  if (/ECG|EKG/.test(name)) return 'ecg'
  if (/EOG/.test(name)) return 'eog'
  if (/EMG/.test(name)) return 'emg'
  if (/RESP|BREATH|AIRFLOW/.test(name)) return 'respiration'
  if (/SPO2|OSAT|O2SAT|PULSE|PLETH|PHOT|EVENT|TRIGGER|STIM|AUX|^DC\d*\b|^PR\b|^RR\b|^IBI\b|^BURSTS?\b|^SUPPR\b/.test(name)) return 'other'
  return null
}

const auxiliaryOrder: AuxiliaryKind[] = ['ecg', 'eog', 'emg', 'respiration', 'other']

function hemisphere(label: string): Hemisphere {
  const electrode = label.trim().toUpperCase().replace(/^EEG\s+/, '').split('-')[0]
  const number = electrode.match(/\d+$/)?.[0]
  if (!number) return 'midline'
  return Number(number) % 2 === 1 ? 'left' : 'right'
}

function pairedElectrode(label: string): string {
  return label.trim().toUpperCase().replace(/^EEG\s+/, '').replace(/\s*-(REF|LE|AVG)$/, '')
    .replace(/\d+$/, (number) => String(Math.ceil(Number(number) / 2)))
}

function pairGroup(header: EdfHeader, selection: ChannelSelection): string {
  if (typeof selection === 'number') return pairedElectrode(header.signals[selection].label)
  if ('neighbors' in selection) return pairedElectrode(header.signals[selection.source].label)
  return `${pairedElectrode(header.signals[selection.source].label)}-${pairedElectrode(header.signals[selection.reference].label)}`
}

export function selectionInputs(selection: ChannelSelection): { index: number; weight: number }[] {
  if (typeof selection === 'number') return [{ index: selection, weight: 1 }]
  if ('neighbors' in selection) return [{ index: selection.source, weight: 1 },
    ...selection.neighbors.map((index) => ({ index, weight: -1 / selection.neighbors.length }))]
  return [{ index: selection.source, weight: 1 }, { index: selection.reference, weight: -1 }]
}

export function orderedChannels(header: EdfHeader, channels: ChannelSelection[]): ChannelSelection[] {
  const groups = new Map<string, number>()
  channels.forEach((selection) => {
    const group = pairGroup(header, selection)
    if (!groups.has(group)) groups.set(group, groups.size)
  })
  return [...channels].sort((left, right) => {
    const leftLabel = typeof left === 'number' ? header.signals[left].label : left.label
    const rightLabel = typeof right === 'number' ? header.signals[right].label : right.label
    const leftKind = auxiliaryKind(leftLabel)
    const rightKind = auxiliaryKind(rightLabel)
    if (leftKind || rightKind) {
      if (!leftKind) return -1
      if (!rightKind) return 1
      return auxiliaryOrder.indexOf(leftKind) - auxiliaryOrder.indexOf(rightKind)
    }
    const leftSide = hemisphere(leftLabel)
    const rightSide = hemisphere(rightLabel)
    if (leftSide === 'midline' || rightSide === 'midline') {
      if (leftSide !== 'midline') return -1
      if (rightSide !== 'midline') return 1
    }
    const groupOrder = groups.get(pairGroup(header, left))! - groups.get(pairGroup(header, right))!
    if (groupOrder) return groupOrder
    return (leftSide === 'right' ? 1 : 0) - (rightSide === 'right' ? 1 : 0)
  })
}

const LONGITUDINAL_PAIRS = [
  ['FP1', 'F7'], ['F7', 'T3'], ['T3', 'T5'], ['T5', 'O1'],
  ['FP2', 'F8'], ['F8', 'T4'], ['T4', 'T6'], ['T6', 'O2'],
  ['FP1', 'F3'], ['F3', 'C3'], ['C3', 'P3'], ['P3', 'O1'],
  ['FP2', 'F4'], ['F4', 'C4'], ['C4', 'P4'], ['P4', 'O2'],
  ['FZ', 'CZ'], ['CZ', 'PZ'],
]

const TRANSVERSE_PAIRS = [
  ['FP1', 'FP2'],
  ['F7', 'F3'], ['F3', 'FZ'], ['FZ', 'F4'], ['F4', 'F8'],
  ['T3', 'C3'], ['C3', 'CZ'], ['CZ', 'C4'], ['C4', 'T4'],
  ['T5', 'P3'], ['P3', 'PZ'], ['PZ', 'P4'], ['P4', 'T6'],
  ['O1', 'O2'],
]
const CZ_REFERENCE_ORDER = [
  'FP1', 'FP2', 'F7', 'F8', 'F3', 'F4', 'FZ',
  'T3', 'T4', 'C3', 'C4', 'T5', 'T6',
  'P3', 'P4', 'PZ', 'O1', 'O2',
]

const LAPLACIAN_NEIGHBORS: [string, string[]][] = [
  ['F3', ['FP1', 'F7', 'FZ', 'C3']], ['F4', ['FP2', 'F8', 'FZ', 'C4']],
  ['FZ', ['FP1', 'FP2', 'F3', 'F4']],
  ['C3', ['F3', 'T3', 'CZ', 'P3']], ['C4', ['F4', 'T4', 'CZ', 'P4']],
  ['CZ', ['FZ', 'C3', 'C4', 'PZ']],
  ['P3', ['C3', 'T5', 'PZ', 'O1']], ['P4', ['C4', 'T6', 'PZ', 'O2']],
  ['PZ', ['CZ', 'P3', 'P4', 'O1', 'O2']],
]

function electrode(label: string): string {
  const name = label.trim().toUpperCase().replace(/^EEG\s+/, '').replace(/\s*-(REF|LE|AVG)$/, '')
  return ({ T7: 'T3', T8: 'T4', P7: 'T5', P8: 'T6' } as Record<string, string>)[name] ?? name
}

function referenceName(label: string): string {
  return label.trim().toUpperCase().match(/\s*-(REF|LE|AVG)$/)?.[1] ?? ''
}

function electrodeMap(header: EdfHeader): Map<string, number> {
  const byElectrode = new Map<string, number>()
  for (const index of header.visibleSignals) {
    if (auxiliaryKind(header.signals[index].label)) continue
    const name = electrode(header.signals[index].label)
    if (!byElectrode.has(name)) byElectrode.set(name, index)
  }
  return byElectrode
}

function compatible(header: EdfHeader, indices: number[]): boolean {
  const first = header.signals[indices[0]]
  return indices.every((index) => {
    const signal = header.signals[index]
    return signal.samplesPerRecord === first.samplesPerRecord && signal.samplesPerRecord > 0 &&
      signal.unit.trim().toLowerCase() === first.unit.trim().toLowerCase() &&
      referenceName(signal.label) === referenceName(first.label)
  })
}

function bipolarMontage(header: EdfHeader, pairs: string[][]): ChannelSelection[] {
  const byElectrode = electrodeMap(header)
  return pairs.flatMap(([anode, cathode]) => {
    const source = byElectrode.get(anode)
    const reference = byElectrode.get(cathode)
    if (source === undefined || reference === undefined || !compatible(header, [source, reference])) return []
    return [{ source, reference, label: `${anode}-${cathode}` }]
  })
}

export function longitudinalMontage(header: EdfHeader): ChannelSelection[] {
  return bipolarMontage(header, LONGITUDINAL_PAIRS)
}

export function transverseMontage(header: EdfHeader): ChannelSelection[] {
  return bipolarMontage(header, TRANSVERSE_PAIRS)
}

export function czMontage(header: EdfHeader): ChannelSelection[] {
  const byElectrode = electrodeMap(header)
  const reference = byElectrode.get('CZ')
  if (reference === undefined) return []
  return CZ_REFERENCE_ORDER.flatMap((name) => {
    const source = byElectrode.get(name)
    if (source === undefined || !compatible(header, [source, reference])) return []
    return [{ source, reference, label: `${name}-CZ` }]
  })
}

export function laplacianMontage(header: EdfHeader): ChannelSelection[] {
  const byElectrode = electrodeMap(header)
  return LAPLACIAN_NEIGHBORS.flatMap(([name, adjacent]) => {
    const indices = [name, ...adjacent].map((electrodeName) => byElectrode.get(electrodeName))
    if (indices.some((index) => index === undefined)) return []
    const [source, ...neighbors] = indices as number[]
    return compatible(header, [source, ...neighbors]) ? [{ source, neighbors, label: `${name}-LAP` }] : []
  })
}
