/* eslint-disable max-lines -- Why: this module deliberately co-locates the
   renderer-local view-model types, the merge function, and its supporting
   string-manipulation helpers because they exist solely to feed the popover
   in ResourceUsageStatusSegment.tsx. Splitting would scatter logic that has
   exactly one consumer. See docs/resource-usage-merge-spec.md. */
/**
 * Resource Usage popover merge helper.
 *
 * Produces a single grouped list (repo → worktree → session) by unifying:
 *
 *   - `MemorySnapshot.worktrees` — local PTYs only, with numeric CPU/Mem
 *     per worktree and per session (the local memory collector doesn't see
 *     SSH process trees, by design — see src/main/memory/collector.ts and
 *     the registerPty branch at src/main/ipc/pty.ts:832).
 *   - `pty.listSessions()` — every PTY the daemon tracks, local or SSH.
 *
 * The merge is renderer-only and pure. It does NOT widen the shared
 * `WorktreeMemory` shape; instead it emits a renderer-local view-model
 * with `Metric = number | null`, where `null` means "no local sample"
 * (e.g. an SSH session). The popover renders `null` cells as `—`.
 *
 * See docs/resource-usage-merge-spec.md for the full design.
 */

import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  MemorySnapshot,
  SessionMemory,
  TerminalTab,
  WorktreeMemory
} from '../../../../shared/types'

// ─── View-model types (renderer-local) ──────────────────────────────

/** `null` === "no local sample" (e.g. SSH PTY); UI renders as em-dash. */
export type Metric = number | null

export type DaemonSession = {
  id: string
  cwd: string
  title: string
}

export type UnifiedSessionRow = {
  sessionId: string
  paneKey: string | null
  pid: number
  label: string
  bound: boolean
  tabId: string | null
  cpu: Metric
  memory: Metric
  hasLocalSamples: boolean
}

export type UnifiedWorktreeRow = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  history: number[]
  hasLocalSamples: boolean
  sessions: UnifiedSessionRow[]
}

export type UnifiedRepoGroup = {
  repoId: string
  repoName: string
  cpu: Metric
  memory: Metric
  hasRemoteChildren: boolean
  worktrees: UnifiedWorktreeRow[]
}

// ─── Inputs that the renderer already has on hand ───────────────────

export type MergeContext = {
  /** From useAppStore: maps tabId → worktreeId for tab-walk resolution. */
  tabsByWorktree: Record<string, TerminalTab[]>
  /** From useAppStore: maps tabId → ptyIds[] for the bound check. */
  ptyIdsByTabId: Record<string, string[]>
  /** From useAppStore: per-tab live pane titles (for label resolution).
   *  Indexed by the renderer-local numeric paneId — the renderer-internal
   *  handle that never crosses an IPC boundary. Cross-boundary callers must
   *  resolve through `numericPaneIdByPaneKey` first. */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** From useAppStore: maps `${tabId}:${stablePaneId}` paneKey → numeric
   *  paneId. PaneManager writes this on pane create/adopt/close. */
  numericPaneIdByPaneKey: Record<string, number>
  /** From useAppStore: false until the renderer has booted enough state to
   *  trust the bound/orphan distinction. Mirrors the existing gate. */
  workspaceSessionReady: boolean
  /** Repo display names by repo id. Used for new groups synthesized from
   *  daemon sessions whose repo isn't in the snapshot (typical SSH case). */
  repoDisplayNameById: Map<string, string>
}

// ─── Helpers ────────────────────────────────────────────────────────

const ORCA_WORKTREE_ID_SEPARATOR = '::'

/** Why: minted PTY session ids look like `${worktreeId}@@${shortUuid}`
 *  (see src/main/daemon/pty-session-id.ts). The renderer-side parser
 *  only needs the prefix; `lastIndexOf` is robust to worktreeIds that
 *  may themselves contain `@`. */
function parseWorktreeIdFromSessionId(sessionId: string): string | null {
  const idx = sessionId.lastIndexOf('@@')
  if (idx <= 0) {
    return null
  }
  const candidate = sessionId.slice(0, idx)
  if (!candidate.includes(ORCA_WORKTREE_ID_SEPARATOR)) {
    return null
  }
  return candidate
}

function deriveRepoIdFromWorktreeId(worktreeId: string): string {
  const sep = worktreeId.indexOf(ORCA_WORKTREE_ID_SEPARATOR)
  return sep > 0 ? worktreeId.slice(0, sep) : worktreeId
}

function deriveWorktreeNameFromWorktreeId(worktreeId: string): string {
  const sep = worktreeId.indexOf(ORCA_WORKTREE_ID_SEPARATOR)
  if (sep <= 0) {
    return worktreeId
  }
  const path = worktreeId.slice(sep + 2)
  if (!path) {
    return worktreeId
  }
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? worktreeId
}

