// Dispatch-side dedupe and feature-group-mapping coverage. The wire shape
// (what props flow to the runtime RPC method) is the contract we're
// pinning here — `recordCliFeatureUsed` is the boundary the rest of the
// CLI talks to, and a regression in the dedupe logic would either flood
// PostHog (no dedupe) or starve adoption signal (over-dedupe).
//
// Tests intentionally substitute a fake sender via `_setTelemetrySenderForTests`
// rather than letting a socket open against a runtime that may or may not
// be running — the fire-and-forget transport's design (unref, swallow
// errors) makes it impossible to observe failures otherwise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _getEmittedGroupsForTests,
  _resetEmittedGroupsForTests,
  _setTelemetrySenderForTests,
  recordCliFeatureUsed,
  resolveFeatureGroup
} from './telemetry'
import { CORE_HANDLERS } from './handlers/core'
import { REPO_HANDLERS } from './handlers/repo'
import { WORKTREE_HANDLERS } from './handlers/worktree'
import { TERMINAL_HANDLERS } from './handlers/terminal'
import { BROWSER_NAV_HANDLERS } from './handlers/browser-nav'
import { BROWSER_INTERACT_HANDLERS } from './handlers/browser-interact'
import { BROWSER_TAB_HANDLERS } from './handlers/browser-tab'
import { BROWSER_PROFILE_HANDLERS } from './handlers/browser-profile'
import { BROWSER_COOKIE_HANDLERS } from './handlers/browser-cookie'
import { BROWSER_CAPTURE_HANDLERS } from './handlers/browser-capture'
import { BROWSER_ENV_HANDLERS } from './handlers/browser-env'
import { BROWSER_STORAGE_HANDLERS } from './handlers/browser-storage'
import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'
import type { RuntimeMetadata } from '../shared/runtime-bootstrap'
import type * as MetadataModule from './runtime/metadata'

// Stand in for a metadata file on disk. The sender shim never reads from
// disk in tests, but `tryReadMetadata` does — see the `vi.mock` below.
const FAKE_METADATA: RuntimeMetadata = {
  runtimeId: 'test-runtime',
  pid: 0,
  authToken: 'test-token',
  startedAt: 0,
  transports: [{ kind: 'unix', endpoint: '/tmp/orca-test.sock' }]
}

vi.mock('./runtime/metadata', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof MetadataModule
  return {
    ...actual,
    tryReadMetadata: () => FAKE_METADATA,
    getDefaultUserDataPath: () => '/tmp/orca-test-userdata'
  }
})

type SenderCall = {
  endpoint: string
  body: { method: string; params: unknown }
}

describe('resolveFeatureGroup', () => {
  it('maps representative commands to their declared groups', () => {
    // One per group — protects the design-doc grouping table from drift.
    expect(resolveFeatureGroup(['snapshot'])).toBe('browser_observation')
    expect(resolveFeatureGroup(['click'])).toBe('browser_interaction')
    expect(resolveFeatureGroup(['goto'])).toBe('browser_navigation')
    expect(resolveFeatureGroup(['cookie', 'set'])).toBe('browser_config')
    expect(resolveFeatureGroup(['terminal', 'create'])).toBe('terminal_orchestration')
    expect(resolveFeatureGroup(['terminal', 'send'])).toBe('terminal_io')
    expect(resolveFeatureGroup(['worktree', 'create'])).toBe('worktree_orchestration')
    expect(resolveFeatureGroup(['orchestration', 'run'])).toBe('orchestration_coordinator')
    expect(resolveFeatureGroup(['orchestration', 'check'])).toBe('orchestration_messaging')
    expect(resolveFeatureGroup(['status'])).toBe('discovery')
  })

  it('returns null for unmapped commands (soft no-op)', () => {
    expect(resolveFeatureGroup(['definitely-not-a-real-command'])).toBeNull()
    expect(resolveFeatureGroup([])).toBeNull()
  })
})

