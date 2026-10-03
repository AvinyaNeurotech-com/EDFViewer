import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnnotationNameEditor } from './AnnotationNameEditor'
import { SpectrumPlot } from './SpectrumPlot'
import type { SpectrumResult, SpectrumSelection } from './SpectrumPlot'
import type { EdfHeader, Trace } from './edf'
import { auxiliaryKind } from './montage'
import type { ChannelSelection } from './montage'
import type { SpectralResult } from './spectral'
import { visibleArtifactBoxes } from './artifactBoxes'
import type { ArtifactBox } from './artifactDetection'
import { channelSensitivity, drawBackground, drawLabel, drawTrace, LABEL_WIDTH, rowTop, TICK_HEIGHT,
  SPECTRAL_HEIGHT, tickSpacing, traceColor } from './waveformRender'

export { LABEL_WIDTH } from './waveformRender'
export { TICK_HEIGHT } from './waveformRender'
export type Annotation = { id: number; time: number; duration: number; label: string; visible: boolean }
export type DisplaySettings = {
  sensitivity: number
  rowHeight: number
  centered: boolean
  inverted: boolean
  grid: boolean
}

type Props = {
  traces: Trace[]
  start: number
  duration: number
  width: number
  display: DisplaySettings
  channelKeys: string[]
  mutedChannelKeys: string[]
  onToggleChannel: (channelKey: string) => void
  channelSensitivityOffsets: Record<string, number>
  onChannelSensitivityChange: (channelKey: string, step: number) => void
  annotations: Annotation[]
  draft: { anchor: number; end: number } | null
  pending: { time: number; duration: number } | null
  annotationLabel: string
  onLabelChange: (label: string) => void
  onSaveAnnotation: () => void
  onCancelAnnotation: () => void
  selectedAnnotation: number | null
  onSelectAnnotation: (id: number) => void
  editingAnnotation: number | null
  onEditAnnotation: (id: number) => void
  onRenameAnnotation: (id: number, label: string) => void
  onCancelRename: () => void
  onRemoveAnnotation: (id: number) => void
  header: EdfHeader | null
  channels: ChannelSelection[]
  spectrogramEnabled: boolean
  spectralResult: SpectralResult | null
  artifactBoxes: ArtifactBox[]
  spectrumSelection: SpectrumSelection | null
  spectrumDraft: SpectrumSelection | null
  spectrumResult: SpectrumResult | null
  spectrumPanelRef: React.RefObject<HTMLDivElement | null>
  spectrumMode: boolean
  onCloseSpectrum: () => void
}

