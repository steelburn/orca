/* eslint-disable max-lines -- Why: this prototype keeps the real-data adapter
and current visual skeleton together until the next refinement pass decides
which pieces become production modules. */
import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bell,
  BellDot,
  BellOff,
  MessageSquareText,
  Search,
  Settings,
  TerminalSquare
} from 'lucide-react'

import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '@/store'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ACTIVITY_TERMINAL_PORTAL_TARGET_ID } from './activity-terminal-portal'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'

type ThreadReadFilter = 'all' | 'unread'
type ActivityDensity = 'compact' | 'comfortable'

type ActivityEvent = {
  id: string
  state: Extract<AgentStatusState, 'done' | 'blocked' | 'waiting'>
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  unread: boolean
}

// Why (per-pane thread): the activity feed is keyed on the agent pane (a
// terminal tab + pane id) rather than on the workspace, so the left list
// shows one entry per agent. paneKey is the stable identity (`${tabId}:${paneId}`).
type AgentPaneThread = {
  paneKey: string
  paneTitle: string
  worktree: Worktree
  repo: Repo | null
  agentType: AgentType
  latestEvent: ActivityEvent
  events: ActivityEvent[]
  unread: boolean
}

const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatAbsoluteDate(timestamp: number): string {
  return absoluteDateFormatter.format(new Date(timestamp))
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = timestamp - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }
  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}

function paneIdFromPaneKey(paneKey: string): number | null {
  const colon = paneKey.indexOf(':')
  const tail = colon > 0 ? paneKey.slice(colon + 1) : ''
  const parsed = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function agentTitle(event: ActivityEvent): string {
  if (event.state === 'done') {
    return event.entry.interrupted ? 'Agent interrupted' : 'Agent finished'
  }
  return event.state === 'waiting' ? 'Agent waiting for input' : 'Agent needs input'
}

function agentSummary(event: ActivityEvent): string {
  const prompt = event.entry.prompt.trim()
  if (event.state === 'done') {
    const message = event.entry.lastAssistantMessage?.trim()
    return message || prompt || 'Completed the current turn.'
  }
  return prompt || event.entry.lastAssistantMessage?.trim() || 'The agent paused for user input.'
}

function agentMeta(event: ActivityEvent): string {
  const agent = formatAgentTypeLabel(event.agentType)
  if (event.state === 'done') {
    return event.entry.interrupted ? `${agent} interrupted` : `${agent} completed`
  }
  return event.state === 'waiting' ? `${agent} waiting` : `${agent} blocked`
}

// Why (label hierarchy): mirrors the per-workspace agents dropdown
// (DashboardAgentRow / WorktreeCardAgents): user-renamed customTitle wins,
// then a non-default terminal title (set via OSC by some agent CLIs), then
// the agent's last prompt — the prompt IS what the agent's working on, so
// it labels the row far better than the default "Terminal N". Falls back
// to defaultTitle/Terminal only when nothing else is available.
function paneTitleForEvent(event: ActivityEvent): string {
  const tab = event.tab
  const customTitle = tab.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }
  const liveTitle = tab.title?.trim()
  const defaultTitle = tab.defaultTitle?.trim()
  if (liveTitle && liveTitle !== defaultTitle) {
    return liveTitle
  }
  const prompt = event.entry.prompt.trim()
  if (prompt) {
    return prompt
  }
  return defaultTitle || liveTitle || 'Terminal'
}

