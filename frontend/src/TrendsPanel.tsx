import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AeegPair, AeegPoint } from './aeeg'
import { FREQUENCIES } from './spectralTrends'
import type { SpectralPair, SpectralTrendChunk } from './spectralTrends'
import type { AeegStore } from './useAeeg'
import type { SpectralTrendStore } from './useSpectralTrends'

type Props = { pairs: AeegPair[]; store: AeegStore; spectralStore: SpectralTrendStore;
  spectralPairs: SpectralPair[];
  total: number; start: number; duration: number; onSeek: (time: number) => void }

function timeLabel(seconds: number): string {
  const total = Math.floor(seconds)
  const minutes = `${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  return total >= 3600 ? `${String(Math.floor(total / 3600)).padStart(2, '0')}:${minutes}` : minutes
}

function yPosition(amplitude: number, height: number): number {
  const scaled = amplitude <= 10 ? amplitude / 10 : 1 + Math.log10(amplitude / 10)
  const maximum = 1 + Math.log10(20)
  return height - 15 - Math.min(maximum, Math.max(0, scaled)) / maximum * (height - 24)
}

function TrendChart({ label, points, viewStart, viewDuration, start, duration, onSeek, onZoom }: {
  label: string; points: AeegPoint[]; viewStart: number; viewDuration: number;
  start: number; duration: number; onSeek: (time: number) => void;
  onZoom: (fraction: number, factor: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(280)
  const height = 76

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      event.preventDefault()
      const bounds = canvas.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - 29) / (bounds.width - 34)))
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1)
      onZoom(fraction, Math.exp(Math.max(-300, Math.min(300, delta)) / 500))
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [onZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 40) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    const left = 29
    const plotWidth = width - left - 5
    for (const amplitude of [0, 10, 50, 200]) {
      const y = yPosition(amplitude, height)
      context.strokeStyle = '#edf1f6'
      context.beginPath()
      context.moveTo(left, y)
      context.lineTo(width, y)
      context.stroke()
      context.fillStyle = '#798494'
      context.font = '9px system-ui, sans-serif'
      context.fillText(String(amplitude), 3, y + 3)
    }
    const buckets = Array.from({ length: Math.max(1, Math.floor(plotWidth)) }, () =>
      ({ lower: Infinity, upper: -Infinity }))
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (points[middle].time < viewStart) low = middle + 1
      else high = middle
    }
    for (let index = low; index < points.length && points[index].time < viewStart + viewDuration; index++) {
      const point = points[index]
      const column = Math.min(buckets.length - 1,
        Math.floor((point.time - viewStart) / viewDuration * buckets.length))
      buckets[column].lower = Math.min(buckets[column].lower, point.lower)
      buckets[column].upper = Math.max(buckets[column].upper, point.upper)
    }
    context.strokeStyle = '#3968bb'
    context.lineWidth = 1
    for (let column = 0; column < buckets.length; column++) {
      const bucket = buckets[column]
      if (!Number.isFinite(bucket.lower)) continue
      context.beginPath()
      context.moveTo(left + column + 0.5, yPosition(bucket.lower, height))
      context.lineTo(left + column + 0.5, yPosition(bucket.upper, height))
      context.stroke()
    }
    const from = left + Math.max(0, (start - viewStart) / viewDuration) * plotWidth
    const to = left + Math.min(1, (start + duration - viewStart) / viewDuration) * plotWidth
    const top = yPosition(200, height)
    const bottom = yPosition(0, height)
    if (to > from && to >= left && from <= left + plotWidth) {
      context.fillStyle = '#e8974540'
      context.fillRect(from, top, Math.max(2, to - from), bottom - top)
      context.strokeStyle = '#d17a2b'
      context.beginPath()
      context.moveTo(from, top)
      context.lineTo(from, bottom)
      context.stroke()
    }
    context.fillStyle = '#647183'
    context.textAlign = 'left'
    context.fillText(timeLabel(viewStart), left, height - 2)
    context.textAlign = 'right'
    context.fillText(timeLabel(viewStart + viewDuration), width - 5, height - 2)
  }, [points, width, viewStart, viewDuration, start, duration])

  return <section className="trend-chart">
    <strong>{label}</strong>
    <canvas ref={canvasRef} style={{ width: '100%', height }} aria-label={`${label} aEEG amplitude band in µV`}
      role="img"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const fraction = (event.clientX - bounds.left - 29) / (bounds.width - 34)
        if (fraction >= 0 && fraction <= 1) onSeek(viewStart + fraction * viewDuration)
      }} />
  </section>
}

function SpectralChart({ label, chunks, kind, side, viewStart, viewDuration, start, duration, onSeek, onZoom }: {
  label: string; chunks: SpectralTrendChunk[]; kind: 'asymmetry' | 'rhythm'; side?: 0 | 1;
  viewStart: number; viewDuration: number; start: number; duration: number;
  onSeek: (time: number) => void; onZoom: (fraction: number, factor: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(280)
  const height = 100
  const left = 29

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      event.preventDefault()
      const bounds = canvas.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - left) / (bounds.width - left - 5)))
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1)
      onZoom(fraction, Math.exp(Math.max(-300, Math.min(300, delta)) / 500))
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [onZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 40) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    const plotWidth = width - left - 5
    const plotTop = 12
    const plotHeight = height - plotTop - 20
    const columns = Math.max(1, Math.floor(plotWidth))
    const values = new Float64Array(columns * FREQUENCIES)
    const counts = new Uint32Array(values.length)
    for (const chunk of chunks) {
      if (chunk.start >= viewStart + viewDuration || chunk.start + chunk.count <= viewStart) continue
      const first = Math.max(0, Math.ceil(viewStart - chunk.start - 0.5))
      const last = Math.min(chunk.count, Math.ceil(viewStart + viewDuration - chunk.start - 0.5))
      const data = kind === 'asymmetry' ? chunk.asymmetry : chunk.rhythm[side ?? 0]
      for (let epoch = first; epoch < last; epoch++) {
        const column = Math.min(columns - 1, Math.floor((chunk.start + epoch + 0.5 - viewStart) / viewDuration * columns))
        if (column < 0) continue
        for (let frequency = 0; frequency < FREQUENCIES; frequency++) {
          const value = data[epoch * FREQUENCIES + frequency]
          if (!Number.isFinite(value)) continue
          const index = (FREQUENCIES - frequency - 1) * columns + column
          values[index] = kind === 'asymmetry' ? values[index] + value : Math.max(values[index], value)
          counts[index]++
        }
      }
    }
    const rowHeight = plotHeight / FREQUENCIES
    for (let frequency = 0; frequency < FREQUENCIES; frequency++) {
      for (let column = 0; column < columns; column++) {
        const index = frequency * columns + column
        const value = kind === 'asymmetry' ? values[index] / counts[index] : values[index]
        if (!counts[index]) context.fillStyle = '#f1f3f6'
        else if (kind === 'asymmetry') {
          const strength = Math.min(1, Math.abs(value))
          const fade = Math.round(245 * (1 - strength))
          context.fillStyle = value < 0 ? `rgb(${fade},${fade + Math.round(10 * strength)},245)`
            : `rgb(245,${fade},${fade})`
        } else {
          const strength = Math.min(1, value)
          context.fillStyle = `rgb(${Math.round(245 - 165 * strength)},${Math.round(248 - 205 * strength)},${Math.round(252 - 95 * strength)})`
        }
        context.fillRect(left + column, plotTop + frequency * rowHeight, 1, Math.ceil(rowHeight))
      }
    }
    const from = left + Math.max(0, (start - viewStart) / viewDuration) * plotWidth
    const to = left + Math.min(1, (start + duration - viewStart) / viewDuration) * plotWidth
    if (to > from && to >= left && from <= left + plotWidth) {
      context.fillStyle = '#e8974533'
      context.fillRect(from, plotTop, Math.max(2, to - from), plotHeight)
      context.strokeStyle = '#d17a2b'
      context.beginPath()
      context.moveTo(from, plotTop)
      context.lineTo(from, plotTop + plotHeight)
      context.stroke()
    }
    context.fillStyle = '#647183'
    context.font = '9px system-ui, sans-serif'
    for (const frequency of [5, 10, 15, 20, 25]) {
      context.fillText(String(frequency), 4, plotTop + (FREQUENCIES - frequency + 0.5) * rowHeight + 3)
    }
    context.textAlign = 'left'
    context.fillText(timeLabel(viewStart), left, height - 2)
    context.textAlign = 'right'
    context.fillText(timeLabel(viewStart + viewDuration), width - 5, height - 2)
  }, [chunks, kind, side, width, viewStart, viewDuration, start, duration])

  return <section className="trend-chart">
    <strong>{label}</strong>
    <canvas ref={canvasRef} style={{ width: '100%', height }} role="img" aria-label={`${label}, 1–25 Hz over time`}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const fraction = (event.clientX - bounds.left - left) / (bounds.width - left - 5)
        if (fraction >= 0 && fraction <= 1) onSeek(viewStart + fraction * viewDuration)
      }} />
  </section>
}

export function TrendsPanel({ pairs, store, spectralStore, spectralPairs, total, start, duration, onSeek }: Props) {
  const { points, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { chunks, error: spectralError } = useSyncExternalStore(spectralStore.subscribe, spectralStore.getSnapshot)
  const [view, setView] = useState({ start: 0, duration: total })
  const viewDuration = Math.min(view.duration, total)
  const viewStart = Math.max(0, Math.min(view.start, total - viewDuration))
  const minimum = Math.min(total, 10)
  function zoom(fraction: number, factor: number) {
    const nextDuration = Math.max(minimum, Math.min(total, viewDuration * factor))
    const cursorTime = viewStart + fraction * viewDuration
    setView({ start: Math.max(0, Math.min(total - nextDuration, cursorTime - fraction * nextDuration)),
      duration: nextDuration })
  }

  return <div className="trends-panel">
    <h3>Amplitude-integrated EEG</h3>
    {!pairs.length ? <p role="status">No matched left/right bipolar EEG derivations (C3–P3/C4–P4, Fp1–F7/Fp2–F8, or F3–C3/F4–C4) with compatible voltage units and sampling rates.</p> : <>
      {error && <p role="alert">aEEG processing stopped: {error}</p>}
      {pairs.map((pair, index) => <TrendChart key={pair.label} label={`${index === 0 ? 'Left' : 'Right'} · ${pair.label}`} points={points[index] ?? []}
        viewStart={viewStart} viewDuration={viewDuration} start={start} duration={duration} onSeek={onSeek} onZoom={zoom} />)}
    </>}
    {spectralPairs.length > 0 && <>
      <h3>Left–right spectral asymmetry</h3>
      {spectralError && <p role="alert">Spectral trends stopped: {spectralError}</p>}
      <SpectralChart label="Left / Right" chunks={chunks} kind="asymmetry"
        viewStart={viewStart} viewDuration={viewDuration} start={start} duration={duration} onSeek={onSeek} onZoom={zoom} />
      <h3>Persistent spectral peaks</h3>
      {(['Left', 'Right'] as const).map((side, index) => <SpectralChart key={side} label={side}
        chunks={chunks} kind="rhythm" side={index as 0 | 1} viewStart={viewStart} viewDuration={viewDuration}
        start={start} duration={duration} onSeek={onSeek} onZoom={zoom} />)}
    </>}
  </div>
}
