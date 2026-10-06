import type { ImportedAnnotation } from './edfAnnotations'
import { parseHeader } from './edf'
import { uploadTrends } from './uploadTrends'

type UploadMessage =
  | { type: 'ready'; header: ArrayBuffer; name: string; size: number; totalRecords: number;
      discontinuous: boolean; downsampled: boolean }
  | { type: 'chunk'; data: ArrayBuffer; completedRecords: number }
  | { type: 'done'; annotations: ImportedAnnotation[] }
  | { type: 'error'; message: string }

export type UploadProgress = { uploaded: number; total: number; speed: number }

async function requestWorker(worker: Worker, message: unknown): Promise<UploadMessage> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<UploadMessage>) => {
      if (event.data.type === 'error') reject(new Error(event.data.message))
      else resolve(event.data)
    }
    worker.onerror = (event) => reject(new Error(event.message || 'Conversion worker failed'))
    worker.postMessage(message)
  })
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `Upload failed (${response.status})`)
  return body
}

function sendChunk(id: string, offset: number, data: ArrayBuffer,
  onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `/api/uploads/${id}?offset=${offset}`)
    request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onload = () => {
      if (request.status === 204) resolve()
      else {
        let detail = `Upload failed (${request.status})`
        try { detail = JSON.parse(request.responseText).detail ?? detail } catch { /* response is not JSON */ }
        reject(new Error(detail))
      }
    }
    request.onerror = () => reject(new Error('Network connection lost during upload'))
    request.send(data)
  })
}

export async function convertAndUpload(file: File,
  onProgress: (progress: UploadProgress) => void): Promise<{ name: string; size: number }> {
  const worker = new Worker(new URL('./upload.worker.ts', import.meta.url), { type: 'module' })
  let trends: ReturnType<typeof uploadTrends> | null = null
  let uploadId: string | null = null
  try {
    const ready = await requestWorker(worker, { type: 'start', file })
    if (ready.type !== 'ready') throw new Error('Conversion did not provide an EDF header')
    trends = uploadTrends(parseHeader(new Uint8Array(ready.header), ready.size))
    const suffix = `${ready.downsampled ? '-256hz' : ''}${ready.discontinuous ? '-continuous' : ''}`
    const name = suffix ? ready.name.replace(/\.(edf|bdf)$/i, `${suffix}.$1`) : ready.name
    const session = await responseJson(await fetch(`/api/uploads?name=${encodeURIComponent(name)}&size=${ready.size}`, {
      method: 'POST',
    }))
    uploadId = String(session.id)
    let uploaded = 0
    const started = performance.now()
    let lastUpdate = 0
    const report = (current: number) => {
      onProgress({ uploaded: current, total: ready.size,
        speed: current * 1000 / Math.max(1, performance.now() - started) })
    }
    const send = async (data: ArrayBuffer) => {
      await sendChunk(uploadId!, uploaded, data, (loaded) => {
        const now = performance.now()
        if (now - lastUpdate >= 100) {
          report(uploaded + loaded)
          lastUpdate = now
        }
      })
      uploaded += data.byteLength
      report(uploaded)
    }
    onProgress({ uploaded: 0, total: ready.size, speed: 0 })
    await send(ready.header)
    let annotations: ImportedAnnotation[] = []
    let firstRecord = 0
    while (true) {
      const message = await requestWorker(worker, { type: 'next' })
      if (message.type === 'done') {
        annotations = message.annotations
        break
      }
      if (message.type !== 'chunk') throw new Error('Conversion stopped unexpectedly')
      await send(message.data)
      await trends.append(firstRecord, message.data)
      firstRecord = message.completedRecords
    }
    const result = await responseJson(await fetch(`/api/uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotations),
    }))
    uploadId = null
    try { await trends.save(String(result.name)) } catch {}
    return { name: String(result.name), size: Number(result.size) }
  } finally {
    worker.terminate()
    trends?.terminate()
    if (uploadId) void fetch(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {})
  }
}
