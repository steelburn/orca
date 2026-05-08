export type Transform = {
  scale: number
  panX: number
  panY: number
}

export type CellDims = {
  cellWidth: number
  cellHeight: number
}

export function viewportToSurfacePx(
  clientX: number,
  clientY: number,
  t: Transform
): { surfaceX: number; surfaceY: number } {
  const safeScale = t.scale > 0 ? t.scale : 1
  return {
    surfaceX: (clientX - t.panX) / safeScale,
    surfaceY: (clientY - t.panY) / safeScale
  }
}

export function surfaceToViewportPx(
  surfaceX: number,
  surfaceY: number,
  t: Transform
): { x: number; y: number } {
  return {
    x: surfaceX * t.scale + t.panX,
    y: surfaceY * t.scale + t.panY
  }
}
