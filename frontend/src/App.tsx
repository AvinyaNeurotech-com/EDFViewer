import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Waveform, LABEL_WIDTH } from './Waveform'
import type { SpectrumResult, SpectrumSelection } from './SpectrumPlot'
import type { DisplaySettings } from './Waveform'
import { AnnotationNameEditor } from './AnnotationNameEditor'
import { BandPower } from './BandPower'
import { EditablePreset } from './EditablePreset'
import { TrendsPanel } from './TrendsPanel'
import { useAeeg } from './useAeeg'
import { useSpectralTrends } from './useSpectralTrends'
import { useAnnotations } from './useAnnotations'
import { convertAndUpload } from './uploadRecording'
import type { UploadProgress } from './uploadRecording'
import { traceMode } from './edf'
import type { EdfHeader, Trace } from './edf'
import { auxiliaryKind, czMontage, laplacianMontage, longitudinalMontage, orderedChannels,
  selectionInputs, transverseMontage } from './montage'
import type { ChannelSelection } from './montage'
import type { FilterSettings } from './signalFilters'
import type { SpectralResult } from './spectral'
import type { ArtifactBox } from './artifactDetection'
import { rowTop, SPECTRAL_HEIGHT } from './waveformRender'
import './App.css'

type Recording = { name: string; size: number }
type WindowData = { requestId: number; start: number; duration: number; columns: number; traces: Trace[] }
type WindowRequest = { type: 'window'; requestId: number; start: number; duration: number;
  columns: number; channels: ChannelSelection[]; filters: FilterSettings }
type Panel = 'annotations' | 'channels' | 'trends' | null
type AnnotationDraft = { anchor: number; end: number; pointerId: number; start: number; duration: number }
type SpectrumDraft = SpectrumSelection & { pointerId: number }
type FilterKey = Exclude<keyof FilterSettings, 'order'>

const highPassOptions = [0.1, 0.3, 0.5, 1, 2, 5]
const lowPassOptions = [15, 30, 35, 40, 70, 100]
const notchOptions = [50, 60]
const windowOptions = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]
const filterPresets: Record<FilterKey, number[]> = {
  highpass: highPassOptions, lowpass: lowPassOptions, notch: notchOptions,
}
const sensitivityOptions = [5, 10, 20, 50, 100, 200, 500]
const spacingOptions = [24, 28, 36, 44, 60, 80, 120]
const defaultDisplay: DisplaySettings = {
  sensitivity: 50, rowHeight: 24, centered: true, inverted: false, grid: true,
}
const defaultFilters: FilterSettings = { highpass: 1, lowpass: 70, notch: 50, order: 4 }

function filtersForRecording(header: EdfHeader): FilterSettings {
  const maxNyquist = Math.max(...header.visibleSignals.map((index) =>
    header.signals[index].samplesPerRecord / header.recordDuration / 2))
  return {
    highpass: maxNyquist > 1 ? 1 : null,
    lowpass: maxNyquist > 70 ? 70 : null,
    notch: maxNyquist > 50 ? 50 : null,
    order: 4,
  }
}

function nextZoomWindow(seconds: number, direction: number): number {
  return direction > 0
    ? windowOptions.find((option) => option > seconds) ?? seconds
    : windowOptions.findLast((option) => option < seconds) ?? seconds
}

function timestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function fileSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` :
    bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

function App() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [selected, setSelected] = useState<Recording | null>(null)
  const [header, setHeader] = useState<EdfHeader | null>(null)
  const [windowData, setWindowData] = useState<WindowData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [start, setStart] = useState(0)
  const [windowSeconds, setWindowSeconds] = useState(10)
  const [width, setWidth] = useState(900)
  const [activeRequestId, setActiveRequestId] = useState(0)
  const [montage, setMontage] = useState<'original' | 'longitudinal' | 'transverse' | 'cz' | 'laplacian'>('original')
  const [hiddenChannels, setHiddenChannels] = useState<number[]>([])
  const [filters, setFilters] = useState<FilterSettings>(defaultFilters)
  const [display, setDisplay] = useState<DisplaySettings>(defaultDisplay)
  const [channelSensitivityOffsets, setChannelSensitivityOffsets] = useState<Record<string, number>>({})
  const [mutedChannelKeys, setMutedChannelKeys] = useState<string[]>([])
  const [panel, setPanel] = useState<Panel>(null)
  const [trendsStarted, setTrendsStarted] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [spectrogramEnabled, setSpectrogramEnabled] = useState(false)
  const [bandPowerEnabled, setBandPowerEnabled] = useState(false)
  const [spectrumEnabled, setSpectrumEnabled] = useState(false)
  const [analysisEnabled, setAnalysisEnabled] = useState(false)
  const [analysisResult, setAnalysisResult] = useState<{ key: string; boxes: ArtifactBox[] } | null>(null)
  const [spectrumDraft, setSpectrumDraft] = useState<SpectrumDraft | null>(null)
  const [spectrumSelection, setSpectrumSelection] = useState<SpectrumSelection | null>(null)
  const [spectrumResult, setSpectrumResult] = useState<{ key: string; value: SpectrumResult } | null>(null)
  const spectrumDraftRef = useRef<SpectrumDraft | null>(null)
  const [spectralResult, setSpectralResult] = useState<SpectralResult | null>(null)
  const { annotations, ready: annotationsReady, error: annotationError, update: setAnnotations,
    retry: retryAnnotations } =
    useAnnotations(selected?.name ?? null)
  const [selectedAnnotation, setSelectedAnnotation] = useState<number | null>(null)
  const [editingAnnotation, setEditingAnnotation] = useState<number | null>(null)
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const draftRef = useRef<AnnotationDraft | null>(null)
  const [pending, setPending] = useState<{ time: number; duration: number } | null>(null)
  const [annotationLabel, setAnnotationLabel] = useState('')
  const [annotationSearch, setAnnotationSearch] = useState('')
  const [playing, setPlaying] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const lastWindowRef = useRef<{ key: string; start: number; duration: number } | null>(null)
  const cancelAnnotationEdit = useCallback(() => {
    draftRef.current = null
    setDraft(null)
    setPending(null)
    setAnnotationLabel('')
  }, [])

  useEffect(() => {
    const closeMenus = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      document.querySelectorAll<HTMLDetailsElement>('.menu-dropdown[open]').forEach((menu) => {
        if (event instanceof KeyboardEvent || !menu.contains(event.target as Node)) menu.open = false
      })
    }
    document.addEventListener('pointerdown', closeMenus)
    document.addEventListener('keydown', closeMenus)
    return () => {
      document.removeEventListener('pointerdown', closeMenus)
      document.removeEventListener('keydown', closeMenus)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/recordings', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`)
        return response.json() as Promise<Recording[]>
      })
      .then((files) => {
        setRecordings(files)
        setFilesLoaded(true)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setFilesLoaded(true)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!selected) return
    const worker = new Worker(new URL('./edf.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<
      | { type: 'opened'; header: EdfHeader }
      | ({ type: 'window' } & WindowData)
      | { type: 'analysis'; requestId: number; firstRecord: number; data: ArrayBuffer }
      | { type: 'error'; message: string }
    >) => {
      const message = event.data
      if (message.type === 'opened') {
        setHeader(message.header)
        setFilters(filtersForRecording(message.header))
      }
      if (message.type === 'window') {
        if (message.requestId !== requestIdRef.current) return
        setWindowData(message)
        setLoading(false)
        setError(null)
      }
      if (message.type === 'error') {
        setError(message.message)
        setLoading(false)
      }
    }
    worker.postMessage({ type: 'open', name: selected.name, size: selected.size })
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [selected])

  useEffect(() => {
    if (!panelRef.current) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(panelRef.current)
    return () => observer.disconnect()
  }, [selected, panel])

  const montages = useMemo(() => header ? {
    longitudinal: longitudinalMontage(header), transverse: transverseMontage(header),
    cz: czMontage(header), laplacian: laplacianMontage(header),
  } : { longitudinal: [], transverse: [], cz: [], laplacian: [] }, [header])
  const channels: ChannelSelection[] = useMemo(() => {
    if (!header) return []
    const selected = header.visibleSignals.filter((index) => !hiddenChannels.includes(index))
    const auxiliary = orderedChannels(header, selected.filter((index) => auxiliaryKind(header.signals[index].label)))
    if (montage !== 'original') return [...montages[montage].filter((pair) =>
      selectionInputs(pair).every(({ index }) => !hiddenChannels.includes(index))), ...auxiliary]
    return orderedChannels(header, selected)
  }, [header, hiddenChannels, montage, montages])
  const channelKeys = useMemo(() => channels.map((channel) => typeof channel === 'number'
    ? `signal:${channel}` : 'neighbors' in channel
      ? `lap:${channel.source}:${channel.neighbors.join(':')}` : `pair:${channel.source}:${channel.reference}`), [channels])
  const shownAnnotations = annotations.filter((annotation) => annotation.label.toLowerCase().includes(annotationSearch.toLowerCase()))
  const maxNyquist = header && channels.length ? Math.max(...channels.map((channel) => {
    const index = typeof channel === 'number' ? channel : channel.source
    return header.signals[index].samplesPerRecord / header.recordDuration / 2
  })) : 0
  const duration = header ? Math.min(windowSeconds, header.duration) : windowSeconds
  const spectrumKey = JSON.stringify([selected?.name, spectrumSelection, filters])
  useEffect(() => {
    if (!spectrumEnabled || !spectrumSelection || !header || !selected ||
      spectrumSelection.windowStart !== start || spectrumSelection.windowDuration !== duration ||
      channelKeys[spectrumSelection.index] !== spectrumSelection.channelKey) return
    const worker = new Worker(new URL('./spectrum.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<SpectrumResult>) => {
      setSpectrumResult({ key: spectrumKey, value: event.data })
    }
    worker.onerror = () => setSpectrumResult({ key: spectrumKey, value: {
      frequencies: new Float32Array(), powers: new Float32Array(), error: 'Unable to compute spectrum',
    } })
    worker.postMessage({ name: selected.name, header, channel: channels[spectrumSelection.index],
      start: Math.min(spectrumSelection.anchor, spectrumSelection.end),
      end: Math.max(spectrumSelection.anchor, spectrumSelection.end), filters })
    return () => worker.terminate()
  }, [spectrumEnabled, spectrumSelection, header, selected, channels, channelKeys, start, duration, filters, spectrumKey])
  useEffect(() => {
    if (!spectrumEnabled) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      spectrumDraftRef.current = null
      setSpectrumDraft(null)
      setSpectrumSelection(null)
    }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [spectrumEnabled])
  useEffect(() => {
    if (!spectrumEnabled || !spectrumSelection) return
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.spectrum-plot')) return
      setSpectrumSelection(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [spectrumEnabled, spectrumSelection])
  const drawingModes = header && width > LABEL_WIDTH ? new Set(channels.map((channel) => {
    const signal = header.signals[typeof channel === 'number' ? channel : channel.source]
    return traceMode(signal.samplesPerRecord / header.recordDuration, duration, width - LABEL_WIDTH)
  })) : null
  const drawingMode = !drawingModes?.size ? null : drawingModes.size > 1 ? 'Mixed' :
    drawingModes.has('min-max') ? 'Min–max' : '4-point'
  const maxStart = Math.max(0, (header?.duration ?? 0) - duration)
  const windowKey = JSON.stringify([selected?.name, width, channels, filters])
  useEffect(() => {
    if (!header || width <= LABEL_WIDTH || !channels.length) return
    if (lastWindowRef.current?.key === windowKey && lastWindowRef.current.start === start &&
      lastWindowRef.current.duration === duration) return
    const requestId = ++requestIdRef.current
    setActiveRequestId(requestId)
    const request: WindowRequest = {
      type: 'window', requestId, start, duration,
      columns: width - LABEL_WIDTH, channels, filters,
    }
    lastWindowRef.current = { key: windowKey, start, duration }
    workerRef.current?.postMessage(request)
  }, [header, start, duration, width, channels, filters, windowKey])

  useEffect(() => {
    if (!playing || !header) return
    const interval = window.setInterval(() => {
      cancelAnnotationEdit()
      setStart((previous) => {
        if (previous >= maxStart) {
          setPlaying(false)
          return previous
        }
        return Math.min(maxStart, previous + 1)
      })
    }, 1000)
    return () => window.clearInterval(interval)
  }, [playing, header, maxStart, cancelAnnotationEdit])

  function chooseRecording(recording: Recording) {
    setHeader(null)
    setWindowData(null)
    lastWindowRef.current = null
    setError(null)
    setStart(0)
    setPlaying(false)
    setMontage('original')
    setPanel(null)
    setTrendsStarted(false)
    setWindowSeconds(10)
    setDisplay(defaultDisplay)
    setHiddenChannels([])
    setSelectedAnnotation(null)
    setEditingAnnotation(null)
    cancelAnnotationEdit()
    setAnnotationSearch('')
    setFilters(defaultFilters)
    setChannelSensitivityOffsets({})
    setMutedChannelKeys([])
    setSpectrumSelection(null)
    setSpectrumDraft(null)
    spectrumDraftRef.current = null
    setLoading(true)
    setSelected(recording)
  }

  function showFiles() {
    setSpectrumSelection(null)
    setSelected(null)
    setHeader(null)
    setWindowData(null)
    setPlaying(false)
    setPanel(null)
    setTrendsStarted(false)
    setError(null)
  }

  async function uploadRecording(file: File) {
    if (!/\.(edf|bdf)$/i.test(file.name)) {
      setError('Choose an EDF or BDF recording')
      return
    }
    setUploading(true)
    setUploadProgress(null)
    setError(null)
    try {
      const recording = await convertAndUpload(file, setUploadProgress)
      setRecordings((previous) => [...previous, recording].sort((left, right) => left.name.localeCompare(right.name)))
      chooseRecording(recording)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  const seek = useCallback((position: number) => {
    if (!header) return
    const next = Math.max(0, Math.min(position, maxStart))
    if (next === start) return
    cancelAnnotationEdit()
    setSpectrumSelection(null)
    setStart(next)
    setLoading(true)
    setError(null)
  }, [header, maxStart, start, cancelAnnotationEdit])

  function filterControl(key: FilterKey, label: string) {
    const options = filterPresets[key].filter((frequency) => frequency < maxNyquist &&
      (key === 'highpass' ? filters.lowpass === null || frequency < filters.lowpass :
        key === 'lowpass' ? filters.highpass === null || frequency > filters.highpass : true))
    return <EditablePreset label={label} value={filters[key]} presets={options} allowOff unit="Hz"
      disabled={!header || !channels.length}
      onCommit={(value) => setFilters((previous) => ({ ...previous, [key]: value }))}
      validate={(value) => {
        if (value < 0.05 || value >= maxNyquist) return `Enter 0.05 Hz to below ${maxNyquist} Hz.`
        if (key === 'highpass' && filters.lowpass !== null && value >= filters.lowpass)
          return `LFF must be below HFF (${filters.lowpass} Hz).`
        if (key === 'lowpass' && filters.highpass !== null && value <= filters.highpass)
          return `HFF must be above LFF (${filters.highpass} Hz).`
        return null
      }} />
  }

  function changeWindow(seconds: number) {
    cancelAnnotationEdit()
    setSpectrumSelection(null)
    setWindowSeconds(seconds)
    setStart((previous) => Math.min(previous, Math.max(0, (header?.duration ?? 0) - seconds)))
    setLoading(true)
  }

  function zoom(direction: number) {
    const seconds = nextZoomWindow(windowSeconds, direction)
    if (seconds !== windowSeconds) changeWindow(seconds)
  }

  useEffect(() => {
    if (!header) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const next = Math.max(0, Math.min(maxStart,
          start + (event.key === 'ArrowRight' ? duration / 2 : -duration / 2)))
        seek(next)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!panelRef.current) return
        event.preventDefault()
        panelRef.current.scrollBy({ top: (event.key === 'ArrowDown' ? 1 : -1) *
          (display.rowHeight + (spectrogramEnabled ? 50 : 0)) })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [header, start, duration, maxStart, display.rowHeight, spectrogramEnabled, seek])

  function addAnnotation() {
    if (!annotationsReady || !pending || !annotationLabel.trim()) return
    setAnnotations((previous) => [...previous, {
      id: Date.now() + Math.random(), ...pending, label: annotationLabel.trim(), visible: true,
    }].sort((left, right) => left.time - right.time))
    setPending(null)
    setAnnotationLabel('')
  }

  function renameAnnotation(id: number, label: string) {
    setAnnotations((previous) => previous.map((annotation) => annotation.id === id
      ? { ...annotation, label } : annotation))
    setEditingAnnotation(null)
  }

  function canStartSelection(event: ReactPointerEvent<HTMLDivElement>): boolean {
    const target = event.target
    const content = event.currentTarget.querySelector('.waveform-content')
    return event.button === 0 && event.isPrimary && !!visibleWindow && !!windowData &&
      !!content && event.clientX >= content.getBoundingClientRect().left + LABEL_WIDTH &&
      target instanceof Element &&
      (target === event.currentTarget || !!target.closest('.waveform-content')) &&
      !target.closest('button, input, textarea, select, .annotation-tag, .spectrum-plot')
  }

  function selectionPoint(event: ReactPointerEvent<HTMLDivElement>): { time: number; y: number } | null {
    const content = event.currentTarget.querySelector('.waveform-content')
    if (!content || !header) return null
    const panelBounds = event.currentTarget.getBoundingClientRect()
    if (event.clientY < panelBounds.top || event.clientY > panelBounds.bottom) return null
    const bounds = content.getBoundingClientRect()
    if (bounds.width <= LABEL_WIDTH) return null
    const fraction = (event.clientX - bounds.left - LABEL_WIDTH) / (bounds.width - LABEL_WIDTH)
    return {
      time: Math.max(0, Math.min(header.duration,
        start + Math.max(0, Math.min(1, fraction)) * duration)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    }
  }

  function finishAnnotation(current: AnnotationDraft, time: number) {
    const begin = Math.min(current.anchor, time)
    const end = Math.max(current.anchor, time)
    setPending({ time: begin, duration: end - begin < duration * 0.003 ? 0 : end - begin })
    setAnnotationLabel('')
    setDraft(null)
    draftRef.current = null
  }

  useEffect(() => {
    if (!draft && !pending) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      cancelAnnotationEdit()
    }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [draft, pending, cancelAnnotationEdit])

  const visibleWindow = windowData?.requestId === activeRequestId && windowData.start === start &&
    windowData.duration === duration && windowData.columns === width - LABEL_WIDTH ? windowData : null
  const foregroundReady = Boolean(visibleWindow && !loading)
  const analysisKey = JSON.stringify([selected?.name, visibleWindow?.requestId, channelKeys, mutedChannelKeys])
  useEffect(() => {
    if (!analysisEnabled || !foregroundReady || !selected || !header || !visibleWindow) return
    const worker = new Worker(new URL('./artifact.worker.ts', import.meta.url), { type: 'module' })
    const source = workerRef.current
    if (!source) { worker.terminate(); return }
    let cancelled = false
    const requestId = visibleWindow.requestId
    const onData = (event: MessageEvent<{ type: string; requestId: number; firstRecord: number; data: ArrayBuffer }>) => {
      const message = event.data
      if (cancelled || message.type !== 'analysis' || message.requestId !== requestId) return
      worker.postMessage({ header, start: visibleWindow.start, duration: visibleWindow.duration,
        firstRecord: message.firstRecord, data: message.data, channels,
        muted: channelKeys.map((key) => mutedChannelKeys.includes(key)) }, [message.data])
    }
    source.addEventListener('message', onData)
    worker.onmessage = (event: MessageEvent<{ type: 'result'; boxes: ArtifactBox[] } | { type: 'error'; message: string }>) => {
      if (!cancelled && event.data.type === 'result') {
        setAnalysisResult({ key: analysisKey, boxes: event.data.boxes })
      }
    }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => source.postMessage({ type: 'analysis',
        start: visibleWindow.start, duration: visibleWindow.duration, requestId }))
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      source.removeEventListener('message', onData)
      worker.terminate()
    }
  }, [analysisEnabled, foregroundReady, selected, header, visibleWindow, channels, channelKeys, mutedChannelKeys, analysisKey])
  const currentAnalysis = analysisEnabled && visibleWindow && analysisResult?.key === analysisKey
    ? analysisResult.boxes : []
  const { pairs: trendPairs, store: trendStore } = useAeeg(selected?.name ?? null, header, trendsStarted, foregroundReady)
  const { pairs: spectralPairs, store: spectralTrendStore } = useSpectralTrends(selected?.name ?? null, header, trendsStarted, foregroundReady)
  useEffect(() => {
    if (!foregroundReady || trendsStarted) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setTrendsStarted(true))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [foregroundReady, trendsStarted])
  const spectralKey = JSON.stringify([selected?.name, windowData?.requestId, channelKeys,
    spectrogramEnabled, bandPowerEnabled])
  const currentSpectral = spectralResult?.key === spectralKey ? spectralResult : null

  useEffect(() => {
    if (!selected || !header || !windowData || !channels.length ||
      (!spectrogramEnabled && !bandPowerEnabled)) return
    const worker = new Worker(new URL('./spectral.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<
      | { type: 'spectral'; tiles: Uint8Array[]; columnCount: number; rowCount: number;
          bands: Float32Array[] }
      | { type: 'error'; message: string }
    >) => {
      if (event.data.type === 'spectral') {
        setSpectralResult({ ...event.data, key: spectralKey, error: null })
      } else {
        setSpectralResult({ key: spectralKey, tiles: [], columnCount: 0, rowCount: 0,
          bands: [], error: event.data.message })
      }
    }
    worker.postMessage({ name: selected.name, header, start: windowData.start,
      duration: windowData.duration, columns: windowData.columns, channels,
      spectrogram: spectrogramEnabled, bandPower: bandPowerEnabled })
    return () => worker.terminate()
  }, [selected, header, windowData, channels, spectrogramEnabled, bandPowerEnabled, spectralKey])

  return <div className={`avinya-viewer${controlsVisible ? '' : ' controls-collapsed'}`}>
    <input ref={fileInputRef} type="file" accept=".edf,.bdf" hidden aria-label="Upload EDF or BDF recording"
      onChange={(event) => {
        const file = event.target.files?.[0]
        if (file) void uploadRecording(file)
        event.target.value = ''
      }} />
    <header className="command-bar">
      <div className="brand" aria-label="NeuroAstra"><span className="brand-icon">✦</span></div>
      <div className="menu-items">
        {uploading ? <div className="upload-progress" role="progressbar" aria-label="Recording upload"
          aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={uploadProgress ? Math.min(99, Math.floor(uploadProgress.uploaded / uploadProgress.total * 100)) : 0}>
          <span className="upload-progress-fill" style={{ width: `${uploadProgress ? uploadProgress.uploaded / uploadProgress.total * 100 : 0}%` }} />
          <span className="upload-progress-text">{uploadProgress
            ? `${Math.min(99, Math.floor(uploadProgress.uploaded / uploadProgress.total * 100))}% · ${uploadProgress.speed ? `${(uploadProgress.speed / 1024 ** 2).toFixed(1)} MB/s` : 'processing'}`
            : 'Preparing…'}</span>
        </div> : <button className="menu-button" type="button"
          onClick={() => fileInputRef.current?.click()}>Upload EDF/BDF</button>}
        <button className="menu-button" type="button" aria-pressed={!selected} onClick={showFiles}>Files</button>
        <button className="menu-button" type="button" disabled={!selected} aria-pressed={spectrogramEnabled}
          onClick={() => setSpectrogramEnabled((current) => !current)}>Spectrogram</button>
        <button className="menu-button" type="button" disabled={!selected} aria-pressed={bandPowerEnabled}
          onClick={() => setBandPowerEnabled((current) => !current)}>Band power</button>
        <button className="menu-button" type="button" disabled={!selected} aria-pressed={spectrumEnabled}
          onClick={() => {
            setSpectrumEnabled((current) => !current)
            setSpectrumSelection(null)
            setSpectrumDraft(null)
            spectrumDraftRef.current = null
            cancelAnnotationEdit()
            setSelectedAnnotation(null)
            setEditingAnnotation(null)
            setPanel((current) => current === 'annotations' ? null : current)
          }}>Spectrum</button>
        <button className="menu-button" type="button" disabled={!selected} aria-pressed={analysisEnabled}
          onClick={() => setAnalysisEnabled((current) => !current)}>Analyze</button>
        {selected ? <details className="menu-dropdown"><summary>Display</summary><div className="menu-popup">
          <label><input type="checkbox" checked={display.centered} onChange={(event) => setDisplay((current) =>
            ({ ...current, centered: event.target.checked }))} /> Center each trace</label>
          <label><input type="checkbox" checked={display.inverted} onChange={(event) => setDisplay((current) =>
            ({ ...current, inverted: event.target.checked }))} /> Invert polarity</label>
          <label><input type="checkbox" checked={display.grid} onChange={(event) => setDisplay((current) =>
            ({ ...current, grid: event.target.checked }))} /> Time & amplitude grid</label>
        </div></details> : <button className="menu-button" type="button" disabled>Display</button>}
        <button className="menu-button" type="button" disabled={!selected}
          onClick={() => setPanel((current) => current === 'channels' ? null : 'channels')}>Channels</button>
        <button className="menu-button" type="button" disabled={!selected || spectrumEnabled}
          onClick={() => setPanel((current) => current === 'annotations' ? null : 'annotations')}>Annotations</button>
        <button className="menu-button" type="button" disabled={!selected} onClick={() =>
          setPanel((current) => current === 'trends' ? null : 'trends')}>Trends</button>
      </div>
      <button className="menu-button controls-toggle" type="button" disabled={!selected} aria-controls="viewer-settings viewer-tools"
        aria-expanded={controlsVisible} onClick={() => setControlsVisible((current) => !current)}>
        {controlsVisible ? 'Hide controls' : 'Show controls'}
      </button>
    </header>

    {selected && <div className="settings-bar" id="viewer-settings">
      {filterControl('highpass', 'LFF')}
      {filterControl('lowpass', 'HFF')}
      {filterControl('notch', 'Notch')}
      <label className="control-group">Slope <select aria-label="Filter order" value={filters.order}
        disabled={!channels.length}
        onChange={(event) => setFilters((previous) => ({ ...previous, order: Number(event.target.value) as 2 | 4 }))}>
        <option value={2}>Standard (2nd)</option><option value={4}>Steep (4th)</option>
      </select></label>
      <EditablePreset label="Sensitivity" value={display.sensitivity} presets={sensitivityOptions} unit="µV/div"
        onCommit={(value) => setDisplay((current) => ({ ...current, sensitivity: value! }))}
        validate={(value) => value > 0 && value <= 10000 ? null : 'Enter a sensitivity above 0 and up to 10000 µV/div.'} />
      <EditablePreset label="Channel spacing" value={display.rowHeight} presets={spacingOptions} unit="px"
        onCommit={(value) => setDisplay((current) => ({ ...current, rowHeight: value! }))}
        validate={(value) => Number.isInteger(value) && value >= 24 && value <= 400
          ? null : 'Enter a whole number from 24 to 400 px.'} />
      <EditablePreset label="Timebase" value={windowSeconds} presets={windowOptions} unit="s/page"
        onCommit={(value) => changeWindow(value!)}
        validate={(value) => value >= 0.01 && value <= 3600 ? null : 'Enter 0.01 to 3600 seconds per page.'} />
      <label className="control-group">Montage <select value={montage} onChange={(event) => {
        setMontage(event.target.value as typeof montage)
        setSpectrumSelection(null)
        setSpectrumDraft(null)
        spectrumDraftRef.current = null
        event.currentTarget.blur()
      }}>
        <option value="original">Original</option>
        <option value="longitudinal" disabled={!montages.longitudinal.length}>Longitudinal bipolar</option>
        <option value="transverse" disabled={!montages.transverse.length}>Transverse bipolar</option>
        <option value="cz" disabled={!montages.cz.length}>Cz reference</option>
        <option value="laplacian" disabled={!montages.laplacian.length}>Local Laplacian</option>
      </select></label>
    </div>}

    {error && <p className="error-banner" role="alert">{error}</p>}
    {!selected && <main className="files-view" aria-label="Files">
      {recordings.length ? <div className="file-list">{recordings.map((recording) =>
        <button type="button" className="file-row" key={recording.name} onClick={() => chooseRecording(recording)}>
          <span>{recording.name}</span><span className="file-size">{fileSize(recording.size)}</span>
        </button>)}</div> : <p>{filesLoaded ? 'No recordings yet. Upload an EDF/BDF file to begin.' : 'Loading files…'}</p>}
    </main>}
    {selected && <div className="work-area">
      <section className="signal-area" aria-label="EEG signals">
        <div className="tools-bar" id="viewer-tools">
          <div className="tool-cluster">
            <button type="button" aria-label="First page" disabled={!header || start === 0} onClick={() => seek(0)}>⏮</button>
            <button type="button" aria-label="Previous page" disabled={!header || start === 0} onClick={() => seek(start - duration)}>◀◀</button>
            <button type="button" aria-label="Step backward" disabled={!header || start === 0} onClick={() => seek(start - duration / 2)}>◀</button>
            <button type="button" aria-label={playing ? 'Pause' : 'Play'} disabled={!header}
              onClick={() => setPlaying((current) => !current)}>{playing ? 'Ⅱ' : '▶'}</button>
            <button type="button" aria-label="Step forward" disabled={!header || start >= maxStart} onClick={() => seek(start + duration / 2)}>▶</button>
            <button type="button" aria-label="Next page" disabled={!header || start >= maxStart} onClick={() => seek(start + duration)}>▶▶</button>
            <button type="button" aria-label="Last page" disabled={!header || start >= maxStart} onClick={() => seek(maxStart)}>⏭</button>
          </div>
          <span className="tool-separator" />
          <div className="tool-cluster">
            <button type="button" aria-label="Zoom out" onClick={() => zoom(1)} disabled={!header || nextZoomWindow(windowSeconds, 1) === windowSeconds}>⊖</button>
            <button type="button" aria-label="Zoom in" onClick={() => zoom(-1)} disabled={!header || nextZoomWindow(windowSeconds, -1) === windowSeconds}>⊕</button>
            <button type="button" aria-label="Reset display" onClick={() => {
              setDisplay(defaultDisplay)
              setChannelSensitivityOffsets({})
              setFilters(header ? filtersForRecording(header) : defaultFilters)
              setMontage('original')
              setHiddenChannels([])
              changeWindow(10)
            }}>↺</button>
          </div>
          <div className="tools-meta">
            <span className="tools-filename">{selected.name}</span>
            <span>{channels.length} channels</span>
            {drawingMode && <span>Draw: {drawingMode}</span>}
          </div>
        </div>
        <div className={`waveform-panel${spectrumEnabled ? ' spectrum-mode' : ''}`} ref={panelRef}
          onPointerDown={(event) => {
            if (!canStartSelection(event)) return
            const point = selectionPoint(event)
            if (!point) return
            if (spectrumEnabled) {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              spectrumDraftRef.current = { index: -1, channelKey: '', anchor: point.time, end: point.time,
                anchorY: point.y, endY: point.y, windowStart: start, windowDuration: duration,
                pointerId: event.pointerId }
              setSpectrumDraft(spectrumDraftRef.current)
              return
            }
            if (event.pointerType === 'touch' || pending || !annotationsReady) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            draftRef.current = { anchor: point.time, end: point.time, pointerId: event.pointerId, start, duration }
            setDraft(draftRef.current)
          }}
          onPointerMove={(event) => {
            const spectrum = spectrumDraftRef.current
            if (spectrum && spectrum.pointerId === event.pointerId &&
              spectrum.windowStart === start && spectrum.windowDuration === duration) {
              const point = selectionPoint(event)
              if (point) {
                spectrumDraftRef.current = { ...spectrum, end: point.time, endY: point.y }
                setSpectrumDraft(spectrumDraftRef.current)
              }
              return
            }
            if (!draftRef.current || draftRef.current.pointerId !== event.pointerId ||
              draftRef.current.start !== start || draftRef.current.duration !== duration) return
            const point = selectionPoint(event)
            if (!point) return
            draftRef.current = { ...draftRef.current, end: point.time }
            setDraft(draftRef.current)
          }}
          onPointerUp={(event) => {
            const spectrum = spectrumDraftRef.current
            if (spectrum?.pointerId === event.pointerId) {
              const point = selectionPoint(event)
              if (point && spectrum.windowStart === start && spectrum.windowDuration === duration &&
                Math.abs(point.time - spectrum.anchor) / duration * (width - LABEL_WIDTH) > 3) {
                const firstAuxiliary = windowData!.traces.findIndex((trace) => auxiliaryKind(trace.label) !== null)
                const middle = (spectrum.anchorY + point.y) / 2
                const nearest = windowData!.traces.reduce((best, _, index) => {
                  if (mutedChannelKeys.includes(channelKeys[index])) return best
                  const center = rowTop(index, display.rowHeight, firstAuxiliary, firstAuxiliary > 0 ? 16 : 0,
                    spectrogramEnabled ? SPECTRAL_HEIGHT : 0) + display.rowHeight / 2
                  const distance = Math.abs(center - middle)
                  return distance < best.distance ? { index, distance } : best
                }, { index: -1, distance: Infinity })
                if (nearest.index >= 0) setSpectrumSelection({ index: nearest.index,
                  channelKey: channelKeys[nearest.index], anchor: spectrum.anchor, end: point.time,
                  anchorY: spectrum.anchorY, endY: point.y, windowStart: start, windowDuration: duration })
              }
              spectrumDraftRef.current = null
              setSpectrumDraft(null)
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              return
            }
            const current = draftRef.current
            if (!current || current.pointerId !== event.pointerId) return
            const point = selectionPoint(event)
            if (point && current.start === start && current.duration === duration) {
              finishAnnotation(current, point.time)
            } else {
              draftRef.current = null
              setDraft(null)
            }
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => {
            spectrumDraftRef.current = null
            setSpectrumDraft(null)
            draftRef.current = null
            setDraft(null)
          }}
          onLostPointerCapture={(event) => {
            if (spectrumDraftRef.current?.pointerId === event.pointerId) {
              spectrumDraftRef.current = null
              setSpectrumDraft(null)
            }
            if (draftRef.current?.pointerId !== event.pointerId) return
            draftRef.current = null
            setDraft(null)
          }}>
          {!channels.length ? <div className="loading">No channels selected. Open Channels to show them.</div> :
            windowData ? <Waveform {...windowData}
            width={windowData.columns + LABEL_WIDTH} display={display}
            header={header} channels={channels} spectrogramEnabled={spectrogramEnabled}
            spectralResult={currentSpectral}
            artifactBoxes={currentAnalysis}
            spectrumSelection={spectrumEnabled && spectrumSelection?.windowStart === start &&
              spectrumSelection.windowDuration === duration ? spectrumSelection : null}
            spectrumDraft={spectrumEnabled && spectrumDraft?.windowStart === start &&
              spectrumDraft.windowDuration === duration ? spectrumDraft : null}
            spectrumResult={spectrumResult?.key === spectrumKey ? spectrumResult.value : null}
            spectrumPanelRef={panelRef}
            spectrumMode={spectrumEnabled}
            onCloseSpectrum={() => setSpectrumSelection(null)}
            channelKeys={channelKeys} channelSensitivityOffsets={channelSensitivityOffsets}
            mutedChannelKeys={mutedChannelKeys}
            onToggleChannel={(channelKey) => setMutedChannelKeys((current) => current.includes(channelKey)
              ? current.filter((key) => key !== channelKey) : [...current, channelKey])}
            onChannelSensitivityChange={(channelKey, step) => setChannelSensitivityOffsets((previous) => ({
              ...previous,
              [channelKey]: Number((Math.max(0.05, Math.min(10000,
                display.sensitivity + (previous[channelKey] ?? 0) + step)) - display.sensitivity).toFixed(2)),
            }))}
            annotations={annotations.filter((annotation) => annotation.visible)} draft={draft} pending={pending}
            annotationLabel={annotationLabel} onLabelChange={setAnnotationLabel}
            onSaveAnnotation={addAnnotation} onCancelAnnotation={cancelAnnotationEdit}
            selectedAnnotation={selectedAnnotation} onSelectAnnotation={setSelectedAnnotation}
            editingAnnotation={editingAnnotation} onEditAnnotation={setEditingAnnotation}
            onRenameAnnotation={renameAnnotation} onCancelRename={() => setEditingAnnotation(null)}
            onRemoveAnnotation={(id) => {
              setAnnotations((previous) => previous.filter((item) => item.id !== id))
              setSelectedAnnotation(null)
              setEditingAnnotation(null)
            }} /> :
            <div className="loading">{loading && !error ? 'Loading signals…' : error ? 'Unable to display signals' : 'Opening recording…'}</div>}
          {channels.length > 0 && windowData && !visibleWindow &&
            <div className="updating" role="status">Updating view…</div>}
        </div>
        {bandPowerEnabled && <BandPower width={windowData ? windowData.columns + LABEL_WIDTH : width}
          bands={currentSpectral?.bands ?? []}
          error={currentSpectral?.error ?? null} />}
        <div className="timeline-footer">
          <span className="timeline-time">Start · {timestamp(start)}</span>
          <div className="timeline-track">
            {annotations.map((annotation) => <span key={annotation.id}
              className={`timeline-marker${annotation.duration > 0 ? ' timeline-segment' : ''}`}
              style={{ left: `${header ? Math.min(100, annotation.time / header.duration * 100) : 0}%`,
                width: annotation.duration && header ? `${Math.min(100, annotation.duration / header.duration * 100)}%` : undefined }} />)}
            <input aria-label="Recording position" type="range" min={0}
              max={maxStart} step="any" value={start} disabled={!header} tabIndex={-1}
              onFocus={(event) => event.currentTarget.blur()}
              onChange={(event) => seek(Number(event.target.value))} />
          </div>
          <span className="timeline-time">{timestamp(start + duration)} · {timestamp(header?.duration ?? 0)}</span>
        </div>
      </section>

      {panel && <aside className={`detail-panel${panel === 'trends' ? ' trends-sidebar' : panel === 'channels' ? ' channel-sidebar' : ''}`}
        aria-label={panel === 'annotations' ? 'Annotation List' : panel === 'channels' ? 'Channel Selector' : 'Trends'}>
        <header className="detail-header"><strong>{panel === 'annotations' ? 'Annotation List' : panel === 'channels' ? 'Channel Selector' : 'Trends'}</strong>
          <button type="button" onClick={() => setPanel(null)} aria-label="Close panel">×</button></header>
        {panel === 'annotations' ? <>
          {annotationError && <div className="annotation-error" role="alert">{annotationError}
            {!annotationsReady && <button type="button" onClick={retryAnnotations}>Retry</button>}
          </div>}
          <div className="annotation-visibility">
            <button type="button" disabled={!annotations.some((annotation) => !annotation.visible)}
              onClick={() => setAnnotations((previous) => previous.map((annotation) => ({ ...annotation, visible: true })))}>Show all</button>
            <button type="button" disabled={!annotations.some((annotation) => annotation.visible)}
              onClick={() => setAnnotations((previous) => previous.map((annotation) => ({ ...annotation, visible: false })))}>Show none</button>
          </div>
          <input className="annotation-search" aria-label="Search annotations" placeholder="Search annotations..." value={annotationSearch}
            onChange={(event) => setAnnotationSearch(event.target.value)} />
          <div className="annotation-table-header"><span>TIME</span><span>TITLE</span><span>VIEW</span><span>ACTION</span></div>
          <div className="annotation-list">{shownAnnotations.length ? shownAnnotations.map((annotation) =>
            <div className="annotation-row" key={annotation.id}><button type="button" onClick={() => { seek(annotation.time); setSelectedAnnotation(annotation.id) }}>{timestamp(annotation.time)}</button>
              {editingAnnotation === annotation.id
                ? <AnnotationNameEditor label={annotation.label} onSave={(label) => renameAnnotation(annotation.id, label)}
                  onCancel={() => setEditingAnnotation(null)} />
                : <button type="button" className="annotation-name"
                    aria-label={`Edit ${annotation.label}`} onClick={() => setEditingAnnotation(annotation.id)}>
                    {annotation.label}{annotation.duration > 0 ? ` · ${annotation.duration.toFixed(2)}s` : ''}
                  </button>}
              <button type="button" aria-label={`${annotation.visible ? 'Hide' : 'Show'} ${annotation.label} on viewport`}
                aria-pressed={annotation.visible} onClick={() => setAnnotations((previous) => previous.map((item) =>
                  item.id === annotation.id ? { ...item, visible: !item.visible } : item))}>
                {annotation.visible ? 'Hide' : 'Show'}</button>
              <button type="button" aria-label={`Remove ${annotation.label}`}
                onClick={() => { setAnnotations((previous) => previous.filter((item) => item.id !== annotation.id)); setSelectedAnnotation(null); setEditingAnnotation(null) }}>×</button></div>) :
            <p>{annotations.length ? 'No matching annotations.' : 'No annotations in this session.'}</p>}</div>
        </> : panel === 'trends' ? header && <TrendsPanel pairs={trendPairs} store={trendStore} spectralStore={spectralTrendStore}
          spectralPairs={spectralPairs}
          total={header.duration} start={start} duration={duration} onSeek={seek} /> : <div className="channel-picker">
          <div className="channel-picker-actions"><button type="button" onClick={() => setHiddenChannels([])}>Show all</button>
            <button type="button" onClick={() => setHiddenChannels(header?.visibleSignals ?? [])}>Hide all</button></div>
          {header?.visibleSignals.map((index) => <label key={index}><input type="checkbox" checked={!hiddenChannels.includes(index)}
            onChange={(event) => setHiddenChannels((current) => event.target.checked
              ? current.filter((value) => value !== index) : [...current, index])} />{header.signals[index].label}</label>)}
        </div>}
      </aside>}
    </div>}
  </div>
}

export default App
