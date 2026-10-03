export type SpectralResult = {
  key: string
  tiles: Uint8Array[]
  columnCount: number
  rowCount: number
  bands: Float32Array[]
  error: string | null
}
