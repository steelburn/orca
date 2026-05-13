export type FeatureWallSurface = 'chip' | 'help_tour'

export type FeatureWallTileId =
  | 'tile-01'
  | 'tile-02'
  | 'tile-03'
  | 'tile-04'
  | 'tile-05'
  | 'tile-06'
  | 'tile-07'

export type FeatureWallTile = {
  id: FeatureWallTileId
  title: string
  caption: string
  gifPath: string
  posterPath: string
  recordedAtPath: string
  owner: string
  affordanceHint?: string
}

export const FEATURE_WALL_TILES: readonly FeatureWallTile[] = [
  {
    id: 'tile-01',
    title: 'Per-worktree browser + Design Mode',
    caption: "Click any element in your app - Orca drops it straight into the agent's chat.",
    gifPath: 'tile-01.gif',
    posterPath: 'tile-01.poster.jpg',
    recordedAtPath: 'tile-01.recorded-at.json',
    owner: 'browser-experience',
    affordanceHint: 'click element'
  },
  {
    id: 'tile-02',
    title: 'Let the agent drive a browser',
    caption:
      'Hand the agent a URL - it can drive the browser, click through, and bring the answer back.',
    gifPath: 'tile-02.gif',
    posterPath: 'tile-02.poster.jpg',
    recordedAtPath: 'tile-02.recorded-at.json',
    owner: 'browser-automation'
  },
  {
    id: 'tile-03',
    title: 'GitHub and Linear tasks to workspaces',
    caption: 'Pick an issue from GitHub or Linear - Orca turns it into a workspace.',
    gifPath: 'tile-03.gif',
    posterPath: 'tile-03.poster.jpg',
    recordedAtPath: 'tile-03.recorded-at.json',
    owner: 'task-integrations'
  },
  {
    id: 'tile-04',
    title: 'Agent statuses in the sidebar',
    caption: "See every agent's status at a glance - running, waiting, done - all in the sidebar.",
    gifPath: 'tile-04.gif',
    posterPath: 'tile-04.poster.jpg',
    recordedAtPath: 'tile-04.recorded-at.json',
    owner: 'agent-dashboard'
  },
  {
    id: 'tile-05',
    title: 'SSH remote workspaces',
    caption: 'Run agents directly on a remote box over SSH - your laptop never sees the code.',
    gifPath: 'tile-05.gif',
    posterPath: 'tile-05.poster.jpg',
    recordedAtPath: 'tile-05.recorded-at.json',
    owner: 'ssh-workspaces'
  },
  {
    id: 'tile-06',
    title: 'Hot-swap Codex accounts',
    caption: 'Multiple Codex accounts? Hot-swap in one click - no re-login, no config files.',
    gifPath: 'tile-06.gif',
    posterPath: 'tile-06.poster.jpg',
    recordedAtPath: 'tile-06.recorded-at.json',
    owner: 'codex-accounts'
  },
  {
    id: 'tile-07',
    title: 'Diff comments on AI changes',
    caption: 'Comment directly on what your agent wrote - like a PR review, in the editor.',
    gifPath: 'tile-07.gif',
    posterPath: 'tile-07.poster.jpg',
    recordedAtPath: 'tile-07.recorded-at.json',
    owner: 'diff-review'
  }
] as const
