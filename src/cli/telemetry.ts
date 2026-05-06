// Dispatch-side CLI telemetry. One job: emit `cli_feature_used` at most once
// per (feature_group, CLI process) and never observably affect command
// behavior. See docs/cli-telemetry-design.md for the full design — the
// constraints below are load-bearing, not stylistic preferences.
//
// Constraints (each maps to a comment further down):
//   - never write to stdout/stderr (preserves --json purity, no
//     UnhandledPromiseRejectionWarning leaks)
//   - never block process exit (unref the socket + any pending timeout, no
//     `await` from the call site)
//   - never throw out of the dispatch path on telemetry failure
//   - dedupe per process via an in-memory Set
//
// Communication path: CLI → runtime RPC `telemetry.captureCliEvent` → main
// `track()`. If the app isn't running, metadata is missing, or the auth
// token is stale, we silently swallow — the CLI is not the consent
// authority and not the place to log telemetry health.

import { createConnection } from 'net'
import { randomUUID } from 'crypto'
import { findTransport, type RuntimeMetadata } from '../shared/runtime-bootstrap'
import { getDefaultUserDataPath, tryReadMetadata } from './runtime/metadata'

import type { CliFeatureGroup } from '../shared/telemetry-events'

// Map from `commandPath` (the same `commandPath.join(' ')` key dispatch uses)
// to a feature group. Kept exhaustive for the commands shipped today;
// unmapped commands return `null` and emit no event. Adding a new command
// without a mapping is a soft no-op — telemetry will silently miss it
// rather than mis-bucket — which is the right tradeoff for a coarse
// adoption signal.
//
// Groupings mirror docs/cli-telemetry-design.md §Events. If you change the
// grouping for a command, change it there too — dashboards built on the
// original grouping will silently mix old + new rows.
const COMMAND_TO_FEATURE_GROUP: Record<string, CliFeatureGroup> = {
  // worktree_orchestration: lifecycle of worktrees and base-ref repo state
  'worktree create': 'worktree_orchestration',
  'worktree rm': 'worktree_orchestration',
  'worktree set': 'worktree_orchestration',
  'repo add': 'worktree_orchestration',
  'repo set-base-ref': 'worktree_orchestration',

  // terminal_orchestration: terminal lifecycle + focus
  'terminal create': 'terminal_orchestration',
  'terminal split': 'terminal_orchestration',
  'terminal close': 'terminal_orchestration',
  'terminal stop': 'terminal_orchestration',
  'terminal rename': 'terminal_orchestration',
  'terminal switch': 'terminal_orchestration',
  'terminal focus': 'terminal_orchestration',

  // terminal_io: data flow into/out of an existing terminal
  'terminal read': 'terminal_io',
  'terminal send': 'terminal_io',
  'terminal wait': 'terminal_io',

  // browser_navigation: things that change "where" the page is
  goto: 'browser_navigation',
  back: 'browser_navigation',
  forward: 'browser_navigation',
  reload: 'browser_navigation',
  'tab create': 'browser_navigation',
  'tab close': 'browser_navigation',
  'tab switch': 'browser_navigation',

  // browser_observation: read-only inspection
  snapshot: 'browser_observation',
  screenshot: 'browser_observation',
  'full-screenshot': 'browser_observation',
  eval: 'browser_observation',
  exec: 'browser_observation',
  console: 'browser_observation',
  network: 'browser_observation',
  wait: 'browser_observation',
  pdf: 'browser_observation',
  get: 'browser_observation',
  is: 'browser_observation',
  find: 'browser_observation',

  // browser_interaction: mutate the page
  click: 'browser_interaction',
  dblclick: 'browser_interaction',
  fill: 'browser_interaction',
  type: 'browser_interaction',
  select: 'browser_interaction',
  check: 'browser_interaction',
  uncheck: 'browser_interaction',
  focus: 'browser_interaction',
  clear: 'browser_interaction',
  'select-all': 'browser_interaction',
  keypress: 'browser_interaction',
  hover: 'browser_interaction',
  drag: 'browser_interaction',
  upload: 'browser_interaction',
  scroll: 'browser_interaction',
  scrollintoview: 'browser_interaction',
  inserttext: 'browser_interaction',
  download: 'browser_interaction',
  highlight: 'browser_interaction',
  'mouse move': 'browser_interaction',
  'mouse down': 'browser_interaction',
  'mouse up': 'browser_interaction',
  'mouse wheel': 'browser_interaction',

  // browser_config: viewport/device/cookies/storage/intercept/capture
  viewport: 'browser_config',
  geolocation: 'browser_config',
  'set device': 'browser_config',
  'set offline': 'browser_config',
  'set headers': 'browser_config',
  'set credentials': 'browser_config',
  'set media': 'browser_config',
  'clipboard read': 'browser_config',
  'clipboard write': 'browser_config',
  'dialog accept': 'browser_config',
  'dialog dismiss': 'browser_config',
  'cookie get': 'browser_config',
  'cookie set': 'browser_config',
  'cookie delete': 'browser_config',
  'storage local get': 'browser_config',
  'storage local set': 'browser_config',
  'storage local clear': 'browser_config',
  'storage session get': 'browser_config',
  'storage session set': 'browser_config',
  'storage session clear': 'browser_config',
  'intercept enable': 'browser_config',
  'intercept disable': 'browser_config',
  'intercept list': 'browser_config',
  'capture start': 'browser_config',
  'capture stop': 'browser_config',
  'tab profile list': 'browser_config',
  'tab profile create': 'browser_config',
  'tab profile delete': 'browser_config',
  'tab profile set': 'browser_config',
  'tab profile show': 'browser_config',
  'tab profile use-default': 'browser_config',
  'tab profile clone': 'browser_config',

  // orchestration_coordinator: agents driving other agents
  'orchestration run': 'orchestration_coordinator',
  'orchestration run-stop': 'orchestration_coordinator',
  'orchestration task-create': 'orchestration_coordinator',
  'orchestration dispatch': 'orchestration_coordinator',
  'orchestration ask': 'orchestration_coordinator',
  'orchestration gate-create': 'orchestration_coordinator',
  'orchestration gate-resolve': 'orchestration_coordinator',
  'orchestration reset': 'orchestration_coordinator',

  // orchestration_messaging: inbox and message-mutation surfaces
  'orchestration check': 'orchestration_messaging',
  'orchestration inbox': 'orchestration_messaging',
  'orchestration task-list': 'orchestration_messaging',
  'orchestration task-update': 'orchestration_messaging',
  'orchestration send': 'orchestration_messaging',
  'orchestration reply': 'orchestration_messaging',
  'orchestration dispatch-show': 'orchestration_messaging',
  'orchestration gate-list': 'orchestration_messaging',

  // discovery: status / list / show / current / search
  status: 'discovery',
  open: 'discovery',
  'worktree list': 'discovery',
  'worktree ps': 'discovery',
  'worktree show': 'discovery',
  'worktree current': 'discovery',
  'terminal list': 'discovery',
  'terminal show': 'discovery',
  'tab list': 'discovery',
  'tab show': 'discovery',
  'tab current': 'discovery',
  'repo list': 'discovery',
  'repo show': 'discovery',
  'repo search-refs': 'discovery'
}

