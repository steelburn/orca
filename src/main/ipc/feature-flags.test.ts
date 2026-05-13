import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, ...args: unknown[]) => unknown>()
const { handleMock, getFeatureFlagMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getFeatureFlagMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../telemetry/client', () => ({
  getFeatureFlag: getFeatureFlagMock
}))

import { registerFeatureFlagHandlers } from './feature-flags'

function captureHandlers(): void {
  handlers.clear()
  for (const call of handleMock.mock.calls) {
    const [channel, handler] = call as [
      string,
      typeof handlers extends Map<string, infer V> ? V : never
    ]
    handlers.set(channel, handler)
  }
}

describe('feature flag IPC handlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    getFeatureFlagMock.mockReset()
    registerFeatureFlagHandlers()
    captureHandlers()
  })

  it('registers the get channel', () => {
    expect(handlers.has('feature-flags:get')).toBe(true)
  })

  it('forwards known keys to the feature flag resolver', async () => {
    getFeatureFlagMock.mockResolvedValue({
      key: 'feature_wall_chip',
      variant: 'enabled',
      status: 'resolved'
    })

    const handler = handlers.get('feature-flags:get')!
    await expect(handler({}, 'feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'enabled',
      status: 'resolved'
    })
    expect(getFeatureFlagMock).toHaveBeenCalledWith('feature_wall_chip')
  })

  it('drops unknown keys at the IPC boundary', async () => {
    const handler = handlers.get('feature-flags:get')!
    await expect(handler({}, 'some_other_flag')).resolves.toBeNull()
    await expect(handler({}, 42)).resolves.toBeNull()
    expect(getFeatureFlagMock).not.toHaveBeenCalled()
  })

  it('returns a control fallback if the resolver throws', async () => {
    getFeatureFlagMock.mockRejectedValue(new Error('boom'))

    const handler = handlers.get('feature-flags:get')!
    await expect(handler({}, 'feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'control',
      status: 'fallback',
      reason: 'network_error'
    })
  })
})