export function Waveform({ traces, start, duration, width, display, channelKeys,
  mutedChannelKeys, onToggleChannel, channelSensitivityOffsets, onChannelSensitivityChange, annotations, draft, pending,
  annotationLabel, onLabelChange, onSaveAnnotation, onCancelAnnotation,
  selectedAnnotation, onSelectAnnotation, editingAnnotation, onEditAnnotation,
  onRenameAnnotation, onCancelRename, onRemoveAnnotation,
  header, channels, spectrogramEnabled, spectralResult, artifactBoxes,
  spectrumSelection, spectrumDraft, spectrumResult, spectrumPanelRef, spectrumMode, onCloseSpectrum }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLCanvasElement>(null)
  const annotationInputRef = useRef<HTMLInputElement>(null)
  const ticksRef = useRef<HTMLCanvasElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const { rowHeight } = display
  const spectralHeight = spectrogramEnabled ? SPECTRAL_HEIGHT : 0
  const firstAuxiliary = traces.findIndex((trace) => auxiliaryKind(trace.label) !== null)
  const auxiliaryGap = firstAuxiliary > 0 ? 16 : 0
  const height = (traces.length + 2) * rowHeight + traces.length * spectralHeight + auxiliaryGap
  const labelKey = JSON.stringify(traces.map(({ label, unit }) => [label, unit]))
  const gridPeriod = Math.max(1, tickSpacing(duration))
  const gridPhase = Math.round((((start % gridPeriod) + gridPeriod) % gridPeriod) / gridPeriod * 1e6) % 1e6
  const position = (time: number) => Math.max(0, Math.min(1, (time - start) / duration))
  const marker = (time: number, length: number) => ({
    left: `${position(time) * 100}%`,
    width: length ? `${(position(time + length) - position(time)) * 100}%` : undefined,
  })
  useLayoutEffect(() => {
    const panel = spectrumPanelRef.current
    if (!panel || !artifactBoxes.length) return
    const update = () => {
      const top = panel.scrollTop
      const height = panel.clientHeight
      setViewport((previous) => previous.top === top && previous.height === height ? previous : { top, height })
    }
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    panel.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); panel.removeEventListener('scroll', onScroll) }
  }, [artifactBoxes.length, spectrumPanelRef])
  const analysisBoxes = useMemo(() => visibleArtifactBoxes(artifactBoxes, traces, start, duration,
    width, height, viewport.top, viewport.height, display, channelKeys, mutedChannelKeys,
    channelSensitivityOffsets, firstAuxiliary, auxiliaryGap, spectralHeight, spectrogramEnabled),
  [artifactBoxes, traces, start, duration, width, height, viewport, display, channelKeys,
    mutedChannelKeys, channelSensitivityOffsets, firstAuxiliary, auxiliaryGap, spectralHeight, spectrogramEnabled])

  useLayoutEffect(() => {
    if (pending) annotationInputRef.current?.focus({ preventScroll: true })
  }, [pending])

  useLayoutEffect(() => {
    const labelsCanvas = labelsRef.current
    if (!labelsCanvas) return
    const ratio = window.devicePixelRatio || 1
    labelsCanvas.width = Math.round(LABEL_WIDTH * ratio)
    labelsCanvas.height = Math.round(height * ratio)
    const context = labelsCanvas.getContext('2d')!
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, LABEL_WIDTH, height)
    context.font = '10px system-ui, sans-serif'
    context.fillStyle = '#555d6b'
    context.fillText('TIME', 5, 16)
    const labels: [string, string][] = JSON.parse(labelKey)
    labels.forEach(([label, unit], index) => {
      const row = rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight)
      context.globalAlpha = mutedChannelKeys.includes(channelKeys[index]) ? 0.4 : 1
      drawLabel(context, { label, unit }, index, display, channelKeys, channelSensitivityOffsets,
        firstAuxiliary, spectralHeight)
      context.globalAlpha = 1
      context.strokeStyle = '#eceef3'
      context.beginPath()
      context.moveTo(0, row + rowHeight - 0.5)
      context.lineTo(LABEL_WIDTH, row + rowHeight - 0.5)
      context.stroke()
    })
  }, [labelKey, height, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight,
    display, channelKeys, channelSensitivityOffsets, mutedChannelKeys])

  useLayoutEffect(() => {
    const grid = gridRef.current
    const panel = canvasRef.current?.parentElement?.parentElement
    if (!grid || !panel || width <= LABEL_WIDTH) return
    const drawGrid = () => {
      const top = panel.scrollTop
      const bottom = Math.min(height, top + panel.clientHeight)
      const gridHeight = Math.round(bottom - top)
      if (grid.width !== width) grid.width = width
      if (grid.height !== gridHeight) grid.height = gridHeight
      grid.style.height = `${bottom - top}px`
      const context = grid.getContext('2d')!
      context.setTransform(1, 0, 0, 1, 0, -top)
      context.fillStyle = '#fff'
      context.fillRect(0, top, width, bottom - top)
      drawBackground(context, traces.length, gridPhase / 1e6 * gridPeriod, duration,
        width, top, bottom, { rowHeight, grid: display.grid }, firstAuxiliary, spectralHeight)
    }
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(drawGrid)
    }
    drawGrid()
    panel.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      panel.removeEventListener('scroll', onScroll)
    }
  }, [gridPhase, gridPeriod, duration, width, height, traces.length, rowHeight,
    display.grid, firstAuxiliary, spectralHeight])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= LABEL_WIDTH) return
    const panel = canvas.parentElement?.parentElement
    const tickRatio = window.devicePixelRatio || 1
    const plotWidth = width - LABEL_WIDTH
    const spacing = tickSpacing(duration)
    const drawCanvas = (viewportTop: number, viewportBottom: number) => {
    const canvasHeight = viewportBottom - viewportTop
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== Math.round(canvasHeight)) canvas.height = Math.round(canvasHeight)
    const context = canvas.getContext('2d')!
    context.setTransform(1, 0, 0, 1, 0, -viewportTop)
    context.clearRect(0, viewportTop, width, canvasHeight)

    const paintTrace = (index: number) => {
      if (mutedChannelKeys.includes(channelKeys[index])) return
      drawTrace(context, traces[index], index, width,
        viewportTop, viewportBottom, display, channelKeys, channelSensitivityOffsets,
        firstAuxiliary, auxiliaryGap, spectralHeight, traceColor(traces[index].label), spectrogramEnabled)
    }

    const drawSpectrogram = (index: number) => {
      if (!spectrogramEnabled) return
      const result = spectralResult
      const top = rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight) + rowHeight + 2
      const tile = result?.tiles[index]
      context.fillStyle = '#f4f6fa'
      context.fillRect(LABEL_WIDTH, top, plotWidth, spectralHeight - 4)
      if (!tile?.some((value) => value !== 0)) return
      const bitmap = document.createElement('canvas')
      bitmap.width = result!.columnCount
      bitmap.height = result!.rowCount
      const tileContext = bitmap.getContext('2d')!
      const image = tileContext.createImageData(bitmap.width, bitmap.height)
      for (let row = 0; row < result!.rowCount; row++) {
        for (let column = 0; column < result!.columnCount; column++) {
          const value = tile[row * result!.columnCount + column]
          const offset = ((result!.rowCount - row - 1) * result!.columnCount + column) * 4
          const strength = value / 255
          image.data[offset] = value ? Math.round(20 + strength * 232) : 244
          image.data[offset + 1] = value ? Math.round(45 + strength * 130) : 246
          image.data[offset + 2] = value ? Math.round(95 - strength * 62) : 250
          image.data[offset + 3] = 255
        }
      }
      tileContext.putImageData(image, 0, 0)
      context.imageSmoothingEnabled = false
      context.drawImage(bitmap, LABEL_WIDTH, top, plotWidth, spectralHeight - 4)
      context.imageSmoothingEnabled = true
      context.font = '9px system-ui, sans-serif'
      context.fillStyle = '#758398'
      const rate = header!.signals[typeof channels[index] === 'number' ? channels[index] : channels[index].source]
        .samplesPerRecord / header!.recordDuration
      context.fillText(`${Math.min(40, Math.floor(rate / 2))} Hz`, 3, top + 10, LABEL_WIDTH - 8)
      context.fillText('1 Hz', 3, top + spectralHeight - 7, LABEL_WIDTH - 8)
    }

    const drawChannel = (index: number) => {
      paintTrace(index)
      drawSpectrogram(index)
    }
    return { drawChannel }
    }

    const drawVisible = () => {
      const top = panel?.scrollTop ?? 0
      const bottom = Math.min(height, top + (panel?.clientHeight ?? height))
      canvas.style.height = `${bottom - top}px`
      const { drawChannel } = drawCanvas(top, bottom)
      traces.forEach((_, index) => {
        const channelTop = rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight)
        if (channelTop < bottom && channelTop + rowHeight >= top) drawChannel(index)
      })
    }
    drawVisible()
    const ticks = ticksRef.current
    if (!ticks) return
    if (ticks.width !== Math.round(width * tickRatio)) ticks.width = Math.round(width * tickRatio)
    if (ticks.height !== Math.round(TICK_HEIGHT * tickRatio)) ticks.height = Math.round(TICK_HEIGHT * tickRatio)
    const tickContext = ticks.getContext('2d')
    if (!tickContext) return
    tickContext.setTransform(tickRatio, 0, 0, tickRatio, 0, 0)
    tickContext.clearRect(0, 0, width, TICK_HEIGHT)
    tickContext.font = '10px system-ui, sans-serif'
    tickContext.fillStyle = '#555d6b'
    for (let tick = Math.ceil(start / spacing); tick * spacing < start + duration; tick++) {
      const time = tick * spacing
      const position = LABEL_WIDTH + (time - start) / duration * plotWidth
      tickContext.fillText(`${Number(time.toFixed(2))}s`, position + 4, 16)
    }
    let scrollFrame = 0
    const onScroll = () => {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = requestAnimationFrame(drawVisible)
    }
    panel?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(scrollFrame)
      panel?.removeEventListener('scroll', onScroll)
    }
  }, [traces, start, duration, width, display,
    rowHeight, firstAuxiliary, auxiliaryGap,
    channelKeys, channelSensitivityOffsets, mutedChannelKeys, spectrogramEnabled, spectralResult, spectralHeight, header, channels, height])

  const controls = traces.map((trace, index) => <div key={channelKeys[index] ?? index} className="channel-sensitivity-controls"
    style={{ top: rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight) + rowHeight / 2 - 12 }}>
    <button type="button" aria-label={`Increase ${trace.label} sensitivity by 5 µV/div`}
      disabled={channelSensitivity(index, display.sensitivity, channelKeys, channelSensitivityOffsets) >= 10000}
      onClick={() => onChannelSensitivityChange(channelKeys[index], 5)}>+</button>
    <button type="button" aria-label={`Decrease ${trace.label} sensitivity by 5 µV/div`}
      disabled={channelSensitivity(index, display.sensitivity, channelKeys, channelSensitivityOffsets) <= 0.05}
      onClick={() => onChannelSensitivityChange(channelKeys[index], -5)}>−</button>
  </div>)

  return <div className="waveform-content" style={{ width, height }}>
    <canvas ref={ticksRef} className="sticky-time-markings" style={{ width, height: TICK_HEIGHT }} aria-hidden="true" />
    <div className="grid-layer" aria-hidden="true">
      <canvas ref={gridRef} className="grid-canvas" style={{ width }} />
    </div>
    <canvas ref={canvasRef} className="viewport-waveform" style={{ width }} role="img"
      aria-label={`${traces.length} EEG signal traces from ${start.toFixed(2)} to ${(start + duration).toFixed(2)} seconds`} />
    <canvas ref={labelsRef} className="channel-labels" style={{ width: LABEL_WIDTH, height }} aria-hidden="true" />
    {traces.map((trace, index) => <button key={channelKeys[index]} type="button" className="channel-visibility-toggle"
      style={{ top: rowTop(index, rowHeight, firstAuxiliary, auxiliaryGap, spectralHeight), height: rowHeight }}
      aria-label={`${mutedChannelKeys.includes(channelKeys[index]) ? 'Show' : 'Hide'} ${trace.label} waveform`}
      aria-pressed={!mutedChannelKeys.includes(channelKeys[index])}
      onClick={() => onToggleChannel(channelKeys[index])} />)}
    <div className="analysis-layer" aria-hidden="true">
      {analysisBoxes.map((box, index) =>
        <div key={index} className="analysis-box" style={{
          left: box.left, width: box.right - box.left,
          top: box.top, height: box.bottom - box.top,
        }} />)}
    </div>
    {spectrumDraft && <div className="spectrum-layer"><div className="spectrum-selection" style={{
      left: LABEL_WIDTH + (Math.min(spectrumDraft.anchor, spectrumDraft.end) - start) / duration * (width - LABEL_WIDTH),
      width: Math.max(2, Math.abs(spectrumDraft.end - spectrumDraft.anchor) / duration * (width - LABEL_WIDTH)),
      top: Math.min(spectrumDraft.anchorY, spectrumDraft.endY),
      height: Math.max(3, Math.abs(spectrumDraft.endY - spectrumDraft.anchorY)),
    }} /></div>}
    {spectrumSelection && channelKeys[spectrumSelection.index] === spectrumSelection.channelKey &&
      <SpectrumPlot selection={spectrumSelection} result={spectrumResult} label={traces[spectrumSelection.index].label}
        width={width} start={start} duration={duration} panelRef={spectrumPanelRef} onClose={onCloseSpectrum} />}
    <div className="annotation-layer" aria-label="Annotations" inert={spectrumMode}>
      {annotations.filter((annotation) => annotation.time <= start + duration && annotation.time + annotation.duration >= start)
        .map((annotation) => <div key={annotation.id}
          className={`annotation-mark${annotation.duration ? ' annotation-segment' : ''}`}
          style={marker(annotation.time, annotation.duration)}>
          {annotation.time >= start && <div className="annotation-tag"
            style={position(annotation.time) > 0.75 ? { transform: 'translateX(-100%)' } : undefined}>
            {editingAnnotation === annotation.id
              ? <AnnotationNameEditor label={annotation.label}
                  onSave={(label) => onRenameAnnotation(annotation.id, label)} onCancel={onCancelRename} />
              : <button type="button" aria-label={`Edit ${annotation.label}`}
                  onClick={() => { onSelectAnnotation(annotation.id); onEditAnnotation(annotation.id) }}>{annotation.label}</button>}
            {selectedAnnotation === annotation.id && <button type="button" aria-label={`Remove ${annotation.label}`}
              onClick={() => onRemoveAnnotation(annotation.id)}>×</button>}
          </div>}
        </div>)}
      {draft && <div className={`annotation-mark${draft.anchor !== draft.end ? ' annotation-segment' : ''} annotation-draft`}
        style={marker(Math.min(draft.anchor, draft.end), Math.abs(draft.anchor - draft.end))} />}
      {pending && <div className={`annotation-mark${pending.duration ? ' annotation-segment' : ''} annotation-draft`}
        style={marker(pending.time, pending.duration)}>
        <form className="annotation-tag annotation-entry"
          style={position(pending.time) > 0.75 ? { transform: 'translateX(-100%)' } : undefined}
          onSubmit={(event) => { event.preventDefault(); onSaveAnnotation() }}>
          <input ref={annotationInputRef} aria-label="Annotation name" maxLength={80} placeholder="Annotation name" value={annotationLabel}
            onChange={(event) => onLabelChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancelAnnotation() } }} />
          <button type="submit" disabled={!annotationLabel.trim()} aria-label="Save annotation">✓</button>
          <button type="button" aria-label="Cancel annotation" onClick={onCancelAnnotation}>×</button>
        </form>
      </div>}
    </div>
    {controls}
    {spectrogramEnabled && spectralResult?.error &&
      <span className="spectral-error" role="alert">{spectralResult.error}</span>}
  </div>
}
