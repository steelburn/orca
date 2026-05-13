import type { PostHog } from 'posthog-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonProps } from '../../shared/telemetry-events'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'
import {
  _enableTransportForTests,
  _resetFeatureFlagCacheForTests,
  _setCommonPropsForTests,
  _setPostHogClientForTests,
  _setShuttingDownForTests,
  _setStoreForTests,
  getFeatureFlag
} from './client'

type MockPostHog = {
  getFeatureFlagResult: ReturnType<typeof vi.fn>
}

function makeFakeSettings(telemetry: GlobalSettings['telemetry']): GlobalSettings {
  return { telemetry } as unknown as GlobalSettings
}

function makeFakeStore(settings: GlobalSettings): Store {
  return {
    getSettings: vi.fn(() => settings)
  } as unknown as Store
}

const CONSENT_ENV_VARS = [
  'DO_NOT_TRACK',
  'ORCA_TELEMETRY_DISABLED',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
] as const

function stashAndClearConsentEnv(): Record<string, string | undefined> {
  const stash: Record<string, string | undefined> = {}
  for (const name of CONSENT_ENV_VARS) {
    stash[name] = process.env[name]
    delete process.env[name]
  }
  return stash
}

function restoreConsentEnv(stash: Record<string, string | undefined>): void {
  for (const name of CONSENT_ENV_VARS) {
    const prior = stash[name]
    if (prior === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = prior
    }
  }
}

const BASE_COMMON: CommonProps = {
  app_version: '1.3.33',
  platform: 'darwin',
  arch: 'arm64',
  os_release: '25.3.0',
  install_id: '00000000-0000-4000-8000-000000000000',
  session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  orca_channel: 'stable'
}

describe('getFeatureFlag()', () => {
  let mock: MockPostHog
  let store: Store
  let envStash: Record<string, string | undefined>

  beforeEach(() => {
    envStash = stashAndClearConsentEnv()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetFeatureFlagCacheForTests()
    mock = { getFeatureFlagResult: vi.fn() }
    store = makeFakeStore(
      makeFakeSettings({
        optedIn: true,
        installId: BASE_COMMON.install_id,
        existedBeforeTelemetryRelease: false
      })
    )
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setCommonPropsForTests(BASE_COMMON)
    _setStoreForTests(store)
    _setShuttingDownForTests(false)
    _enableTransportForTests(true)
  })

  afterEach(() => {
    _enableTransportForTests(false)
    _resetFeatureFlagCacheForTests()
    _setPostHogClientForTests(null)
    _setCommonPropsForTests(null)
    _setStoreForTests(null)
    vi.restoreAllMocks()
    restoreConsentEnv(envStash)
  })

  it('resolves and caches the feature wall chip variant', async () => {
    mock.getFeatureFlagResult.mockResolvedValue({
      key: 'feature_wall_chip',
      enabled: true,
      variant: 'enabled',
      payload: undefined
    })

    await expect(getFeatureFlag('feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'enabled',
      status: 'resolved'
    })
    await expect(getFeatureFlag('feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'enabled',
      status: 'resolved'
    })
    expect(mock.getFeatureFlagResult).toHaveBeenCalledTimes(1)
    expect(mock.getFeatureFlagResult).toHaveBeenCalledWith(
      'feature_wall_chip',
      BASE_COMMON.install_id,
      { sendFeatureFlagEvents: true }
    )
  })

  it('falls back to control for missing flags', async () => {
    mock.getFeatureFlagResult.mockResolvedValue(undefined)

    await expect(getFeatureFlag('feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'control',
      status: 'fallback',
      reason: 'flag_missing'
    })
  })

  it('does not call PostHog when telemetry consent is disabled', async () => {
    ;(store.getSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      makeFakeSettings({
        optedIn: false,
        installId: BASE_COMMON.install_id,
        existedBeforeTelemetryRelease: false
      })
    )

    await expect(getFeatureFlag('feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'control',
      status: 'fallback',
      reason: 'telemetry_disabled'
    })
    expect(mock.getFeatureFlagResult).not.toHaveBeenCalled()
  })

  it('falls back to control on network errors', async () => {
    mock.getFeatureFlagResult.mockRejectedValue(new Error('offline'))

    await expect(getFeatureFlag('feature_wall_chip')).resolves.toEqual({
      key: 'feature_wall_chip',
      variant: 'control',
      status: 'fallback',
      reason: 'network_error'
    })
  })
})
