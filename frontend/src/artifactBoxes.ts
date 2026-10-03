import type { Trace } from './edf'
import type { ArtifactBox } from './artifactDetection'
import { LABEL_WIDTH, rowTop, TICK_HEIGHT, traceValueToY } from './waveformRender'
import type { TraceDisplay } from './waveformRender'

export type Box = { left: number; right: number; top: number; bottom: number }

export function mergeNearbyBoxes(boxes: Box[], horizontalGap = 10, verticalGap = 8): Box[] {
  const merged: Box[] = []
  for (const box of boxes) {
    const current = { ...box }
    for (let index = 0; index < merged.length;) {
      const other = merged[index]
      if (current.left <= other.right + horizontalGap && other.left <= current.right + horizontalGap &&
          current.top <= other.bottom + verticalGap && other.top <= current.bottom + verticalGap) {
        current.left = Math.min(current.left, other.left)
        current.right = Math.max(current.right, other.right)
        current.top = Math.min(current.top, other.top)
        current.bottom = Math.max(current.bottom, other.bottom)
        merged.splice(index, 1)
        index = 0
      } else index++
    }
    merged.push(current)
  }
  return merged
}

export function visibleArtifactBoxes(boxes: ArtifactBox[], traces: Trace[], start: number, duration: number,
  width: number, height: number, scrollTop: number, viewportHeight: number, display: TraceDisplay,
  channelKeys: string[], mutedChannelKeys: string[], offsets: Record<string, number>,
  firstAuxiliary: number, auxiliaryGap: number, spectralHeight: number, spectrogramEnabled: boolean): Box[] {
  const viewportBottom = Math.min(height, scrollTop + viewportHeight)
  const plotWidth = width - LABEL_WIDTH
  if (plotWidth <= 0 || viewportBottom - scrollTop < 12) return []
  const candidates: Box[] = []
  for (const box of boxes) {
    const trace = traces[box.channel]
    if (!trace || mutedChannelKeys.includes(channelKeys[box.channel])) continue
    const row = rowTop(box.channel, display.rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight)
    if (row + display.rowHeight < scrollTop || row > viewportBottom) continue
    const left = LABEL_WIDTH + (box.start - start) / duration * plotWidth - 4
    const right = LABEL_WIDTH + (box.end - start) / duration * plotWidth + 4
    if (right <= LABEL_WIDTH || left >= width) continue
    const valueToY = traceValueToY(trace, box.channel, display, channelKeys, offsets,
      firstAuxiliary, auxiliaryGap, spectralHeight)
    let top = row
    let bottom = row + display.rowHeight
    for (let index = 0; index < trace.positions.length; index++) {
      const x = LABEL_WIDTH + trace.positions[index]
      if (x < left || x > right) continue
      const first = trace.mode === 'min-max' ? index * 2 : index
      const last = trace.mode === 'min-max' ? first + 1 : first
      for (let valueIndex = first; valueIndex <= last; valueIndex++) {
        const y = valueToY(trace.values[valueIndex])
        if (!Number.isFinite(y)) continue
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    if (spectrogramEnabled) {
      top = Math.max(row, top)
      bottom = Math.min(row + display.rowHeight, bottom)
    }
    candidates.push({ left, right, top: top - 4, bottom: bottom + 4 })
  }
  return mergeNearbyBoxes(candidates).flatMap((box) => {
    const left = Math.max(LABEL_WIDTH + 4, box.left)
    const right = Math.min(width - 4, box.right)
    const top = Math.max(scrollTop + TICK_HEIGHT + 4, box.top)
    const bottom = Math.min(viewportBottom - 4, box.bottom)
    return right - left >= 4 && bottom - top >= 4 ? [{ left, right, top, bottom }] : []
  })
}