export function resolveFeatureGroup(commandPath: readonly string[]): CliFeatureGroup | null {
  return COMMAND_TO_FEATURE_GROUP[commandPath.join(' ')] ?? null
}

// Per-process dedupe set. The "first-write-wins on exit_status" rule lives
// here: once a group is in this Set, any later call in the same process —
// success or failure — never re-emits. See docs/cli-telemetry-design.md
// §Events for why.
const emittedGroups = new Set<CliFeatureGroup>()

// Test seam for the network layer. Production uses `defaultSender` below.
// Tests substitute a fake to assert what would be sent without opening a
// socket. Kept separate from `_resetEmittedGroupsForTests` so a test can
// reset dedupe state without rewiring the sender.
type Sender = (
  metadata: RuntimeMetadata,
  endpoint: string,
  body: { method: string; params: unknown }
) => Promise<void>

let senderOverride: Sender | null = null

export function _setTelemetrySenderForTests(sender: Sender | null): void {
  senderOverride = sender
}

export function _resetEmittedGroupsForTests(): void {
  emittedGroups.clear()
}

export function _getEmittedGroupsForTests(): ReadonlySet<CliFeatureGroup> {
  return emittedGroups
}

/**
 * Record that `commandPath` ran with `exitStatus`, and emit a
 * `cli_feature_used` event if this is the first call in the group for this
 * process. Fire-and-forget — this function never throws, never blocks, and
 * never logs.
 */
