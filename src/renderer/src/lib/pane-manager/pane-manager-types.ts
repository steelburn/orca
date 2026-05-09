import type { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { LigaturesAddon } from '@xterm/addon-ligatures'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { GlobalSettings } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Hints forwarded from splitPane() into onPaneCreated for a single split.
 *  Currently only carries the resolved cwd for the new pane's PTY spawn.
 *  Kept as a separate parameter (rather than extending ManagedPane) so the
 *  hint is scoped to pane creation and does not live on the pane afterwards. */
export type PaneSpawnHints = {
  cwd?: string
}

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane, spawnHints?: PaneSpawnHints) => void | Promise<void>
  // Why: closedStableId enables paneKey-keyed cleanup in the callback after
  // closePane has cleared the manager's internal mappings.
  onPaneClosed?: (paneId: number, closedStableId: string | null) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
  initialRenderingSuspended?: boolean
  terminalGpuAcceleration?: GlobalSettings['terminalGpuAcceleration']
  // Why: diagnostic label for log correlation. safeFit and other internal
  // helpers log warnings that are hard to correlate without knowing which
  // tab/worktree the PaneManager belongs to.
  debugLabel?: string
  /** Notified when PaneManager mints a UUID for a freshly created pane.
   *  Consumers (e.g. the store mirror used by IPC ingress) wire the
   *  paneKey → numericId binding here so cross-boundary lookups work
   *  without holding a manager ref. */
  onStableIdRegistered?: (numericId: number, stablePaneId: string) => void
  /** Notified when adoptStablePaneId reattaches a snapshot UUID after
   *  layout replay. `previousStableId` is the UUID that
   *  createPaneInternal originally minted before the adopt; consumers
   *  that already wrote a mirror entry for it should drop that entry. */
  onStableIdAdopted?: (
    numericId: number,
    stablePaneId: string,
    previousStableId: string | null
  ) => void
  /** Notified when a pane closes (or PaneManager is destroyed) so the
   *  store mirror can drop its paneKey row. */
  onStableIdReleased?: (numericId: number, stablePaneId: string | null) => void
}

export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
  // Why this behavior flag lives on "style" options: this type is already
  // the single runtime-settings bag the PaneManager exposes. Splitting into
  // separate style vs behavior types is a refactor worth its own change
  // when a second behavior flag lands. See docs/focus-follows-mouse-design.md.
  focusFollowsMouse?: boolean
  paddingX?: number
  paddingY?: number
}

export type ManagedPane = {
  id: number
  /** Opaque per-pane UUID minted at creation. Stable across layout restores —
   *  unlike `id`, which is a renderer-local counter that renumbers in
   *  replayTerminalLayout. Use this (not `id`) as the cross-boundary identity
   *  in paneKey (`${tabId}:${stablePaneId}`), in `ORCA_PANE_KEY`, and in any
   *  store/IPC value that must survive a renderer reload. */
  stablePaneId: string
  terminal: Terminal
  container: HTMLElement // the .pane element
  linkTooltip: HTMLElement
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ScrollState = {
  wasAtBottom: boolean
  firstVisibleLineContent: string
  viewportY: number
  totalLines: number
}

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  terminalGpuAcceleration: GlobalSettings['terminalGpuAcceleration']
  gpuRenderingEnabled: boolean
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  webglAddon: WebglAddon | null
  // Why nullable: ligatures are opt-in per font and toggleable at runtime,
  // so the addon instance only exists while the feature is active. A null
  // value means "currently disabled".
  ligaturesAddon: LigaturesAddon | null
  fitResizeObserver: ResizeObserver | null
  pendingObservedFitRafId: number | null
  serializeAddon: SerializeAddon
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
  // Stored so disposePane() can remove it and avoid a memory leak.
  compositionHandler: (() => void) | null
  // Why: during splitPane, multiple async operations (rAFs, ResizeObserver
  // debounce, WebGL context loss) may independently attempt scroll
  // restoration. This field acts as a lock: when set, safeFit and other
  // intermediate fit paths skip their own scroll restoration, deferring to
  // the splitPane's final authoritative restore.
  pendingSplitScrollState: ScrollState | null
  debugLabel: string | null
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