function buildActivityEvents(args: {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  acknowledgedAgentsByPaneKey: Record<string, number>
}): ActivityEvent[] {
  const events: ActivityEvent[] = []
  const tabContext = new Map<string, { worktree: Worktree; tab: TerminalTab }>()

  for (const worktree of args.worktreeMap.values()) {
    const tabs = args.tabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      tabContext.set(tab.id, { worktree, tab })
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    if (entry.state !== 'done' && entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    const separatorIndex = paneKey.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, separatorIndex)
    const context = tabContext.get(tabId)
    if (!context) {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    events.push({
      id: `agent-live:${paneKey}:${entry.stateStartedAt}`,
      state: entry.state,
      timestamp: entry.stateStartedAt,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown',
      agentAlive: true,
      unread: ackAt < entry.stateStartedAt
    })
  }

  for (const [paneKey, retained] of Object.entries(args.retainedAgentsByPaneKey)) {
    const worktree = args.worktreeMap.get(retained.worktreeId)
    if (!worktree || retained.entry.state !== 'done') {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    events.push({
      id: `agent-retained:${paneKey}:${retained.entry.stateStartedAt}`,
      state: 'done',
      timestamp: retained.entry.stateStartedAt,
      worktree,
      repo: args.repoMap.get(worktree.repoId) ?? null,
      entry: retained.entry,
      tab: retained.tab,
      agentType: retained.agentType,
      agentAlive: false,
      unread: ackAt < retained.entry.stateStartedAt
    })
  }

  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 80)
}

function buildAgentPaneThreads(events: ActivityEvent[]): AgentPaneThread[] {
  const byPaneKey = new Map<string, AgentPaneThread>()
  for (const event of events) {
    const paneKey = event.entry.paneKey
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEvent(event),
        worktree: event.worktree,
        repo: event.repo,
        agentType: event.agentType,
        latestEvent: event,
        events: [event],
        unread: event.unread
      })
      continue
    }
    existing.events.push(event)
    existing.unread = existing.unread || event.unread
    if (event.timestamp > existing.latestEvent.timestamp) {
      existing.latestEvent = event
      existing.paneTitle = paneTitleForEvent(event)
      existing.agentType = event.agentType
    }
  }

  return Array.from(byPaneKey.values())
    .map((thread) => ({
      ...thread,
      events: [...thread.events].sort((a, b) => b.timestamp - a.timestamp)
    }))
    .sort((a, b) => b.latestEvent.timestamp - a.latestEvent.timestamp)
}

function EventTime({ timestamp }: { timestamp: number }): React.JSX.Element {
  const absolute = formatAbsoluteDate(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={absolute}
          onClick={(event) => event.stopPropagation()}
        >
          {formatRelativeTime(timestamp)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {absolute}
      </TooltipContent>
    </Tooltip>
  )
}

function EventRepoBadge({ repo }: { repo: Repo | null }): React.JSX.Element | null {
  if (!repo) {
    return null
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
      <div className="size-1.5 rounded-full" style={{ backgroundColor: repo.badgeColor }} />
      <span className="max-w-[6rem] truncate text-[10px] font-semibold leading-none text-foreground lowercase">
        {repo.displayName}
      </span>
    </div>
  )
}

function ThreadRow({
  thread,
  density,
  selected,
  onSelect,
  onToggleRead
}: {
  thread: AgentPaneThread
  density: ActivityDensity
  selected: boolean
  onSelect: () => void
  onToggleRead: () => void
}): React.JSX.Element {
  const latest = thread.latestEvent
  const compact = density === 'compact'
  const toggleLabel = thread.unread ? 'Mark thread read' : 'Mark thread unread'
  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Why (selected/hover/unread cues match WorktreeCard):
        // - selected → solid black/white tint + faint shadow, no hover
        //   override (the active class wins so hover doesn't fight it).
        // - non-selected → only then does hover apply (bg-accent/40), so a
        //   selected row stays visually fixed when the cursor moves over it.
        // - unread → weight + left-edge primary bar carry the cue; no row
        //   tint, mirroring WorktreeCard's "weight alone" pattern. Three
        //   stacked tints (selected + unread + hover) made selected and
        //   unread look identical when hovered.
        'group relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border px-3 text-left transition-colors',
        compact ? 'py-1.5' : 'py-2.5',
        selected
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'hover:bg-accent/40'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <span className="min-w-0">
        <span className="flex min-w-0 items-start gap-2">
          <span className="inline-flex shrink-0 pt-[3px]">
            <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={14} />
          </span>
          {/* Why (line-clamp-2 + smaller size): prompts can be long; clamping
              to two lines lets users read more of the prompt while keeping
              rows scannable. text-[13px] tightens the leading slightly so two
              clamped lines don't dominate the row vertically. */}
          <span
            className={cn(
              'line-clamp-2 break-words text-[13px] leading-snug',
              thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
            )}
          >
            {thread.paneTitle}
          </span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <EventRepoBadge repo={thread.repo} />
          <span className="truncate text-xs text-muted-foreground">
            {thread.worktree.displayName}
          </span>
        </span>
        {!compact ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {agentTitle(latest)}
          </span>
        ) : null}
      </span>
      <span className={cn('flex flex-col items-end pt-0.5', compact ? 'gap-1' : 'gap-2')}>
        <span className="flex min-w-16 flex-col items-end gap-1">
          <span className="relative flex h-6 min-w-16 items-start justify-end">
            <span className="transition-opacity group-hover:opacity-0">
              <EventTime timestamp={latest.timestamp} />
            </span>
            <span className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-xs"
                    aria-label={toggleLabel}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleRead()
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    {thread.unread ? <BellOff className="size-3" /> : <Bell className="size-3" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{toggleLabel}</TooltipContent>
              </Tooltip>
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            {thread.unread ? (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
                New
              </span>
            ) : null}
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
              {thread.events.length}
            </Badge>
          </span>
        </span>
      </span>
    </div>
  )
}

