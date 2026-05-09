import { toast } from 'sonner'
import { useAppStore } from '@/store'

/** Drop the row from agent-status maps and emit a non-intrusive toast for a
 *  raw paneKey. Shared by both the focus-dispatch failure branch (live key
 *  whose stablePaneId no longer maps to any pane) and the malformed/legacy
 *  paneKey branch in sidebar click handlers — those keys can't decompose into
 *  a tabId + UUID stableId, so they need direct paneKey-based dismissal.
 */
export function dismissStaleAgentRowByKey(paneKey: string): void {
  const store = useAppStore.getState()
  const liveExisted = paneKey in store.agentStatusByPaneKey
  const retainedExisted = paneKey in store.retainedAgentsByPaneKey
  store.dropAgentStatus(paneKey)
  store.dismissRetainedAgent(paneKey)
  if (liveExisted || retainedExisted) {
    toast.info("Agent's pane is no longer available.", {
      id: `stale-agent-row-${paneKey}`
    })
  }
}

/** Emit a non-intrusive toast and drop the row from agent-status maps when a
 *  click-to-focus dispatch resolves to no live pane. This is the failure
 *  branch of the focus listener — the alternative (silent return) was the
 *  user-reported bug where clicking an agent row landed focus on the wrong
 *  pane.
 */
export function surfaceStaleAgentRow(tabId: string, stablePaneId: string): void {
  dismissStaleAgentRowByKey(`${tabId}:${stablePaneId}`)
}