describe('recordCliFeatureUsed', () => {
  let senderCalls: SenderCall[]

  beforeEach(() => {
    _resetEmittedGroupsForTests()
    senderCalls = []
    _setTelemetrySenderForTests(async (_metadata, endpoint, body) => {
      senderCalls.push({ endpoint, body })
    })
  })

  afterEach(() => {
    _setTelemetrySenderForTests(null)
    _resetEmittedGroupsForTests()
  })

  // Drains microtasks so the fire-and-forget `void send(...).catch(...)`
  // resolves before assertions. `recordCliFeatureUsed` deliberately does
  // not return a Promise so dispatch never blocks on telemetry.
  async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  it('emits exactly one event for the first call in a group', async () => {
    recordCliFeatureUsed(['snapshot'], 'success')
    await flush()
    expect(senderCalls).toHaveLength(1)
    expect(senderCalls[0].body.method).toBe('telemetry.captureCliEvent')
    expect(senderCalls[0].body.params).toEqual({
      name: 'cli_feature_used',
      props: { feature_group: 'browser_observation', exit_status: 'success' }
    })
  })

  // The cap-saving design: a single agent loop that calls `snapshot` 200
  // times must produce exactly one event. If this regresses, the PostHog
  // bill regresses with it.
  it('dedupes subsequent calls in the same group within one process', async () => {
    for (let i = 0; i < 50; i++) {
      recordCliFeatureUsed(['snapshot'], 'success')
    }
    await flush()
    expect(senderCalls).toHaveLength(1)
  })

  // First-write-wins on exit_status: a later failure in the same group
  // does not retransmit. Adopting "any failure flips the bit" would mean
  // buffering and a process-exit flush, which the design explicitly
  // rejected.
  it('first-write-wins on exit_status (later failure does not re-emit)', async () => {
    recordCliFeatureUsed(['snapshot'], 'success')
    recordCliFeatureUsed(['screenshot'], 'failure') // same group: browser_observation
    await flush()
    expect(senderCalls).toHaveLength(1)
    expect(senderCalls[0].body.params).toEqual({
      name: 'cli_feature_used',
      props: { feature_group: 'browser_observation', exit_status: 'success' }
    })
  })

  // Symmetric direction: a flaky first attempt must not be masked by a
  // later success in the same group.
  it('first-write-wins on exit_status (later success does not re-emit)', async () => {
    recordCliFeatureUsed(['snapshot'], 'failure')
    recordCliFeatureUsed(['screenshot'], 'success') // same group: browser_observation
    await flush()
    expect(senderCalls).toHaveLength(1)
    expect(senderCalls[0].body.params).toEqual({
      name: 'cli_feature_used',
      props: { feature_group: 'browser_observation', exit_status: 'failure' }
    })
  })

  it('emits separate events for distinct groups', async () => {
    recordCliFeatureUsed(['snapshot'], 'success')
    recordCliFeatureUsed(['click'], 'success')
    recordCliFeatureUsed(['goto'], 'failure')
    await flush()
    expect(senderCalls).toHaveLength(3)
    const groups = senderCalls.map((c) => {
      const params = c.body.params as { props: { feature_group: string } }
      return params.props.feature_group
    })
    expect(groups.sort()).toEqual([
      'browser_interaction',
      'browser_navigation',
      'browser_observation'
    ])
  })

  it('records exit_status: failure when the first call fails', async () => {
    recordCliFeatureUsed(['snapshot'], 'failure')
    await flush()
    expect(senderCalls).toHaveLength(1)
    expect(senderCalls[0].body.params).toEqual({
      name: 'cli_feature_used',
      props: { feature_group: 'browser_observation', exit_status: 'failure' }
    })
  })

  it('is a no-op for unmapped commands and does not consume the dedupe slot', async () => {
    recordCliFeatureUsed(['unknown-command'], 'success')
    await flush()
    expect(senderCalls).toHaveLength(0)
    expect(_getEmittedGroupsForTests().size).toBe(0)
  })

  // Belt-and-braces: the dedupe set must be consulted BEFORE the send is
  // dispatched. If a sender failure could un-mark the group, retries on a
  // broken socket would amplify into one connect attempt per command —
  // exactly the "telemetry never affects user-visible behavior" violation
  // the design rules out.
  it('does not retry on sender failure', async () => {
    const failingSender = vi.fn().mockRejectedValue(new Error('connection refused'))
    _setTelemetrySenderForTests(failingSender)

    recordCliFeatureUsed(['snapshot'], 'success')
    recordCliFeatureUsed(['snapshot'], 'success')
    recordCliFeatureUsed(['screenshot'], 'success')
    await flush()
    expect(failingSender).toHaveBeenCalledTimes(1)
  })

  // The function returns synchronously (`void`) — the design forbids
  // dispatch from awaiting telemetry so a stuck socket can never delay
  // the user-visible command.
  it('returns synchronously without awaiting the send', () => {
    const result = recordCliFeatureUsed(['snapshot'], 'success')
    expect(result).toBeUndefined()
  })
})

// Guards the hand-maintained COMMAND_TO_FEATURE_GROUP map against drift
// from dispatch.ts's handler registration — a new CLI command added to
// any handler group without a corresponding entry would silently emit no
// telemetry, starving the adoption signal.
describe('COMMAND_TO_FEATURE_GROUP completeness', () => {
  it('every dispatch handler key resolves to a feature group', () => {
    const groups = [
      CORE_HANDLERS,
      REPO_HANDLERS,
      WORKTREE_HANDLERS,
      TERMINAL_HANDLERS,
      BROWSER_NAV_HANDLERS,
      BROWSER_INTERACT_HANDLERS,
      BROWSER_TAB_HANDLERS,
      BROWSER_PROFILE_HANDLERS,
      BROWSER_COOKIE_HANDLERS,
      BROWSER_CAPTURE_HANDLERS,
      BROWSER_ENV_HANDLERS,
      BROWSER_STORAGE_HANDLERS,
      ORCHESTRATION_HANDLERS
    ]
    const unmapped: string[] = []
    for (const group of groups) {
      for (const key of Object.keys(group)) {
        if (resolveFeatureGroup(key.split(' ')) === null) {
          unmapped.push(key)
        }
      }
    }
    expect(unmapped).toEqual([])
  })
})
