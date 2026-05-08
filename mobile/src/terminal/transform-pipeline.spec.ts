import { describe, it, expect } from 'vitest'
import { surfaceToViewportPx, viewportToSurfacePx, type Transform } from './transform-pipeline'

describe('transform-pipeline', () => {
  it('round-trips identity (scale=1, pan=0)', () => {
    const t: Transform = { scale: 1, panX: 0, panY: 0 }
    const { surfaceX, surfaceY } = viewportToSurfacePx(120, 240, t)
    const { x, y } = surfaceToViewportPx(surfaceX, surfaceY, t)
    expect(x).toBe(120)
    expect(y).toBe(240)
  })

  it('round-trips with scale < 1 (fit-to-phone)', () => {
    const t: Transform = { scale: 0.4, panX: 0, panY: 0 }
    const { surfaceX, surfaceY } = viewportToSurfacePx(80, 160, t)
    expect(surfaceX).toBe(200)
    expect(surfaceY).toBe(400)
    const back = surfaceToViewportPx(surfaceX, surfaceY, t)
    expect(back.x).toBe(80)
    expect(back.y).toBe(160)
  })

  it('round-trips with scale > 1 (pinched in) and non-zero pan', () => {
    const t: Transform = { scale: 2, panX: -50, panY: -100 }
    const { surfaceX, surfaceY } = viewportToSurfacePx(150, 300, t)
    expect(surfaceX).toBe(100)
    expect(surfaceY).toBe(200)
    const back = surfaceToViewportPx(surfaceX, surfaceY, t)
    expect(back.x).toBe(150)
    expect(back.y).toBe(300)
  })

  it('handles zero scale defensively', () => {
    const t: Transform = { scale: 0, panX: 0, panY: 0 }
    const { surfaceX } = viewportToSurfacePx(100, 0, t)
    expect(surfaceX).toBe(100)
  })
})
