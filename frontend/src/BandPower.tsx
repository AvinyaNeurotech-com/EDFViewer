import { useEffect, useRef } from 'react'
import { LABEL_WIDTH } from './Waveform'

export const BAND_HEIGHT = 56
const COLORS = ['#586aca', '#37a89f', '#c18533', '#c45371']
const LABELS = ['δ', 'θ', 'α', 'β']

export function BandPower({ width, bands, error }: {
  width: number; bands: Float32Array[]; error: string | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= LABEL_WIDTH) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(BAND_HEIGHT * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, BAND_HEIGHT)
    context.font = '10px system-ui, sans-serif'
    context.fillStyle = '#3e4859'
    context.fillText('Band', 4, 23)
    context.fillText('Power', 4, 35)
    bands.forEach((band, index) => {
      context.fillStyle = band.some(Number.isFinite) ? COLORS[index] : '#b9c1ce'
      context.fillText(LABELS[index], LABEL_WIDTH - 12, 9 + index * 14)
    })

    let maximum = 0
    for (const band of bands) {
      for (const value of band) if (Number.isFinite(value)) maximum = Math.max(maximum, value)
    }
    if (!maximum) return

    const plotTop = 5
    const plotHeight = BAND_HEIGHT - 8
    context.strokeStyle = '#edf1f6'
    for (let division = 0; division <= 2; division++) {
      const y = plotTop + division * plotHeight / 2 + 0.5
      context.beginPath()
      context.moveTo(LABEL_WIDTH, y)
      context.lineTo(width, y)
      context.stroke()
    }
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index]
      if (!band.some(Number.isFinite)) continue
      const baseline = plotTop + plotHeight
      let lastX = 0
      let filling = false
      context.fillStyle = `${COLORS[index]}18`
      band.forEach((value, column) => {
        if (!Number.isFinite(value)) {
          if (filling) {
            context.lineTo(lastX, baseline)
            context.closePath()
            context.fill()
            filling = false
          }
          return
        }
        const x = LABEL_WIDTH + (band.length === 1 ? 0.5 : column / (band.length - 1)) * (width - LABEL_WIDTH)
        const y = plotTop + plotHeight * (1 - Math.log1p(Math.max(0, value)) / Math.log1p(maximum))
        if (!filling) {
          context.beginPath()
          context.moveTo(x, baseline)
          filling = true
        }
        context.lineTo(x, y)
        lastX = x
      })
      if (filling) {
        context.lineTo(lastX, baseline)
        context.closePath()
        context.fill()
      }
      context.strokeStyle = COLORS[index]
      context.lineWidth = 1.25
      context.beginPath()
      let drawing = false
      band.forEach((value, column) => {
        if (!Number.isFinite(value)) {
          drawing = false
          return
        }
        const x = LABEL_WIDTH + (band.length === 1 ? 0.5 : column / (band.length - 1)) * (width - LABEL_WIDTH)
        const y = plotTop + plotHeight * (1 - Math.log1p(Math.max(0, value)) / Math.log1p(maximum))
        if (drawing) context.lineTo(x, y)
        else context.moveTo(x, y)
        drawing = true
      })
      if (band.length === 1 && Number.isFinite(band[0])) {
        const x = LABEL_WIDTH + (width - LABEL_WIDTH) / 2
        const y = plotTop + plotHeight * (1 - Math.log1p(Math.max(0, band[0])) / Math.log1p(maximum))
        context.moveTo(x + 2, y)
        context.arc(x, y, 2, 0, Math.PI * 2)
      }
      context.stroke()
    }
  }, [width, bands])

  return <div className="band-power-dock" aria-label="Band power">
    <canvas ref={canvasRef} style={{ width, height: BAND_HEIGHT }} role="img"
      aria-label="Band power for current window" />
    {error && <span className="band-power-error" role="alert">{error}</span>}
  </div>
}
