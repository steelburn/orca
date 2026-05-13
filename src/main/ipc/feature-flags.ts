// Renderer-facing feature flag IPC. The PostHog SDK stays in main; renderer
// callers only receive typed assignments for flags this app explicitly knows.

import { ipcMain } from 'electron'
import {
  featureFlagFallback,
  isFeatureFlagKey,
  type FeatureFlagResolution
} from '../../shared/feature-flags'
import { getFeatureFlag } from '../telemetry/client'

export function registerFeatureFlagHandlers(): void {
  ipcMain.handle(
    'feature-flags:get',
    async (_event, key: unknown): Promise<FeatureFlagResolution | null> => {
      if (!isFeatureFlagKey(key)) {
        return null
      }
      try {
        return await getFeatureFlag(key)
      } catch {
        return featureFlagFallback(key, 'network_error')
      }
    }
  )
}
