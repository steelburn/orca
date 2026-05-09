// Why: paneKey crosses boundaries that outlive the renderer's PaneManager
// (renderer reload, app restart, child-process hooks via ORCA_PANE_KEY) and
// must therefore embed an opaque, stable identifier rather than the
// renderer-local numeric paneId.
//
// The renderer mints v4 UUIDs (8-4-4-4-12 hex with dashes) for stablePaneId.
// IPC ingress uses this regex to drop pre-migration agent-hook events whose
// paneKey suffix is purely numeric (the legacy ${tabId}:${number} format),
// so daemon-survives-reload and lastStatusByPaneKey replay paths can't
// reintroduce stale identities post-upgrade.

const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Returns true when `value` is a lowercase v4 UUID. The renderer mints
 *  lowercase via crypto.randomUUID and the polyfill, so case-equality
 *  matters for paneKey-keyed maps to dedup correctly. */
export function isStablePaneId(value: string): boolean {
  return V4_UUID_RE.test(value)
}

/** Split a paneKey of the form `${tabId}:${stablePaneId}` into its parts.
 *  Returns null when the suffix is not a v4 UUID — pre-migration paneKeys
 *  carry a numeric suffix and should be dropped, not migrated, since the
 *  legacy numeric is no longer routable post-renumber. */
export function parsePaneKey(paneKey: string): { tabId: string; stablePaneId: string } | null {
  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0) {
    return null
  }
  const tabId = paneKey.slice(0, sepIdx)
  const stablePaneId = paneKey.slice(sepIdx + 1)
  if (!isStablePaneId(stablePaneId)) {
    return null
  }
  return { tabId, stablePaneId }
}
