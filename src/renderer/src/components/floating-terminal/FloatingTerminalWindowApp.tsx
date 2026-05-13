import { useCallback, useEffect, useMemo, useState } from 'react'
import { Maximize2, Minimize2, Pin, PinOff, X } from 'lucide-react'
import TabBar from '@/components/tab-bar/TabBar'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FLOATING_TERMINAL_WORKTREE_ID } from '@/lib/floating-terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { createSessionWriteSubscriber } from '@/lib/session-write-subscriber'
import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../../shared/types'
import {
  getFloatingTerminalSession,
  persistFloatingTerminalSession
} from './floating-terminal-session'

const EMPTY_TERMINAL_TABS: TerminalTab[] = []

export function FloatingTerminalWindowApp(): React.JSX.Element {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const setTabBarOrder = useAppStore((s) => s.setTabBarOrder)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const hydrateWorkspaceSession = useAppStore((s) => s.hydrateWorkspaceSession)
  const reconnectPersistedTerminals = useAppStore((s) => s.reconnectPersistedTerminals)
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const tabBarOrder = useAppStore((s) => s.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID])
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '~')
  const [cwd, setCwd] = useState<string | null>(null)
  const [pinned, setPinned] = useState(true)
  const [maximized, setMaximized] = useState(false)

  const tabs = tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  const activeTabId = activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? tabs[0]?.id ?? null
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await fetchSettings()
      const session = getFloatingTerminalSession(await window.api.session.get())
      if (cancelled) {
        return
      }
      hydrateWorkspaceSession(session)
      await reconnectPersistedTerminals()
    })()
    return () => {
      cancelled = true
    }
  }, [fetchSettings, hydrateWorkspaceSession, reconnectPersistedTerminals])

  useEffect(() => {
    if (!workspaceSessionReady || tabs.length > 0) {
      return
    }
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
  }, [createTab, setActiveTabForWorktree, tabs.length, workspaceSessionReady])

  useEffect(() => {
    void window.api.app.getFloatingTerminalCwd({ path: floatingTerminalCwd }).then(setCwd)
  }, [floatingTerminalCwd])

  useEffect(
    () =>
      createSessionWriteSubscriber({
        store: useAppStore,
        persist: (payload) => void persistFloatingTerminalSession(payload)
      }),
    []
  )

  useEffect(() => {
    let cancelled = false
    void window.api.ui.floatingTerminal.isPinned().then((value) => {
      if (!cancelled) {
        setPinned(value)
      }
    })
    void window.api.ui.floatingTerminal.isMaximized().then((value) => {
      if (!cancelled) {
        setMaximized(value)
      }
    })
    const offPinned = window.api.ui.floatingTerminal.onPinnedChanged(setPinned)
    const offMaximized = window.api.ui.floatingTerminal.onMaximizeChanged(setMaximized)
    return () => {
      cancelled = true
      offPinned()
      offMaximized()
    }
  }, [])

  const createFloatingTab = useCallback(() => {
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
    const state = useAppStore.getState()
    const currentTabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const stored = state.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const validIds = new Set(currentTabs.map((entry) => entry.id))
    setTabBarOrder(FLOATING_TERMINAL_WORKTREE_ID, [
      ...stored.filter((id) => validIds.has(id) && id !== tab.id),
      ...currentTabs.map((entry) => entry.id).filter((id) => id !== tab.id && !stored.includes(id)),
      tab.id
    ])
    focusTerminalTabSurface(tab.id)
  }, [createTab, setActiveTabForWorktree, setTabBarOrder])

  const closeOthers = useCallback(
    (tabId: string) => tabs.forEach((tab) => tab.id !== tabId && closeTab(tab.id)),
    [closeTab, tabs]
  )

  const closeToRight = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index >= 0) {
        tabs.slice(index + 1).forEach((tab) => closeTab(tab.id))
      }
    },
    [closeTab, tabs]
  )

  return (
    <TooltipProvider>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <div
          className="flex h-9 shrink-0 items-center border-b border-border bg-[var(--bg-titlebar,var(--card))]"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex h-full min-w-0 flex-1">
            <TabBar
              tabs={tabs}
              activeTabId={activeTab?.id ?? null}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              expandedPaneByTabId={expandedPaneByTabId}
              onActivate={(tabId) => setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tabId)}
              onClose={closeTab}
              onCloseOthers={closeOthers}
              onCloseToRight={closeToRight}
              onNewTerminalTab={createFloatingTab}
              onNewBrowserTab={() => {}}
              terminalOnly
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              onTogglePaneExpand={(tabId) =>
                setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
              }
              activeTabType="terminal"
              tabBarOrder={tabBarOrder}
            />
          </div>
          <div
            className="flex items-center gap-1 px-2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={pinned ? 'Unpin floating terminal' : 'Pin floating terminal'}
                  aria-pressed={pinned}
                  onClick={() => window.api.ui.floatingTerminal.togglePinned()}
                >
                  {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {pinned ? 'Unpin floating terminal' : 'Pin floating terminal'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    maximized ? 'Restore floating terminal' : 'Maximize floating terminal'
                  }
                  aria-pressed={maximized}
                  onClick={() => window.api.ui.floatingTerminal.toggleMaximized()}
                >
                  {maximized ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {maximized ? 'Restore' : 'Maximize'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Hide floating terminal"
                  onClick={() => window.api.ui.floatingTerminal.hide()}
                >
                  <X className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Hide floating terminal
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
          {cwd
            ? tabs.map((tab) => (
                <div
                  key={`${tab.id}-${tab.generation ?? 0}`}
                  className={
                    tab.id === activeTab?.id ? 'absolute inset-0' : 'absolute inset-0 hidden'
                  }
                  aria-hidden={tab.id !== activeTab?.id}
                >
                  <TerminalPane
                    tabId={tab.id}
                    worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                    cwd={cwd}
                    isActive={tab.id === activeTab?.id}
                    isVisible={tab.id === activeTab?.id}
                    onPtyExit={() => closeTab(tab.id)}
                    onCloseTab={() => closeTab(tab.id)}
                  />
                </div>
              ))
            : null}
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  )
}
