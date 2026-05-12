import { describe, expect, it } from 'vitest'
import { getRuntimeMobileSessionSyncKey } from './sync-runtime-graph'
import type { AppState } from '../store/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

describe('getRuntimeMobileSessionSyncKey', () => {
  it('changes when mobile markdown tab state changes', () => {
    const base = makeState({
      openFiles: [
        {
          id: '/repo/README.md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const cleanKey = getRuntimeMobileSessionSyncKey(base)
    const dirtyKey = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        openFiles: [{ ...base.openFiles[0]!, isDirty: true }],
        editorDrafts: { '/repo/README.md': '# draft' }
      })
    )
    const activatedKey = getRuntimeMobileSessionSyncKey(
      makeState({ ...base, activeFileId: '/repo/README.md' })
    )

    expect(dirtyKey).not.toBe(cleanKey)
    expect(activatedKey).not.toBe(cleanKey)
  })

  it('changes when legacy tab bar order changes', () => {
    const base = makeState({
      tabBarOrderByWorktree: { 'wt-1': ['term-1', '/repo/README.md'] }
    })

    const reordered = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        tabBarOrderByWorktree: { 'wt-1': ['/repo/README.md', 'term-1'] }
      })
    )

    expect(reordered).not.toBe(getRuntimeMobileSessionSyncKey(base))
  })

  it('changes when terminal split-pane layout changes', () => {
    const base = makeState({
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      }
    })

    const split = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        terminalLayoutsByTabId: {
          'term-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' }
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      })
    )

    expect(split).not.toBe(getRuntimeMobileSessionSyncKey(base))
  })
})