export default function ActivityPrototypePage(): React.JSX.Element {
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>('all')
  const [leftSidebarCompact, setLeftSidebarCompact] = useState(true)
  const leftSidebarDensity: ActivityDensity = leftSidebarCompact ? 'compact' : 'comfortable'
  const [query, setQuery] = useState('')
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [threadListWidth, setThreadListWidth] = useState(340)
  const {
    containerRef: threadListRef,
    isResizing: isThreadListResizing,
    onResizeStart
  } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: threadListWidth,
    minWidth: 280,
    maxWidth: 560,
    deltaSign: 1,
    setWidth: setThreadListWidth
  })

  const storeData = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents
    }))
  )

  const allEvents = useMemo(() => buildActivityEvents(storeData), [storeData])

  const allThreads = useMemo(() => buildAgentPaneThreads(allEvents), [allEvents])

  const visibleThreads = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    return allThreads.filter((thread) => {
      if (readFilter === 'unread' && !thread.unread) {
        return false
      }
      if (!trimmedQuery) {
        return true
      }
      const latest = thread.latestEvent
      const text =
        `${thread.paneTitle} ${thread.worktree.displayName} ${thread.repo?.displayName ?? ''} ${agentTitle(latest)} ${agentSummary(latest)} ${agentMeta(latest)}`.toLowerCase()
      return text.includes(trimmedQuery)
    })
  }, [allThreads, readFilter, query])

  useEffect(() => {
    if (selectedPaneKey && !allThreads.some((thread) => thread.paneKey === selectedPaneKey)) {
      setSelectedPaneKey(null)
    }
  }, [allThreads, selectedPaneKey])

  const selectedThread = selectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === selectedPaneKey) ?? null)
    : null

  const markThreadRead = (thread: AgentPaneThread): void => {
    storeData.acknowledgeAgents([thread.paneKey])
  }

  const markThreadUnread = (thread: AgentPaneThread): void => {
    storeData.unacknowledgeAgents([thread.paneKey])
  }

  const activateThreadTerminal = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    if (state.activeRepoId !== thread.worktree.repoId) {
      state.setActiveRepo(thread.worktree.repoId)
    }
    if (state.activeWorktreeId !== thread.worktree.id) {
      state.setActiveWorktree(thread.worktree.id)
    }
    state.setActiveTabType('terminal')
    activateTabAndFocusPane(thread.latestEvent.tab.id, paneIdFromPaneKey(thread.paneKey))
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    markThreadRead(thread)
    activateThreadTerminal(thread)
  }

  const toggleThreadRead = (thread: AgentPaneThread): void => {
    if (thread.unread) {
      markThreadRead(thread)
      return
    }
    markThreadUnread(thread)
  }

  // Why (page padding): drop top + horizontal padding so the page extends to
  // the window's left and right edges (matching how sidebars abut the chrome
  // elsewhere). The titlebar (ActivityTitlebarControls) already provides the
  // breathing-room band above; the right pane's title row supplies its own
  // top padding (pt-2) so the heading isn't pinned to the titlebar.
  return (
    <div className="flex h-full min-h-0 flex-col bg-background pb-3">
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          ref={threadListRef}
          className="relative flex min-h-0 shrink-0 flex-col border-r border-border"
          style={{ width: threadListWidth }}
        >
          <div className="shrink-0 border-b border-border px-2 pt-1.5 pb-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                Agents
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Activity list display options"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Settings className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="bottom" className="min-w-44">
                  <DropdownMenuLabel>Display style</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={leftSidebarCompact}
                    onCheckedChange={(checked) => setLeftSidebarCompact(checked === true)}
                  >
                    Compact list
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter..."
                  className="h-8 w-full pl-7 text-xs"
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    pressed={readFilter === 'unread'}
                    onPressedChange={(pressed) => setReadFilter(pressed ? 'unread' : 'all')}
                    variant="outline"
                    size="sm"
                    className={cn(
                      'size-8 shrink-0 p-0',
                      readFilter === 'unread'
                        ? '!border-primary !bg-primary !text-primary-foreground shadow-xs ring-2 ring-primary/35 hover:!bg-primary/90 hover:!text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Show unread threads only"
                  >
                    <BellDot className="size-3.5" />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom">Show unread threads only</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
            {visibleThreads.map((thread) => (
              <ThreadRow
                key={thread.paneKey}
                thread={thread}
                density={leftSidebarDensity}
                selected={thread.paneKey === selectedThread?.paneKey}
                onSelect={() => selectThread(thread)}
                onToggleRead={() => toggleThreadRead(thread)}
              />
            ))}
            {visibleThreads.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                No agent activity matches these filters.
              </div>
            ) : null}
          </div>
          <div
            aria-label="Resize activity thread list"
            title="Drag to resize"
            className={cn(
              'group absolute -right-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-center',
              isThreadListResizing && 'bg-ring/10'
            )}
            onMouseDown={onResizeStart}
            role="separator"
          >
            <div
              className={cn(
                'h-full w-px bg-border transition-colors group-hover:bg-ring/50',
                isThreadListResizing && 'bg-ring'
              )}
            />
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden">
          {selectedThread ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-border px-4 pt-2 pb-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="inline-flex shrink-0 pt-[3px]">
                      <AgentIcon agent={agentTypeToIconAgent(selectedThread.agentType)} size={16} />
                    </span>
                    {/* Why: clamp to 2 lines (matches ThreadRow) so longer
                        prompts don't get cut to one ellipsis. Badge moves to
                        the secondary line so it stays at a fixed position
                        regardless of title height. */}
                    <h2 className="line-clamp-2 break-words text-sm font-semibold leading-snug">
                      {selectedThread.paneTitle}
                    </h2>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5">
                    <EventRepoBadge repo={selectedThread.repo} />
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedThread.worktree.displayName}
                    </span>
                  </div>
                </div>
              </div>
              {/* Why: Terminal stays mounted in the hidden workspace tree while
                  Activity is open. This target lets that existing TerminalPane
                  move here instead of creating a second PTY/xterm owner. */}
              <div
                id={ACTIVITY_TERMINAL_PORTAL_TARGET_ID}
                className="relative min-h-0 flex-1 overflow-hidden bg-editor-surface"
                data-activity-terminal-tab-id={selectedThread.latestEvent.tab.id}
              />
            </div>
          ) : (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              {visibleThreads.length === 0 ? (
                <>
                  <MessageSquareText className="size-7" />
                  No activity yet.
                </>
              ) : (
                <>
                  <TerminalSquare className="size-7" />
                  Select an agent to open its terminal.
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
