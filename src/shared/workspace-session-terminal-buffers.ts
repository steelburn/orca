import type { Repo, WorkspaceSessionState } from './types'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree-id'

export type RepoConnection = Pick<Repo, 'id' | 'connectionId'>

export function pruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[]
): WorkspaceSessionState {
  const connectionIdByRepoId = new Map(repos.map((repo) => [repo.id, repo.connectionId] as const))
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    if (!layout.buffersByLeafId) {
      continue
    }
    const worktreeId = worktreeIdByTabId.get(tabId)
    if (worktreeId !== undefined) {
      if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
        const layoutWithoutBuffers = { ...layout }
        delete layoutWithoutBuffers.buffersByLeafId
        terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
        continue
      }
      const repoId = getRepoIdFromWorktreeId(worktreeId)
      const connectionId = connectionIdByRepoId.get(repoId)
      if (connectionId) {
        continue
      }
      if (!connectionIdByRepoId.has(repoId)) {
        // Why: when the repo catalog does not know this repoId — either because
        // it is not yet hydrated, or because the repo has been removed — we
        // cannot classify the worktree as local vs SSH. Preserve the buffer
        // until a later call with a hydrated catalog can decide. SSH buffers
        // are the only authoritative scrollback source, so the cost of a wrong
        // prune (lost remote scrollback) is higher than the cost of a wrong
        // preserve (extra bytes persisted).
        continue
      }
    }

    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    const layoutWithoutBuffers = { ...layout }
    delete layoutWithoutBuffers.buffersByLeafId
    terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
  }

  if (!terminalLayoutsByTabId) {
    return session
  }

  return {
    ...session,
    // Why: local daemon history/checkpoints are authoritative for restart
    // scrollback. Keeping renderer-captured buffers for local tabs makes every
    // persisted state write scale with old terminal output; SSH keeps them
    // because relay teardown may leave no local history to cold-restore.
    terminalLayoutsByTabId
  }
}
