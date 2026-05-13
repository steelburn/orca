// PostHog setup was created from this worktree via the Orca CLI browser session
// on 2026-05-13: project 406068, flag 675957, draft experiment 371504,
// monitoring dashboard 1581805. The flag is 50/50 enabled/control.
export const FEATURE_WALL_CHIP_FLAG_KEY = 'feature_wall_chip'

export const FEATURE_FLAG_KEYS = [FEATURE_WALL_CHIP_FLAG_KEY] as const
export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number]

export const FEATURE_WALL_CHIP_VARIANTS = ['enabled', 'control'] as const
export type FeatureWallChipVariant = (typeof FEATURE_WALL_CHIP_VARIANTS)[number]

export type FeatureFlagFallbackReason =
  | 'telemetry_disabled'
  | 'transport_unavailable'
  | 'flag_missing'
  | 'network_error'
  | 'invalid_variant'

export type FeatureFlagResolution =
  | {
      key: FeatureFlagKey
      variant: FeatureWallChipVariant
      status: 'resolved'
    }
  | {
      key: FeatureFlagKey
      variant: 'control'
      status: 'fallback'
      reason: FeatureFlagFallbackReason
    }

export type FeatureWallChipTelemetryVariant =
  | FeatureWallChipVariant
  | 'network_error'
  | 'flag_missing'

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === 'string' && FEATURE_FLAG_KEYS.includes(value as FeatureFlagKey)
}

export function isFeatureWallChipVariant(value: unknown): value is FeatureWallChipVariant {
  return (
    typeof value === 'string' &&
    FEATURE_WALL_CHIP_VARIANTS.includes(value as FeatureWallChipVariant)
  )
}

export function featureFlagFallback(
  key: FeatureFlagKey,
  reason: FeatureFlagFallbackReason
): FeatureFlagResolution {
  // Why: control is the non-intervention arm for the chip experiment, so every
  // telemetry, network, or flag-shape failure must behave like no chip.
  return {
    key,
    variant: 'control',
    status: 'fallback',
    reason
  }
}

export function getFeatureWallChipTelemetryVariant(
  resolution: FeatureFlagResolution
): FeatureWallChipTelemetryVariant {
  if (resolution.status === 'resolved') {
    return resolution.variant
  }
  if (resolution.reason === 'network_error' || resolution.reason === 'flag_missing') {
    return resolution.reason
  }
  return 'control'
}
