import type { PostHog } from 'posthog-node'
import {
  featureFlagFallback,
  isFeatureWallChipVariant,
  type FeatureFlagKey,
  type FeatureFlagResolution
} from '../../shared/feature-flags'
import type { CommonProps } from '../../shared/telemetry-events'
import type { Store } from '../persistence'
import { resolveConsent } from './consent'

type FeatureFlagResolverDeps = {
  getPostHog: () => PostHog | null
  getCommonProps: () => CommonProps | null
  getStore: () => Store | null
  isTransportAvailable: () => boolean
}

export type FeatureFlagResolver = {
  getFeatureFlag: (key: FeatureFlagKey) => Promise<FeatureFlagResolution>
  resetCache: () => void
}

export function createFeatureFlagResolver(deps: FeatureFlagResolverDeps): FeatureFlagResolver {
  const cache = new Map<FeatureFlagKey, Promise<FeatureFlagResolution>>()

  async function resolveFeatureFlag(key: FeatureFlagKey): Promise<FeatureFlagResolution> {
    // Why: `feature_wall_chip` is the PostHog A/B assignment created in project
    // 406068. Only main talks to PostHog; renderer receives a typed resolution.
    if (!deps.isTransportAvailable()) {
      return featureFlagFallback(key, 'transport_unavailable')
    }

    const posthog = deps.getPostHog()
    const commonProps = deps.getCommonProps()
    const store = deps.getStore()
    if (!posthog || !commonProps || !store) {
      return featureFlagFallback(key, 'transport_unavailable')
    }

    const consent = resolveConsent(store.getSettings())
    if (consent.effective !== 'enabled') {
      return featureFlagFallback(key, 'telemetry_disabled')
    }

    try {
      const result = await posthog.getFeatureFlagResult(key, commonProps.install_id, {
        sendFeatureFlagEvents: true
      })
      if (!result) {
        return featureFlagFallback(key, 'flag_missing')
      }
      if (!result.enabled) {
        return { key, variant: 'control', status: 'resolved' }
      }
      if (isFeatureWallChipVariant(result.variant)) {
        return { key, variant: result.variant, status: 'resolved' }
      }
      return featureFlagFallback(key, 'invalid_variant')
    } catch (err) {
      console.warn('[telemetry] feature flag resolution failed:', err)
      return featureFlagFallback(key, 'network_error')
    }
  }

  return {
    getFeatureFlag(key): Promise<FeatureFlagResolution> {
      const store = deps.getStore()
      if (!store || resolveConsent(store.getSettings()).effective !== 'enabled') {
        return Promise.resolve(featureFlagFallback(key, 'telemetry_disabled'))
      }

      let cached = cache.get(key)
      if (!cached) {
        // Why: a PostHog variant is an experiment assignment, not live config.
        // Cache for the process lifetime so UI cannot flicker if the flag changes.
        cached = resolveFeatureFlag(key)
        cache.set(key, cached)
      }
      return cached
    },
    resetCache(): void {
      cache.clear()
    }
  }
}
