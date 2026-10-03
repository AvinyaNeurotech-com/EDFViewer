import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { LABEL_WIDTH } from './waveformRender'

export type SpectrumSelection = { index: number; channelKey: string; anchor: number; end: number;
  anchorY: number; endY: number; windowStart: number; windowDuration: number }
export type SpectrumResult = { frequencies: Float32Array; powers: Float32Array; error: string | null }

type Props = { selection: SpectrumSelection; result: SpectrumResult | null; label: string;
  width: number; start: number; duration: number; panelRef: RefObject<HTMLDivElement | null>; onClose: () => void }

export function SpectrumPlot({ selection, result, label, width, start, duration, panelRef, onClose }: Props) {
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const update = () => setViewport({ top: panel.scrollTop, height: panel.clientHeight })
    update()
    panel.addEventListener('scroll', update, { passive: true })
    return () => panel.removeEventListener('scroll', update)
  }, [panelRef])

  const left = LABEL_WIDTH + (Math.min(selection.anchor, selection.end) - start) / duration * (width - LABEL_WIDTH)
  const boxWidth = Math.abs(selection.anchor - selection.end) / duration * (width - LABEL_WIDTH)
  const top = Math.min(selection.anchorY, selection.endY)
  const bottom = Math.max(selection.anchorY, selection.endY)
  const plotWidth = Math.min(360, width - LABEL_WIDTH - 8)
  const plotHeight = 158
  const roomBelow = viewport.top + viewport.height - bottom
  const roomAbove = top - viewport.top
  const preferredTop = roomBelow >= plotHeight + 6 || roomBelow >= roomAbove
    ? bottom + 6 : top - plotHeight - 6
  const plotTop = Math.max(viewport.top + 2,
    Math.min(viewport.top + viewport.height - plotHeight - 2, preferredTop))
  const plotLeft = Math.max(LABEL_WIDTH + 4, Math.min(width - plotWidth - 4, left + boxWidth / 2 - plotWidth / 2))
  const frequencies = result?.frequencies
  const powers = result?.powers
  const maxFrequency = frequencies?.[frequencies.length - 1] ?? 0
  const peak = powers?.length ? Math.ceil(Math.max(...powers.subarray(1)) / 10) * 10 : 0
  const floor = peak - 60
  const x = (frequency: number) => 54 + frequency / maxFrequency * 290
  const y = (power: number) => 100 - Math.max(0, Math.min(1, (power - floor) / 60)) * 82
  const path = frequencies && powers && maxFrequency > 0
    ? Array.from(frequencies, (frequency, index) => `${index ? 'L' : 'M'}${x(frequency).toFixed(1)},${y(powers[index]).toFixed(1)}`).join(' ')
    : ''

  return <div className="spectrum-layer">
    <div className="spectrum-selection" style={{ left, width: Math.max(2, boxWidth), top, height: Math.max(3, bottom - top) }} />
    <div className="spectrum-plot" style={{ left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight }}>
      <div className="spectrum-heading"><span>Spectrum · {label}</span>
        <button type="button" onClick={onClose} aria-label="Close spectrum">×</button></div>
      {result?.error ? <div className="spectrum-status">{result.error}</div> : !path ?
        <div className="spectrum-status">Computing…</div> :
        <svg viewBox="0 0 380 140" role="img" aria-label={`Frequency spectrum from 0 to ${Math.round(maxFrequency)} Hz`}>
          {[0, 20, 40, 60].map((offset) => <g key={offset}>
            <line x1="54" x2="344" y1={y(peak - offset)} y2={y(peak - offset)} stroke="#e4e8ed" />
            <text x="45" y={y(peak - offset) + 3} textAnchor="end">{peak - offset}</text>
          </g>)}
          {Array.from({ length: Math.floor(maxFrequency / 10) + 1 }, (_, index) => index * 10).map((frequency) =>
            <g key={frequency}><line x1={x(frequency)} x2={x(frequency)} y1="100" y2="103" stroke="#718097" />
              <text x={x(frequency)} y="117" textAnchor="middle">{frequency}</text></g>)}
          <path d={path} fill="none" stroke="#325cda" strokeWidth="1.4" />
          <text x="199" y="134" textAnchor="middle">Hz</text>
          <text transform="translate(16,62) rotate(-90)" textAnchor="middle">dB/Hz</text>
        </svg>}
    </div>
  </div>
}