function shortCwd(cwd: string): string {
  if (!cwd) {
    return ''
  }
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(sep) : cwd
}

function resolveSnapshotSessionLabel(
  session: SessionMemory,
  worktreeId: string,
  ctx: MergeContext
): string {
  // Why: shared parsePaneKey rejects non-UUID suffixes so pre-migration
  // numeric paneKeys surviving in a daemon snapshot can't reach pane lookup.
  const paneKey = session.paneKey
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  if (parsed && paneKey) {
    const tabs = ctx.tabsByWorktree[worktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === parsed.tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      // Why: paneKey is opaque post-stablePaneId migration, but
      // runtimePaneTitlesByTabId is still indexed by the renderer-local
      // numeric paneId. Resolve through the store-backed mirror that
      // PaneManager populates on pane create/adopt/close.
      const numericId = ctx.numericPaneIdByPaneKey[paneKey]
      const runtime =
        typeof numericId === 'number'
          ? ctx.runtimePaneTitlesByTabId[parsed.tabId]?.[numericId]?.trim()
          : undefined
      if (runtime) {
        return runtime
      }
      // Why: when the mirror briefly lacks an entry for this paneKey, we can
      // only borrow the same-tab runtime title if this snapshot session is the
      // tab's sole live PTY. runtimePaneTitlesByTabId is sparse (untitled panes
      // may have no entry), so title-map cardinality alone is not a safe pane
      // count. The PTY binding keeps split-pane tabs ambiguous instead of
      // mis-attributing a sibling pane's title to this session.
      const runtimeMap = ctx.runtimePaneTitlesByTabId[parsed.tabId]
      const tabPtyIds = ctx.ptyIdsByTabId[parsed.tabId] ?? []
      const isOnlyPtyForTab = tabPtyIds.length === 1 && tabPtyIds[0] === session.sessionId
      if (isOnlyPtyForTab && runtimeMap && Object.keys(runtimeMap).length === 1) {
        const live = Object.values(runtimeMap)[0]?.trim()
        if (live) {
          return live
        }
      }
      return tab.defaultTitle?.trim() || tab.title?.trim() || `Terminal ${tabIndex + 1}`
    }
  }
  if (session.pid > 0) {
    return `pid ${session.pid}`
  }
  const fallback = session.sessionId?.slice(0, 8)
  return fallback ? `session ${fallback}` : '(unknown session)'
}

function resolveDaemonSessionLabel(
  session: DaemonSession,
  resolvedWorktreeId: string | null,
  tabId: string | null,
  ctx: MergeContext
): string {
  if (tabId && resolvedWorktreeId) {
    const tabs = ctx.tabsByWorktree[resolvedWorktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtimeMap = ctx.runtimePaneTitlesByTabId[tabId]
      if (runtimeMap) {
        const live = Object.values(runtimeMap).find((t) => t?.trim())
        if (live) {
          return live
        }
      }
      const fallback = tab.defaultTitle?.trim() || tab.title?.trim()
      if (fallback) {
        return fallback
      }
    }
  }
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  if (resolvedWorktreeId) {
    return shortCwd(resolvedWorktreeId)
  }
  if (session.title) {
    return session.title
  }
  return 'unknown'
}

// Why: the previous implementation did O(N) linear scans over
// ptyIdsByTabId / tabsByWorktree for *every* session it processed. With a
// large workspace that's S * (T + W) work per merge — and the merge runs on
// every snapshot poll plus every store mutation. Pre-build O(1) lookup
// indices once per merge instead.
type MergeIndex = {
  ptyIdToTabId: Map<string, string>
  tabIdToWorktreeId: Map<string, string>
}

