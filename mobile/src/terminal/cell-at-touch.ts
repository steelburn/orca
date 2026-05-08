import { viewportToSurfacePx, type CellDims, type Transform } from './transform-pipeline'

export type CellCoord = { col: number; row: number }

export function cellAtTouch(
  clientX: number,
  clientY: number,
  t: Transform,
  dims: CellDims,
  viewportY: number,
  cols: number,
  visibleRows: number
): CellCoord {
  const { surfaceX, surfaceY } = viewportToSurfacePx(clientX, clientY, t)
  const safeW = dims.cellWidth > 0 ? dims.cellWidth : 1
  const safeH = dims.cellHeight > 0 ? dims.cellHeight : 1
  const rawCol = Math.floor(surfaceX / safeW)
  const rawViewportRow = Math.floor(surfaceY / safeH)
  const col = clamp(rawCol, 0, Math.max(0, cols - 1))
  const viewportRow = clamp(rawViewportRow, 0, Math.max(0, visibleRows - 1))
  return { col, row: viewportRow + viewportY }
}

export function cellToViewportPx(
  col: number,
  absoluteRow: number,
  viewportY: number,
  t: Transform,
  dims: CellDims
): { x: number; y: number } {
  const viewportRow = absoluteRow - viewportY
  const surfaceX = col * dims.cellWidth
  const surfaceY = viewportRow * dims.cellHeight
  return {
    x: surfaceX * t.scale + t.panX,
    y: surfaceY * t.scale + t.panY
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
