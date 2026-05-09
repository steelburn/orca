import { describe, expect, it, vi } from 'vitest'
import { shouldForwardAgentStatusForPaneKey } from './agent-status-pane-liveness'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

describe('shouldForwardAgentStatusForPaneKey', () => {
  it('forwards when the paneKey still belongs to a live PTY', () => {
    const clearPaneState = vi.fn()

    expect(
      shouldForwardAgentStatusForPaneKey(PANE_KEY, {
        getPtyIdForPaneKey: () => 'pty-1',
        clearPaneState
      })
    ).toBe(true)
    expect(clearPaneState).not.toHaveBeenCalled()
  })

  it('drops and clears cache when the paneKey no longer has a live PTY', () => {
    const clearPaneState = vi.fn()

    expect(
      shouldForwardAgentStatusForPaneKey(PANE_KEY, {
        getPtyIdForPaneKey: () => undefined,
        clearPaneState
      })
    ).toBe(false)
    expect(clearPaneState).toHaveBeenCalledWith(PANE_KEY)
  })
})