function buildMergeIndex(ctx: MergeContext): MergeIndex {
  const ptyIdToTabId = new Map<string, string>()
  for (const [tabId, ptyIds] of Object.entries(ctx.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      if (ptyId) {
        ptyIdToTabId.set(ptyId, tabId)
      }
    }
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(ctx.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  return { ptyIdToTabId, tabIdToWorktreeId }
}

// ─── Public merge function ─────────────────────────────────────────

export const UNATTRIBUTED_REPO_ID = '__unattributed__'
export const UNATTRIBUTED_REPO_NAME = 'Unattributed'

export function mergeSnapshotAndSessions(
  snapshot: MemorySnapshot | null,
  daemonSessions: readonly DaemonSession[],
  ctx: MergeContext
): UnifiedRepoGroup[] {
  const repos = new Map<string, UnifiedRepoGroup>()
  const seenSessionIds = new Set<string>()
  const index = buildMergeIndex(ctx)
  // Why: bound = the daemon session id appears as a pty id under some tab.
  // ptyIdToTabId already encodes that membership in O(1), so the bound set
  // is just its keys.
  const boundPtyIds = ctx.workspaceSessionReady
    ? new Set(index.ptyIdToTabId.keys())
    : new Set<string>()

  function ensureRepo(
    repoId: string,
    repoName: string,
    initiallyHasRemoteChildren = false
  ): UnifiedRepoGroup {
    const existing = repos.get(repoId)
    if (existing) {
      return existing
    }
    const next: UnifiedRepoGroup = {
      repoId,
      repoName,
      cpu: null,
      memory: null,
      hasRemoteChildren: initiallyHasRemoteChildren,
      worktrees: []
    }
    repos.set(repoId, next)
    return next
  }

  function findWorktreeRow(
    repo: UnifiedRepoGroup,
    worktreeId: string
  ): UnifiedWorktreeRow | undefined {
    return repo.worktrees.find((w) => w.worktreeId === worktreeId)
  }

  // ── Step 1: ingest snapshot worktrees as the local-truth foundation.
  if (snapshot) {
    for (const wt of snapshot.worktrees as readonly WorktreeMemory[]) {
      const repo = ensureRepo(wt.repoId, wt.repoName)
      const sessions: UnifiedSessionRow[] = wt.sessions.map((s) => {
        seenSessionIds.add(s.sessionId)
        const tabId = index.ptyIdToTabId.get(s.sessionId) ?? null
        return {
          sessionId: s.sessionId,
          paneKey: s.paneKey,
          pid: s.pid,
          label: resolveSnapshotSessionLabel(s, wt.worktreeId, ctx),
          bound: ctx.workspaceSessionReady && boundPtyIds.has(s.sessionId),
          tabId,
          cpu: s.cpu,
          memory: s.memory,
          hasLocalSamples: true
        }
      })
      repo.worktrees.push({
        worktreeId: wt.worktreeId,
        worktreeName: wt.worktreeName,
        repoId: wt.repoId,
        repoName: wt.repoName,
        cpu: wt.cpu,
        memory: wt.memory,
        history: wt.history,
        hasLocalSamples: true,
        sessions
      })
    }
  }

  // ── Step 2: union daemon sessions that the snapshot didn't cover.
  for (const session of daemonSessions) {
    if (seenSessionIds.has(session.id)) {
      continue
    }
    seenSessionIds.add(session.id)

    // 2a: tab-store walk — does this session belong to a tab in this renderer?
    const tabId = index.ptyIdToTabId.get(session.id) ?? null
    let worktreeId = tabId ? (index.tabIdToWorktreeId.get(tabId) ?? null) : null

    // 2b: @@-parse — recover worktreeId from the minted session id format.
    if (!worktreeId) {
      worktreeId = parseWorktreeIdFromSessionId(session.id)
    }

    // 2c: unattributed bucket.
    const isUnattributed = !worktreeId
    const finalWorktreeId = worktreeId ?? `${UNATTRIBUTED_REPO_ID}::${session.id}`
    const finalRepoId = isUnattributed
      ? UNATTRIBUTED_REPO_ID
      : deriveRepoIdFromWorktreeId(finalWorktreeId)
    const finalRepoName = isUnattributed
      ? UNATTRIBUTED_REPO_NAME
      : ctx.repoDisplayNameById.get(finalRepoId) || finalRepoId
    const finalWorktreeName = isUnattributed
      ? session.title || session.id.slice(0, 12)
      : deriveWorktreeNameFromWorktreeId(finalWorktreeId)

    const repo = ensureRepo(finalRepoId, finalRepoName, true)
    repo.hasRemoteChildren = true

    let row = findWorktreeRow(repo, finalWorktreeId)
    if (!row) {
      row = {
        worktreeId: finalWorktreeId,
        worktreeName: finalWorktreeName,
        repoId: finalRepoId,
        repoName: finalRepoName,
        cpu: null,
        memory: null,
        history: [],
        hasLocalSamples: false,
        sessions: []
      }
      repo.worktrees.push(row)
    }

    row.sessions.push({
      sessionId: session.id,
      paneKey: null,
      pid: 0,
      label: resolveDaemonSessionLabel(session, worktreeId, tabId, ctx),
      bound: ctx.workspaceSessionReady && boundPtyIds.has(session.id),
      tabId,
      cpu: null,
      memory: null,
      hasLocalSamples: false
    })
  }

  // ── Step 3: per-repo aggregates exclude remote children.
  for (const repo of repos.values()) {
    let cpuSum = 0
    let memSum = 0
    let anyLocal = false
    let anyRemote = false
    for (const wt of repo.worktrees) {
      if (wt.hasLocalSamples && wt.cpu !== null && wt.memory !== null) {
        cpuSum += wt.cpu
        memSum += wt.memory
        anyLocal = true
      } else {
        anyRemote = true
      }
    }
    repo.cpu = anyLocal ? cpuSum : null
    repo.memory = anyLocal ? memSum : null
    if (anyRemote) {
      repo.hasRemoteChildren = true
    }
  }

  return [...repos.values()]
}
