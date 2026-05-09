type AgentStatusPaneLivenessDeps = {
  getPtyIdForPaneKey: (paneKey: string) => string | undefined
  clearPaneState: (paneKey: string) => void
}

export function shouldForwardAgentStatusForPaneKey(
  paneKey: string,
  { getPtyIdForPaneKey, clearPaneState }: AgentStatusPaneLivenessDeps
): boolean {
  if (getPtyIdForPaneKey(paneKey) !== undefined) {
    return true
  }
  // Why: child-process hooks can post after their PTY has already torn down.
  // Clear the just-written hook cache so stale pane rows cannot replay later.
  clearPaneState(paneKey)
  return false
}
