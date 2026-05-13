import {
  featureFlagFallback,
  type FeatureFlagKey,
  type FeatureFlagResolution
} from '../../../shared/feature-flags'

const cache = new Map<FeatureFlagKey, Promise<FeatureFlagResolution>>()

export function getFeatureFlag(key: FeatureFlagKey): Promise<FeatureFlagResolution> {
  let cached = cache.get(key)
  if (!cached) {
    // Why: assignments are experiment bucketing decisions. Cache in renderer
    // too so repeated eligibility checks cannot jitter the chip within a run.
    cached = resolveFeatureFlag(key)
    cache.set(key, cached)
  }
  return cached
}

async function resolveFeatureFlag(key: FeatureFlagKey): Promise<FeatureFlagResolution> {
  try {
    const result = await window.api?.featureFlags?.get?.(key)
    return result ?? featureFlagFallback(key, 'transport_unavailable')
  } catch {
    return featureFlagFallback(key, 'network_error')
  }
}

export function _resetFeatureFlagCacheForTests(): void {
  cache.clear()
}