export function recordCliFeatureUsed(
  commandPath: readonly string[],
  exitStatus: 'success' | 'failure'
): void {
  const group = resolveFeatureGroup(commandPath)
  if (group === null) {
    return
  }
  if (emittedGroups.has(group)) {
    return
  }
  // Mark BEFORE attempting the send. If the send fails, we still treat the
  // group as "reported for this process" — retrying on every subsequent call
  // would amplify a broken-RPC scenario into one failed connect per command,
  // which is the opposite of "telemetry never affects user-visible behavior."
  emittedGroups.add(group)

  // `void` + `.catch` together cover the two ways a stray rejection could
  // become user-visible: an `await`-less promise without a `.catch` would
  // surface as `UnhandledPromiseRejectionWarning` to stderr, breaking
  // `--json` purity. Belt-and-braces because the implementation is supposed
  // to swallow internally, but a future refactor mustn't be able to leak.
  void sendCliFeatureUsed(group, exitStatus).catch(() => {
    // Swallow. This is the entire failure-handling story.
  })
}

async function sendCliFeatureUsed(
  group: CliFeatureGroup,
  exitStatus: 'success' | 'failure'
): Promise<void> {
  // Resolve userDataPath at send time so `ORCA_USER_DATA_PATH` is honored
  // identically to a regular RPC call.
  let userDataPath: string
  try {
    userDataPath = getDefaultUserDataPath()
  } catch {
    return
  }
  const metadata = tryReadMetadata(userDataPath)
  if (!metadata) {
    return
  }
  // authToken is required for the runtime RPC handshake; mirror readMetadata's guard.
  if (!metadata.authToken) {
    return
  }
  const transport = findTransport(metadata, 'unix', 'named-pipe')
  if (!transport) {
    return
  }
  const send = senderOverride ?? defaultSender
  await send(metadata, transport.endpoint, {
    method: 'telemetry.captureCliEvent',
    params: {
      name: 'cli_feature_used',
      props: { feature_group: group, exit_status: exitStatus }
    }
  })
}

// A purpose-built minimal RPC sender for telemetry. It diverges from
// `runtime/transport.ts` in two important ways:
//   1. The socket is `unref()`ed so a still-in-flight send never holds the
//      Node process open after the user-visible command has finished. A
//      short-lived `orca worktree list` exits as soon as `printResult`
//      returns, not when telemetry round-trips.
//   2. The timeout is `unref()`ed for the same reason. Without this, a
//      pending timer would keep the event loop alive even after the socket
//      is unref'd.
// We do not parse / validate the response — the CLI doesn't care whether
// main accepted, dropped at the consent gate, or rejected at the validator.
// The contract is: post the event and walk away.
const TELEMETRY_RPC_TIMEOUT_MS = 2_000

const defaultSender: Sender = async (metadata, endpoint, body) => {
  await new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      resolve()
    }

    let socket: ReturnType<typeof createConnection>
    try {
      socket = createConnection(endpoint)
    } catch {
      // `createConnection` typically does not throw synchronously, but
      // belt-and-braces — a malformed endpoint string would surface here.
      settle()
      return
    }

    socket.unref()

    // Discard whatever the server sends back. We only care about the
    // connect → write → end lifecycle for unrefing purposes; reading the
    // response is incidental and any read errors are themselves a "swallow"
    // case.
    socket.on('error', settle)
    socket.on('close', settle)
    socket.on('end', settle)
    // Drain incoming data so the kernel buffer doesn't sit around.
    socket.resume()

    const timeout = setTimeout(() => {
      socket.destroy()
      settle()
    }, TELEMETRY_RPC_TIMEOUT_MS)
    timeout.unref()

    socket.on('connect', () => {
      try {
        socket.write(
          `${JSON.stringify({
            id: randomUUID(),
            authToken: metadata.authToken,
            method: body.method,
            params: body.params
          })}\n`,
          () => {
            // Half-close: signals "no more requests on this socket" so main
            // can release its handler slot promptly. The server's reply (if
            // any) is what triggers `end`/`close` above and resolves us.
            socket.end()
          }
        )
      } catch {
        socket.destroy()
        settle()
      }
    })
  })
}
