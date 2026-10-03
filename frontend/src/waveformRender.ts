import type { Trace } from './edf'
import { auxiliaryKind } from './montage'

export const LABEL_WIDTH = 56
export const TICK_HEIGHT = 20
export const PIXELS_PER_DIVISION = 14
export const SPECTRAL_HEIGHT = 50

export function traceColor(label: string): string {
  const kind = auxiliaryKind(label)
  if (kind === 'ecg') return '#15803d'
  if (kind === 'eog') return '#8645ac'
  if (kind === 'emg') return '#ad631b'
  if (kind === 'respiration') return '#087f92'
  if (kind === 'other') return '#536272'
  const electrode = label.trim().replace(/^EEG\s+/i, '').split('-')[0]
  const number = electrode.match(/\d+/)?.[0]
  return number ? Number(number) % 2 ? '#325cda' : '#d04c69' : '#343c49'
}

export type TraceDisplay = {
  sensitivity: number
  rowHeight: number
  centered: boolean
  inverted: boolean
  grid: boolean
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function tickSpacing(duration: number): number {
  const ideal = duration / 8
  const magnitude = 10 ** Math.floor(Math.log10(ideal))
  return [1, 2, 5, 10].map((step) => step * magnitude).find((step) => step >= ideal) ?? 10 * magnitude
}

export function drawBackground(context: Context, channelCount: number, start: number, duration: number,
  width: number, top: number, bottom: number, display: Pick<TraceDisplay, 'rowHeight' | 'grid'>, firstAuxiliary: number,
  spectralHeight: number) {
  const plotWidth = width - LABEL_WIDTH
  if (display.grid) {
    const spacing = tickSpacing(duration)
    let subdivision = spacing / 10
    while (subdivision * plotWidth / duration < 12) subdivision *= 2
    const firstTick = Math.ceil((start - 0.000001 * subdivision) / subdivision)
    const lastTick = Math.floor((start + duration - 0.000001 * subdivision) / subdivision)
    for (let tick = firstTick; tick <= lastTick; tick++) {
      const time = tick * subdivision
      const position = LABEL_WIDTH + (time - start) / duration * plotWidth
      const major = Math.abs(time - Math.round(time)) < 0.000001 ||
        Math.abs(time / spacing - Math.round(time / spacing)) < 0.000001
      context.strokeStyle = major ? '#cdd2dc' : '#e9ebf0'
      context.setLineDash(major ? [] : [2, 4])
      context.beginPath()
      context.moveTo(position, top)
      context.lineTo(position, bottom)
      context.stroke()
    }
    context.setLineDash([])
  }
  const auxiliaryGap = firstAuxiliary > 0 ? 16 : 0
  for (let index = 0; index < channelCount; index++) {
    const row = rowTop(index, display.rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight)
    if (row >= bottom || row + display.rowHeight < top) continue
    const center = row + display.rowHeight / 2
    context.strokeStyle = '#eceef3'
    context.beginPath()
    context.moveTo(0, row + display.rowHeight - 0.5)
    context.lineTo(width, row + display.rowHeight - 0.5)
    context.stroke()
    if (display.grid) {
      context.strokeStyle = '#e6e8ed'
      context.setLineDash([2, 4])
      context.beginPath()
      const divisions = Math.floor((display.rowHeight / 2 - 2) / PIXELS_PER_DIVISION)
      for (let division = -divisions; division <= divisions; division++) {
        const position = center + division * PIXELS_PER_DIVISION
        context.moveTo(LABEL_WIDTH, position)
        context.lineTo(width, position)
      }
      context.stroke()
      context.setLineDash([])
    }
  }
  if (auxiliaryGap) {
    const boundary = rowTop(firstAuxiliary, display.rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight) - auxiliaryGap / 2
    if (boundary >= top && boundary <= bottom) {
      context.strokeStyle = '#c5cbd5'
      context.beginPath()
      context.moveTo(0, boundary)
      context.lineTo(width, boundary)
      context.stroke()
    }
  }
}

export function drawLabel(context: Context, trace: Pick<Trace, 'label' | 'unit'>, index: number, display: TraceDisplay,
  keys: string[], offsets: Record<string, number>, firstAuxiliary: number, spectralHeight: number) {
  const center = rowTop(index, display.rowHeight, firstAuxiliary, firstAuxiliary > 0 ? 16 : 0,
    spectralHeight) + display.rowHeight / 2
  const sensitivity = channelSensitivity(index, display.sensitivity, keys, offsets)
  const multiplier = microvoltMultiplier(trace.unit)
  context.fillStyle = '#3e4859'
  context.font = '10px system-ui, sans-serif'
  context.fillText(trace.label.slice(0, 12), 5, center - 2, LABEL_WIDTH - 23)
  context.fillStyle = '#929ca8'
  context.font = '9px system-ui, sans-serif'
  context.fillText(multiplier === null
    ? `auto ×${Number((200 / sensitivity).toFixed(2))}`
    : `${Number(sensitivity.toFixed(2))} µV`, 5, center + 10, LABEL_WIDTH - 23)
}

export function rowTop(index: number, rowHeight: number, firstAuxiliary: number, auxiliaryGap: number,
  spectralHeight: number): number {
  return rowHeight + index * (rowHeight + spectralHeight) +
    (auxiliaryGap && index >= firstAuxiliary ? auxiliaryGap : 0)
}

export function microvoltMultiplier(unit: string): number | null {
  const normalized = unit.trim().toLowerCase().replaceAll('µ', 'u').replaceAll('μ', 'u')
  if (normalized === 'uv') return 1
  if (normalized === 'mv') return 1000
  if (normalized === 'v') return 1_000_000
  return null
}

export function channelSensitivity(index: number, sensitivity: number, keys: string[], offsets: Record<string, number>): number {
  return Math.max(0.05, Math.min(10000, sensitivity + (offsets[keys[index]] ?? 0)))
}

export function traceValueToY(trace: Trace, index: number, display: TraceDisplay, keys: string[],
  offsets: Record<string, number>, firstAuxiliary: number, auxiliaryGap: number, spectralHeight: number) {
  const center = rowTop(index, display.rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight) + display.rowHeight / 2
  const sensitivity = channelSensitivity(index, display.sensitivity, keys, offsets)
  const multiplier = microvoltMultiplier(trace.unit)
  const range = Math.max(trace.high - trace.low, 0.000001)
  const baseline = display.centered ? (trace.high + trace.low) / 2 : 0
  const scale = multiplier === null
    ? display.rowHeight * 0.78 / range * 200 / sensitivity
    : PIXELS_PER_DIVISION * multiplier / sensitivity
  return (value: number) => center - (value - baseline) * scale * (display.inverted ? -1 : 1)
}

export function drawTrace(context: Context, trace: Trace,
  index: number, width: number, top: number, bottom: number, display: TraceDisplay, keys: string[],
  offsets: Record<string, number>, firstAuxiliary: number, auxiliaryGap: number, spectralHeight: number,
  color: string, spectrogramEnabled: boolean, visibleLeft = LABEL_WIDTH, visibleRight = width) {
  if (!trace.values.length) return
  const { rowHeight } = display
  const center = rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight) + rowHeight / 2
  const valueToY = traceValueToY(trace, index, display, keys, offsets, firstAuxiliary, auxiliaryGap, spectralHeight)

  context.save()
  context.beginPath()
  context.rect(visibleLeft, top, visibleRight - visibleLeft, bottom - top)
  context.clip()
  if (spectrogramEnabled) {
    context.beginPath()
    context.rect(LABEL_WIDTH, center - rowHeight / 2, width - LABEL_WIDTH, rowHeight)
    context.clip()
  }
  context.strokeStyle = color
  context.lineWidth = 1
  if (trace.mode === 'min-max') {
    context.beginPath()
    for (let column = 0; column < trace.positions.length; column++) {
      const x = LABEL_WIDTH + trace.positions[column] + 0.5
      if (x < visibleLeft || x >= visibleRight) continue
      const upper = valueToY(trace.values[column * 2 + 1])
      const lower = valueToY(trace.values[column * 2])
      if (Math.max(upper, lower) < top || Math.min(upper, lower) > bottom) continue
      context.moveTo(x, upper)
      context.lineTo(x, upper === lower ? lower + 1 : lower)
    }
    context.stroke()
    context.restore()
    return
  }
  context.lineJoin = 'round'
  context.beginPath()
  let previousX = LABEL_WIDTH + trace.positions[0]
  let previousY = valueToY(trace.values[0])
  let drawing = false
  for (let point = 1; point < trace.values.length; point++) {
    const x = LABEL_WIDTH + trace.positions[point]
    const y = valueToY(trace.values[point])
    if ((previousX < visibleLeft && x < visibleLeft) || (previousX > visibleRight && x > visibleRight)) {
      drawing = false
      previousX = x
      previousY = y
      continue
    }
    if (!((previousY < top && y < top) || (previousY > bottom && y > bottom))) {
      let fromX = previousX
      let fromY = previousY
      let toX = x
      let toY = y
      if (fromY < top || fromY > bottom) {
        const edge = fromY < top ? top : bottom
        fromX += (x - fromX) * (edge - fromY) / (y - fromY)
        fromY = edge
        drawing = false
      }
      if (toY < top || toY > bottom) {
        const edge = toY < top ? top : bottom
        toX = fromX + (toX - fromX) * (edge - fromY) / (toY - fromY)
        toY = edge
      }
      if (!drawing) context.moveTo(fromX, fromY)
      context.lineTo(toX, toY)
      drawing = y >= top && y <= bottom
    } else drawing = false
    previousX = x
    previousY = y
  }
  if (trace.values.length === 1 && previousY >= top && previousY <= bottom) {
    context.moveTo(previousX, previousY)
    context.lineTo(previousX, previousY + 1)
  }
  context.stroke()
  context.restore()
}
