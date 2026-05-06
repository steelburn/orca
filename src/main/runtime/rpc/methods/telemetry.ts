// CLI-side telemetry funnels through this RPC method into main's `track()`.
// The CLI process never talks to PostHog directly — there is one write key,
// one consent gate, one validator, one wire identity (install_id, app_version,
// session_id, …) attached on the main side. This file is the narrow boundary
// where a CLI-originated event becomes a typed `track()` call.
//
// Threat model: the CLI is a separate process and the RPC socket is
// auth-token gated, but we still narrow the incoming `name` to a CLI subset
// (`isCliEventName`). A buggy or compromised CLI must not be able to spoof
// `agent_started` / `telemetry_opted_in` / etc. by posting them through this
// channel — those are main-owned events.
//
// Not in `src/main/ipc/telemetry.ts`: that file is renderer-only (Electron
// `ipcMain.handle()`). The CLI talks to main over the UNIX-socket / named-
// pipe runtime RPC dispatcher, not Electron IPC.

import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { track } from '../../../telemetry/client'
import {
  cliFeatureUsedSchema,
  isCliEventName,
  type CliEventName,
  type EventProps
} from '../../../../shared/telemetry-events'

// Per-CLI-event property narrowing happens via the shared `eventSchemas`
// entries (re-exported here as `cliFeatureUsedSchema`). One shape
// definition; no drift between this boundary check and the central
// validator inside `track()`.
const CaptureCliEventParams = z.object({
  name: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing event name')),
  props: z.unknown()
})

export const TELEMETRY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'telemetry.captureCliEvent',
    params: CaptureCliEventParams,
    handler: (params) => {
      // Narrow `name` to the CLI subset before any further work. A non-CLI
      // event name is silently dropped — the CLI must never learn whether
      // a name was rejected (that would be a side-channel for probing the
      // server's allow-list), and the validator inside `track()` would
      // drop it anyway. Returning `{}` keeps the wire shape consistent
      // with other `defineMethod` handlers.
      if (!isCliEventName(params.name)) {
        return {}
      }
      const name: CliEventName = params.name
      // Per-event prop narrowing. Only `cli_feature_used` exists today.
      // Adding a new CLI event means adding a branch here AND a schema in
      // `eventSchemas`; the type system makes the omission a `tsc` error
      // because `name` is the discriminated `CliEventName` union.
      switch (name) {
        case 'cli_feature_used': {
          const parsed = cliFeatureUsedSchema.safeParse(params.props)
          if (!parsed.success) {
            return {}
          }
          // The cast is the boundary handoff: `track()` re-validates
          // against `eventSchemas.cli_feature_used` (the single source of
          // truth) so this assignment is "I have already checked the
          // shape, hand it to the central validator." Wrapped in
          // try/catch so a stray internal throw never surfaces as an
          // RPC error to the CLI — telemetry must stay best-effort.
          try {
            track(name, parsed.data satisfies EventProps<'cli_feature_used'>)
          } catch {
            /* swallow */
          }
          return {}
        }
        default: {
          // Force a `tsc` error if a new `CliEventName` lands without a
          // matching `case`. Without this, the switch would silently fall
          // through and drop the new event.
          return name satisfies never
        }
      }
    }
  })
]
