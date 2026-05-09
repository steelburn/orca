# Agent status over SSH

Status: draft RFC
Owner: brennanb2025
Related code: `src/main/agent-hooks/server.ts`, `src/main/ipc/pty.ts`, `src/main/{claude,codex,gemini,cursor,opencode,pi}/`, `src/relay/`, `src/main/ssh/ssh-channel-multiplexer.ts`, `src/main/providers/ssh-pty-provider.ts`

## 1. Problem statement

Today Orca's per-pane agent status (`working` / `blocked` / `waiting` / `done`, plus payload flags such as `interrupted` and `attention` previews) is reported by the agent CLI itself, via in-shell hook scripts (Claude/Codex/Gemini/Cursor) or in-process plugins (OpenCode/Pi) that POST a JSON payload to a loopback HTTP server inside Orca's main process. The server is created in `src/main/agent-hooks/server.ts` (`AgentHookServer.start`, line 1227); it binds `127.0.0.1:0` and exposes `/hook/<cli>` paths, gated by an `X-Orca-Agent-Hook-Token` bearer header. The coordinates (`PORT`, `TOKEN`, `ENV`, `VERSION`) plus a per-Orca-instance endpoint file path (`ENDPOINT`) are injected into every PTY's environment in `src/main/ipc/pty.ts` (`buildPtyHostEnv`, line 172, calling `agentHookServer.buildPtyEnv()`, line 200) along with the renderer-supplied `ORCA_PANE_KEY`, `ORCA_TAB_ID`, and `ORCA_WORKTREE_ID`. The hook scripts (e.g. `getManagedScript()` in `src/main/claude/hook-service.ts:85`) and plugins (e.g. `getOpenCodePluginSource()` in `src/main/opencode/hook-service.ts:54`) curl/`fetch()` the loopback URL at every event.

This entire pipeline is gated off for SSH. `src/main/ipc/pty.ts:792` sets `isDaemonHostSpawn = !args.connectionId && !(provider instanceof LocalPtyProvider)` — a remote spawn (`args.connectionId` truthy) skips `buildPtyHostEnv` entirely. The justification documented at `pty.ts:785-790` is that the loopback URL and the local userData paths are meaningless on the remote box. The result is the concrete failure mode this RFC fixes: an SSH-hosted Claude/Codex/Gemini/Cursor/OpenCode/Pi pane never produces an `agent_status` IPC event. Sidekick rows render `idle`, dock badges never light, the attention dot never appears, the dashboard's per-agent activity log is empty. The user has to read the terminal output to know whether the agent is thinking, blocked, or done — which defeats the purpose of the dashboard for the SSH workflow.

### Current vs desired

```
                   ┌──────────────── LOCAL (working today) ────────────────┐
                   │                                                       │
  Orca main proc ──┤  agentHookServer  ◄── POST /hook/claude ── claude.sh ─┤
  (Mac/Lin/Win)    │   127.0.0.1:NNNN                          (in PTY env)│
                   └───────────────────────────────────────────────────────┘

                   ┌──────────────── SSH (broken today) ───────────────────┐
                   │                                                       │
  Orca main proc   │              ╳ no path ╳                              │
                   │                                                  remote host
  Mux ◄─JSON-RPC──►│  relay.js ── PTY ── claude (env stripped of OOK_*) ── claude.sh
                   │   stdin/stdout                                ─POST /hook/claude→ ?
                   │                                                127.0.0.1:NNNN (remote box)
                   └───────────────────────────────────────────────────────┘

                   ┌──────────────── SSH (this RFC) ───────────────────────┐
                   │                                                       │
  Orca main proc ──│ AgentHookServer.onAgentStatus ──┐                     │
                   │                                 ▼                     │
  Mux ◄─JSON-RPC── relay-bridge:                                    remote host
   (existing       │  - notify "agent.hook" {source,paneKey,...}    relay.js
    SSH channel)   │  - sent by AgentHookSocketBridge inside relay  ◄── unix socket
                   │                                                ◄── POST /hook/claude
                   │                                              127.0.0.1:MMMM  (relay-local)
                   │                                                   ▲
                   │                                                claude.sh in PTY env
                   └───────────────────────────────────────────────────────┘
```

The listener implementation (request parsing, payload normalization, endpoint-file writing, validation) is shared between Orca's main process and the remote relay via a new `src/shared/agent-hook-listener.ts` module; only the transport adapters differ. **The relay normalizes; Orca routes.** Each parsed payload runs through `normalizeHookPayload` exactly once — on the relay — and crosses the wire as a finished `AgentHookEventPayload` envelope. Orca's `ingestRemote` skips re-normalization and feeds the envelope's payload straight into the same `onAgentStatus` fanout the local HTTP path uses.

## 2. Decision: how do hook events get back to Orca?

We add a tiny loopback HTTP server to the relay process (call it the *relay hook bridge*), preserve the existing /hook/`<cli>` API on the remote, and forward every received hook event to Orca as a `agent.hook` JSON-RPC notification on the existing `SshChannelMultiplexer`. Orca's `SshRelaySession` subscribes to the notification and dispatches to `agentHookServer` exactly as if the POST had arrived locally.

This is option (b) and (c) merged: the relay hosts the listener (so the agent CLI's hook script does not need to know about Orca's transport), but the wire format Orca consumes is the relay JSON-RPC channel rather than a tunneled HTTP request. Below is the comparison the decision was drawn from.

### Options considered

#### a. Reverse SSH tunnel (`ssh -R PORT:127.0.0.1:LOCAL`) carrying the existing `/hook/<cli>` HTTP traffic

The OpenSSH client opens a remote-listener socket on the relay host that forwards to Orca's existing loopback hook server. We rewrite `ORCA_AGENT_HOOK_PORT` in remote-PTY env to point at the tunneled listen port; the existing hook scripts then POST to `127.0.0.1:<remote-port>` and the bytes pop out of `127.0.0.1:<local-port>` on the user's machine.

- **Pros:** zero code on the agent-CLI side. The receiver in `src/main/agent-hooks/server.ts` already accepts the same payload byte-for-byte. Reuses kernel transport.
- **Cons (load-bearing):**
  1. Orca's SSH stack is built on `ssh2` (`src/main/ssh/ssh-connection.ts`), driven entirely from Node, not via the OpenSSH binary. To get a reverse tunnel we'd have to add `forwardIn`/`accept` plumbing across `SshConnection` and ferry chunked HTTP through `ssh2` Channels — not a small change, and orthogonal to the existing JSON-RPC mux.
  2. **Port collisions on shared relay hosts.** A reverse tunnel listens on the *remote*. Two Orca users on the same dev box collide if both try to bind the same port; binding `0` and discovering the assigned port (via `tcpip-forward` reply) is supported by ssh2 but the back-channel still has to thread the chosen port back into the per-PTY env at spawn time.
  3. **Token reuse across Orca instances.** A single tunnel terminates at one Orca; if a relay is shared (multi-tenant box, jumphost) we'd be giving every PTY on that box the bearer token of whichever Orca opened the tunnel first.
  4. **NAT / restrictive sshd configs.** Many shared dev boxes set `AllowTcpForwarding no` or `GatewayPorts no`; the remote-bind path silently fails on those hosts and there is no in-band fallback.
  5. **Mid-session SSH drop.** A tunnel is bound to one TCP connection. On reconnect (which the existing relay deliberately survives via the unix-socket reattach in `src/relay/relay.ts:213-300`), the tunnel is gone for the duration of the disconnect; the remote port's in-flight POSTs fail. We would need to track and reopen the tunnel on every reconnect and re-rewrite the env in every PTY — env in a running PTY cannot be rewritten.

#### b. Multiplex hook events as JSON-RPC notifications back over the existing relay control channel

The relay receives the hook payload (over a remote unix socket — see option c for *how*), normalizes the `source` (`claude`/`codex`/...) and the body, and emits a `agent.hook` notification on `RelayDispatcher.notify` (`src/relay/dispatcher.ts:92`). Orca's `SshChannelMultiplexer.onNotification` (`src/main/ssh/ssh-channel-multiplexer.ts:78`) routes it to a new handler that calls `agentHookServer.ingestRemote(...)` (a new method that bypasses the HTTP path and feeds the parsed payload straight into the existing listener pipeline).

- **Pros:** rides the same TCP/JSON-RPC channel that already survives SSH drop and reconnect (`relay.ts` `--connect`). One transport, one set of failure modes, one set of timeouts. No new sockets to open through the user's sshd. Token is local to the relay (never crosses the wire); the SSH channel itself is the trusted boundary.
- **Cons:** payload version mismatch is now a within-protocol concern — covered by the existing `version` field on the hook payload (warned-once in `server.ts:1110-1122`). We need a small shim in the relay so it talks to the agent CLIs (which speak HTTP), not just to Orca.

#### c. Have the remote relay process receive hook POSTs on a unix domain socket and forward via the existing relay <-> Orca connection

Same shape as (b) but the local-loopback HTTP receiver on the remote is replaced with a unix domain socket plus a curl-style `--unix-socket /path/to/sock` invocation in the hook script. Avoids opening any TCP socket on the remote at all.

- **Pros:** strongest tenancy story — file mode `0600` makes the socket unreadable by other users on the relay host (we already use `0o177` umask for this exact reason in `src/relay/relay.ts:289` for the reconnect socket).
- **Cons:** `curl --unix-socket` is universal on modern macOS/Linux but we are now hard-coded to curl (the POSIX hook script uses curl already, so this is fine). PowerShell on a *Windows* remote does not have a built-in equivalent — if/when we ship Windows-remote support we'd need a TCP fallback.

#### Decision

**(b) + (c) — relay-hosted loopback HTTP server, JSON-RPC notification to Orca.** Rationale, with the why:

- The relay hosts the listener as **plain loopback HTTP on `127.0.0.1:0`** (same shape as `agentHookServer` does today). **Why not unix-socket only:** the existing hook scripts on remote *POSIX* hosts already use curl which supports `--unix-socket`, but the OpenCode/Pi plugins use Node `fetch()` which has no equivalent in Node 18 stable. Keeping HTTP loopback gives us a uniform endpoint shape across all six agents with no per-CLI fork. The relay process is the only listener on the remote, so there is no port-collision concern with other Orca users on the same box (each user gets their own relay process bound to its own ephemeral port).
- The relay forwards each parsed payload to Orca via `RelayDispatcher.notify('agent.hook', {...})`. **Why a notification, not a request:** hook delivery must be best-effort and fire-and-forget — the agent CLI cannot block on Orca's reply, and the existing local server returns 204 unconditionally (`server.ts:1293-1300`). Notifications already drop silently when the channel is mid-reconnect, matching the documented "fail-open" hook semantics.
- The HTTP token is **per-relay-process and never crosses the wire**: it is generated by the relay at boot, written to `endpoint.env` on the relay host, sourced by the hook script, and matched against the bearer header inside the relay. Orca never sees it. **Why:** the SSH channel itself is the trust boundary between Orca and the relay. The HTTP token only protects against *other local users on the relay box* posting fake hooks (which is the same threat model `agentHookServer.start()` defends against locally). There is no value in tunneling the token to Orca, and shipping it in `pty.spawn.env` would mean a single Orca leak (e.g. an `env` IPC log) exposes credentials to the remote attacker.
- **NAT:** none. We never open a remote-listening port on the user's sshd. Everything is loopback on the relay box plus the existing forward SSH channel.
- **Port collisions:** relay binds `127.0.0.1:0` per process. Two Orca users on the same relay host get distinct relay processes (the `relay.sock` path is namespaced under the relay's working dir already — `src/relay/relay.ts:58`) and distinct ports.
- **Token scoping per connection:** one Orca ↔ one relay ↔ one hook server. `AgentHookServer` already has a `setListener` registry (`server.ts:1211`); we add a `connectionId` field to the IPC contract and `AgentHookEventPayload` (commit #1, §8). The wire payload carries `connectionId: null` (the relay does not know it); Orca's `ingestRemote` stamps the real value from `mux` identity on receive, so a single Orca can demultiplex events from N concurrent SSH connections and the renderer can drop in-flight events for connections that have torn down.
- **Replay / version mismatch:** the existing payload carries a `version` and `env` field validated in `normalizeHookPayload` (`server.ts:1110-1140`); we forward both untouched through the JSON-RPC notification. The warn-once Sets dedupe noise across stale hook scripts.
- **SSH drop mid-session:** `RelayDispatcher.notify` on a half-closed channel writes into a dead `process.stdout` and is silently dropped (`relay.ts:144-150` with `stdoutAlive`). When `--connect` reattaches, `setWrite` redirects future notifications to the new socket (`dispatcher.ts:56`). Hooks fired during the gap cannot reach Orca live, but the relay's hook server keeps a `lastStatusByPaneKey`-style cache (one bounded entry per `paneKey`, mirroring `server.ts:1218-1224`) and replays cached payloads on demand: after Orca re-wires the `agent.hook` notification handler on the new mux, it issues an `agent_hook.requestReplay` request and the relay re-emits each cached entry as a fresh `agent.hook` notification (see §5 Path 3 for the race rationale that ruled out push-on-`setWrite`). This is not a per-event redelivery guarantee — it is a "last known state per pane survives reconnect" guarantee, which is exactly what the renderer cares about (it only renders current state). The fire-and-forget contract the agent CLI sees is unchanged.

## 3. Concrete env wiring for remote PTYs

Today `agentHookServer.buildPtyEnv()` returns five vars (`server.ts:1375-1396`) and `buildPtyHostEnv` injects them only on local spawns. We change that policy:

- **`ORCA_PANE_KEY`, `ORCA_TAB_ID`, `ORCA_WORKTREE_ID`** — already arrive in `args.env` from the renderer (set in the renderer at PTY-spawn time, see the `ORCA_PANE_KEY` assignment in `src/renderer/src/components/terminal-pane/pty-connection.ts`; consumed inside the IPC handler at `src/main/ipc/pty.ts:998` and `:1057`). These are connection-agnostic and survive verbatim into the SSH PTY env. **Survives.** Note that `ORCA_PANE_KEY` alone is *not* sufficient to route an event back to its origin connection: two SSH connections to *different* hosts can produce events that share a `paneKey`-shaped string if a tab is destroyed and recreated during a reconnect. The wire payload therefore also carries `connectionId`, but the relay does not (and cannot) know it — a `connectionId` is Orca's local handle on an `ssh2` connection, not a wire identity. The relay sends `connectionId: null`; Orca's `ingestRemote` stamps it on receive based on which `SshChannelMultiplexer` the notification arrived on. The renderer uses the stamped value for stale-event filtering — see §5.
- **`ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_HOOK_ENV`, `ORCA_AGENT_HOOK_VERSION`, `ORCA_AGENT_HOOK_ENDPOINT`** — must point at the *relay's* hook server, not Orca's. We introduce a parallel `RelayAgentHookServer.buildPtyEnv()` running inside the relay process. The relay-side server is described in §4. **Replaced** (different values, same names, same semantics).

The new spawn path: when `args.connectionId` is set, Orca:

1. Calls `provider.spawn` with `args.env` augmented only by the renderer-set `ORCA_*` pane attribution vars. The five `ORCA_AGENT_HOOK_*` vars are *not* set client-side.
2. The relay's `pty.spawn` handler in `src/relay/pty-handler.ts:162-213` adds the relay-local hook env to the PTY env *before* `pty.spawn(shell, ...)`. **Why server-side injection rather than threading the values back to Orca and into `args.env`:** the relay knows its own port and token; making Orca a man-in-the-middle would force a synchronous round-trip (or push-then-pull) on every PTY spawn and would leak the relay's bearer token over the SSH wire for no functional benefit. Per AGENTS.md, document the WHY but keep code-paths minimal — server-side injection is the simplest correct shape.
3. The endpoint script the hook script sources is `endpoint.env` written to the relay's working dir (mirrors `server.ts:writeEndpointFile`, `server.ts:1411-1527`). On Orca-restart-while-relay-grace-window-active, the relay process is the same one — the endpoint file does not move, so existing PTYs re-read the live coordinates.

Posix endpoint script (rendered by relay-side hook server, `KEY=VALUE` per line — same shape as `server.ts:1442-1451`):

```sh
ORCA_AGENT_HOOK_PORT=58231
ORCA_AGENT_HOOK_TOKEN=8c1f91d4-...-relay-only
ORCA_AGENT_HOOK_ENV=production
ORCA_AGENT_HOOK_VERSION=1
```

Token, port, env, version are validated against `isShellSafeEndpointValue` on the relay before write. The validator, plus the rest of the listener internals (`parseFormEncodedBody`, `readRequestBody`, `normalizeHookPayload`, `writeEndpointFile`, `getEndpointFileName`, the warn-once Sets, the slowloris timer helper, and the request size cap), is extracted into a new `src/shared/agent-hook-listener.ts` module that both `src/main/agent-hooks/server.ts` and `src/relay/agent-hook-server.ts` import. The shared module uses only Node builtins (`http`, `fs`, `crypto`, `net`, `path`, `url`, `os`) — none of which drag in Electron — so it is safe to import from the relay (cf. the `electron`-free constraint at `src/relay/protocol.ts:1`). The relay's hook server is a thin transport adapter: it owns the HTTP listening socket, delegates request handling to the shared listener, and on each parsed payload calls `dispatcher.notify('agent.hook', payload)` instead of doing the in-process IPC fanout that Orca's main-side adapter performs. The relay writes the endpoint file with `0600` and the dir with `0700`, using the same shared writer.

**Windows-remote case (deferred):** Windows-remote is rare and out of scope for the first cut. Document explicitly: when a Windows host appears as a relay target, `getEndpointFileName()` would need the `endpoint.cmd` variant and the hook script's `set ` prefix — copy `server.ts:1170` and `server.ts:1422` into `src/relay/agent-hook-server.ts` once we ship Windows-remote relay binaries. Until then, the SSH PTY provider must reject Windows-remote hosts for hook installation (a `getCapabilities` RPC suffices).

## 4. Per-CLI changes

The transport rewrite is the only required change. Hook scripts and in-process plugins are *unchanged*. Each agent already reads `ORCA_AGENT_HOOK_PORT/TOKEN/ENDPOINT` from process env or sources `ORCA_AGENT_HOOK_ENDPOINT` to refresh after a restart — and inside an SSH PTY, those vars now point at the relay's loopback. Concretely:

- **Claude / Codex / Gemini / Cursor** — POSIX hook scripts in `src/main/claude/hook-service.ts:85`, `codex/hook-service.ts:79` (analogous), `gemini/hook-service.ts`, `cursor/hook-service.ts`. They `curl` `127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/<cli>`. With relay-side env injection, that resolves to the relay's loopback. **No change.** The hook script is installed in `~/.claude/settings.json` (or equivalent) on the *remote*; that's a separate one-time install flow (outside this RFC's scope).
- **OpenCode** — in-process plugin at `src/main/opencode/hook-service.ts:54-332`. It uses Node `fetch()` against `127.0.0.1:${coords.port}/hook/opencode`. **No change.** The existing endpoint-file cache (`server.ts` plugin source, lines ~76-131 of `hook-service.ts`) already handles the "Orca restart" case — the same code path handles "relay restart" because the endpoint file is now relay-local.
- **Pi** — in-process extension at `src/main/pi/agent-status-extension-source.ts`. Same fetch shape as OpenCode. **No change.**

The Orca-side `OpenCodeHookService.buildPtyEnv` (`hook-service.ts:362`) and `PiTitlebarExtensionService.buildPtyEnv` materialize a local userData overlay directory and inject `OPENCODE_CONFIG_DIR` / `PI_CODING_AGENT_DIR` paths into the PTY env. These overlay dirs hold the bundled plugin/extension *source* files (`getOpenCodePluginSource()`, `getPiAgentStatusExtensionSource()`). **They cannot be paths on the local filesystem when the PTY runs on a remote host** — that's exactly the failure mode the current SSH guard at `pty.ts:792` was avoiding.

The relay must therefore:

1. Receive the plugin/extension source over JSON-RPC at relay boot (one `agent_hook.installPlugins` request issued by `SshRelaySession.registerRelayRoots` analogue, payload includes `{opencodePluginSource, piExtensionSource, version}`).
2. Materialize per-PTY overlay dirs on the *relay's* userData-equivalent (e.g. `$HOME/.orca-relay/agent-hooks/` — under `RELAY_REMOTE_DIR` already used in `ssh-relay-deploy.ts:92`).
3. Inject `OPENCODE_CONFIG_DIR=...` / `PI_CODING_AGENT_DIR=...` into `pty.spawn`'s env on the relay side, pointing at those remote overlay dirs.

**Why ship the plugin source over the wire instead of bundling it into the relay binary:** the relay is versioned independently from Orca (`RELAY_VERSION` in `src/relay/protocol.ts:4` vs. the bundled hook-service.ts strings, which change as we add agent events). Pinning the plugin source to the relay version would force a relay redeploy every time we touch a hook event mapping — and we touch those frequently (the recent `cursor` and `pi` additions are examples). Shipping at session-init keeps the source aligned with the running Orca's expectations.

## 5. Failure modes & mitigations (4-paths analysis)

```
Path 1: HAPPY                                                    │
  Agent CLI fires hook → curl 127.0.0.1:PORT/hook/claude         │
  → relay hook server validates token → builds envelope          │
    {connectionId: null, paneKey, source, payload, ...}          │
  → RelayDispatcher.notify('agent.hook', envelope)               │
  → SshChannelMultiplexer flat-array notification handler in     │
    main: `mux.onNotification((method, params) => { if (method   │
    === 'agent.hook') agentHookServer.ingestRemote(params,       │
    this.targetId) })` — the Orca-side mux stores handlers in a  │
    flat array (no method-keyed routing); each handler filters   │
    by method name itself                                        │
  → existing onAgentStatus listener (no re-normalization;        │
    payload was already normalized on the relay) → IPC →         │
    renderer store.                                              │
  Outcome: identical behavior to local.                          │
                                                                 │
Path 2: HOOK SERVER (RELAY-SIDE) DOWN                            │
  Relay process crashed but PTY survived (no path today, but     │
  defense-in-depth): curl POST gets ECONNREFUSED on loopback.    │
  Hook script's `>/dev/null 2>&1 || true` (claude/hook-service.ts│
  line 122) swallows it — fail-open. Renderer keeps last known   │
  state until next event.                                        │
                                                                 │
Path 3: SSH DROPPED MID-EVENT                                    │
  Hook script POSTs successfully to relay loopback (no SSH       │
  involved). Relay tries notify('agent.hook', ...). Dispatcher's │
  write callback is a no-op when stdoutAlive is false (relay.ts: │
  144-150). The notification cannot land on Orca during the gap. │
  Mitigation: the relay's hook server caches the *last* payload  │
  per `paneKey` (mirroring `lastStatusByPaneKey` at server.ts:   │
  1218-1224). Replay is request-driven: after `--connect` reat-  │
  taches and `SshRelaySession.registerProviders` re-wires the    │
  `agent.hook` notification handler on the new mux, Orca issues  │
  `agent_hook.requestReplay`; the relay walks the cache and re-  │
  emits each entry as a fresh `agent.hook` notification. The     │
  push-on-setWrite alternative would race the handler-wiring on  │
  the new mux (notificationHandlers is empty until registerPro-  │
  viders runs) and silently drop replays. Bounded to one entry   │
  per paneKey so cache size is O(panes), not O(events). The      │
  agent's next hook on the same pane overwrites the cache; the   │
  PTY's onExit handler (relay-side `pty-handler.ts:onExit`) calls│
  `hookServer.clearPaneState(paneKey)` so a terminated pane's    │
  last status never replays as a ghost event on a later          │
  reconnect — symmetric with the local server's clearPaneState   │
  on PTY teardown. This converts a lost `Stop` between drop and  │
  reconnect from a "stuck working" UX bug into a one-RTT delay   │
  on reattach.                                                   │
                                                                 │
Path 4: PAYLOAD VERSION MISMATCH                                 │
  Older hook script (installed by a previous Orca build) POSTs   │
  with version=0 against a relay running version=1 server.       │
  Relay forwards verbatim; Orca's existing                       │
  normalizeHookPayload() warns-once and accepts. Same as the     │
  local cross-build path documented at server.ts:1110-1122.      │
```

Additional, narrower failure modes worth calling out:

- **Multiple SSH connections simultaneously** — N relay processes, N relay-local hook servers, N JSON-RPC channels. The wire `agent.hook` notification carries `connectionId: null`; Orca stamps the real `connectionId` on receive from `mux` identity inside `agentHookServer.ingestRemote(envelope, connectionId)`. `ingestRemote` then uses the existing `paneKey`-keyed dispatch; collision across connections is impossible *for live state* because the renderer's `paneKey` is `${tabId}:${paneId}` and the renderer assigns `tabId` globally per-Orca.
- **Renderer-side stale-event filtering** — the `agentStatus:set` IPC payload carries the stamped `connectionId` end-to-end (set in commit #1, see §8). When a connection tears down, in-flight notifications can still arrive at the renderer for one tick; the renderer ignores any event whose `connectionId` no longer matches a live SSH connection. **Why this matters even with `paneKey` scoping:** if a tab is destroyed and recreated mid-reconnect, the new `paneKey` may collide with a notification still in flight from the old connection. `connectionId` is the only field that distinguishes "this is for the connection that currently owns this pane" from "this is from a connection that just died".
- **Orca restart with relay surviving** — the relay is in grace-window mode (`--connect` socket waiting); the new Orca's `SshConnection` reattaches, replays the `mux.onNotification` handlers, and re-installs the `agent.hook` route. A hook fired during the gap is dropped (Path 3); a hook fired *after* reattach but *before* the renderer hydrates is buffered by `agentHookServer.lastStatusByPaneKey` (`server.ts:65`) and replayed on `setListener` (`server.ts:1217-1224`). Unchanged.

## 6. Cross-platform

- **Local Orca side (the receiving end):** macOS / Linux / Windows. The new code paths in `src/main/agent-hooks/server.ts` and `src/main/ssh/ssh-relay-session.ts` are pure Node — no platform branches needed beyond what already exists.
- **Remote (relay) side:** **POSIX-first.** Linux x64/arm64 + macOS x64/arm64 are the supported relay platforms (see `RelayPlatform` parsing in `src/main/ssh/ssh-relay-deploy.ts:120-127`). Windows-remote is out of scope for v1; documented above (§3) and gated by the relay-platform detection.

## 7. Security model

- **Trust boundary 1 — Orca ↔ relay:** the SSH channel itself, authenticated by the user's SSH key. No additional secret on this hop. Orca trusts the relay; the relay trusts Orca. **Why:** the existing relay protocol (`src/main/ssh/relay-protocol.ts`) already runs every PTY/FS/git operation through this same trust assumption. Reusing it for hook events is consistent.
- **Trust boundary 2 — relay ↔ agent CLI inside a PTY:** the relay's hook-server bearer token, transported through the endpoint file at `0600` permissions and the dir at `0700`. The hook script reads it from PTY env (or sources `endpoint.env`). **Why bearer token at all on a single-user remote:** dev-host policy varies — many shared dev boxes have multiple users in the same group. Without the token a coworker could `curl 127.0.0.1:PORT/hook/claude` and inject fake `working`/`done` events into the user's Orca dashboard. The cost is one UUID; the benefit is a real isolation boundary.
- **Token scope:** per-relay-process. New relay process → new UUID → new endpoint file. If the relay restarts, the old token is dead and any stale shell on the relay that captured it can no longer post. Same lifecycle as Orca's local server.
- **Stale endpoint file on a relay can't be used by another user:** the file is `0600` and the parent dir is `0700`, owned by the user who started the relay. Other local users on the relay box cannot read the token. **Why this matters more on a relay than locally:** on a developer laptop only one user is logged in; on a shared dev VM there are several. The `chmodSync(this.endpointDir, 0o700)` guard on the endpoint dir in `server.ts` (around `:1468`) exists for exactly this reason and must be copied verbatim to the relay-side implementation (it lives in the shared listener module so both consumers inherit it).
- **Replay attack:** the token is stable across the relay's lifetime; an attacker who exfiltrated it (e.g. by reading the endpoint file of a sibling shell on the relay before file permissions are applied — there is no such window because the file is written with `mode: 0o600` in the same `writeFileSync` call that creates it, see `server.ts:1505`, and the parent dir is locked down by the `chmodSync(this.endpointDir, 0o700)` call in `server.ts` mirrored verbatim in the relay) could post arbitrary `paneKey`s. Mitigation: `paneKey` is bounded to 200 chars (`server.ts:1097`) and the renderer ignores `paneKey`s for tabs it does not own. We do not consider arbitrary state-flipping a critical vuln (the user can already see the real terminal output). Same posture as local.
- **TOCTOU on endpoint file:** documented in `server.ts:1342-1349`; intentionally do *not* delete on shutdown. Copy the same comment onto the relay-side stop path.

## 8. Implementation plan (ordered, each commit independently mergeable)

Each commit ships its own tests and is small enough to revert without unwinding subsequent work. Files listed are the load-bearing edits — supporting test files are implied.

**Order & rollout.** Commits #1-7 land *dark* behind a runtime feature flag `ORCA_FEATURE_REMOTE_AGENT_HOOKS` (off by default). **Flag mechanism:** an env var read once at process start — `process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS` checked at `agentHookServer.start()` and at `SshRelaySession` construction; absent or empty (or `"0"`) = off, anything else = on. **Why env var, not settings:** rollout is per-developer-machine and per-build, not per-user-preference; an env var lets us flip it via launchd/systemd unit overrides or `pnpm dev` shell exports without shipping a settings migration, and it cannot be tampered with from the renderer process. **Gate locations:** (a) SSH PTY env injection in `src/main/ipc/pty.ts` (commit #6) — when off, the SSH spawn path actively strips `ORCA_PANE_KEY/TAB_ID/WORKTREE_ID` from `args.env` before forwarding to the relay; today these vars already cross unused (the renderer at `src/renderer/src/components/terminal-pane/pty-connection.ts:285-290` unconditionally sets them for all spawns including SSH, and `src/main/providers/ssh-pty-provider.ts:104` forwards `args.env` verbatim), so flag OFF is functionally equivalent to current behavior — code that begins consuming them on the remote (i.e., the relay-side hook server) starts seeing nothing. (b) the IPC publisher path on the renderer-bound side that delivers stamped `agent.hook` events (commit #5) — when off, `ingestRemote` is a no-op. The relay-side hook server (commits #2-4) is **always enabled** — it is harmless if no PTY env points hooks at it (no env, no curl), and shipping it dark gives us telemetry on real connections before flipping the flag. Commit #8 is the first user-visible enabling commit because four of six agents (Claude / Codex / Gemini / Cursor) require the remote `settings.json` installer to fire any hooks at all; without #8, only OpenCode and Pi (the in-process plugins) light up. The flag default flips in #8 or a fast follow, conditioned on per-host install state. **Why:** without the flag and without resequencing, an early build would ship "agent status over SSH" that visibly works for two of six agents and silently does nothing for the four most common ones — a feature-flag-shaped feature in everything but name.

1. **shared types: `src/shared/agent-hook-relay.ts` (new)** — defines the wire shape for the new `agent.hook` JSON-RPC notification: `{source, paneKey, tabId?, worktreeId?, connectionId, env, version, payload}`. The wire `connectionId` is **always `null`** — neither the local hook server nor the relay knows Orca's `connectionId` (it is Orca's local handle on an `ssh2` connection, not a wire identity). The renderer-facing IPC shape (`agentStatus:set` in `src/main/index.ts`) carries a `connectionId: string | null` that Orca stamps on receive: the local HTTP path stamps `null`; the relay path stamps it from `mux` identity inside `agentHookServer.ingestRemote(envelope, connectionId)` based on which `SshChannelMultiplexer` the notification arrived on. The renderer uses the stamped value to drop stale events when a connection tears down with in-flight notifications. Re-export `AgentHookSource` from `server.ts` (currently a local type at `server.ts:42`); promote it to the shared module so the relay can import it without dragging Electron in. **Why a separate module:** AGENTS.md mandates `.ts` over `.d.ts`; the relay deliberately has no Electron dependency (`src/relay/protocol.ts:1` comment), so the type cannot live in `agent-status-types.ts` if it ever picks up an electron-bound import. **Why `connectionId` belongs in commit #1, not later:** `AgentHookEventPayload` and the IPC contract have no such field today; bolting it on after the renderer has shipped without it requires a renderer migration. Doing it up front in the type-definition commit keeps every later commit type-safe by construction. Tests: round-trip JSON encode/decode against existing `parseAgentStatusPayload`; an explicit assertion that the wire `connectionId` is `null` and the IPC `connectionId` is populated only after `ingestRemote` has stamped it.
2. **shared listener extraction + relay hook server: `src/shared/agent-hook-listener.ts` (new) + `src/relay/agent-hook-server.ts` (new)** — extract the listener internals out of `src/main/agent-hooks/server.ts` into a new `src/shared/agent-hook-listener.ts` module: `parseFormEncodedBody`, `readRequestBody`, `normalizeHookPayload`, `isShellSafeEndpointValue`, `writeEndpointFile`, `getEndpointFileName`, the warn-once Sets, the slowloris timer helper, and the size-cap constant. The shared module uses only Node builtins, no Electron. Update `src/main/agent-hooks/server.ts` to import from it (no behavior change locally — pure refactor under existing tests). The relay's `src/relay/agent-hook-server.ts` is a ~60-LoC adapter that wires the shared listener to a relay-owned HTTP socket and a `forward(payload)` callback; it does not duplicate request parsing or endpoint-file writing. Tests: HTTP POST round-trip against the relay adapter; endpoint-file atomic-rename + chmod assertions (covered once at the shared-module level); oversized-body rejection.
3. **relay wiring: `src/relay/relay.ts` (edit)** — instantiate `RelayAgentHookServer` after the existing handlers (`relay.ts:191-202`); hand it a forward callback `(payload) => dispatcher.notify('agent.hook', payload)`. Maintain a per-`paneKey` last-payload cache inside `RelayAgentHookServer` (one bounded entry per paneKey, mirroring `lastStatusByPaneKey` at `server.ts:1218-1224`). Replay is **request-driven, not push-on-`setWrite`**: register an `agent_hook.requestReplay` request handler that walks the cache and forwards each entry as a fresh `agent.hook` notification. The handler emits each cached payload via `dispatcher.notify('agent.hook', ...)` BEFORE returning from the request handler, so the request response trails all replay notifications on the wire (FIFO ordering on the dispatcher's single write callback at `src/relay/dispatcher.ts:199`); Orca therefore cannot observe replay-complete (the response) until every replayed notification has already been written. **Why request-driven:** on `--connect` reconnect, Orca constructs a new `SshChannelMultiplexer` whose `notificationHandlers` array is empty until `SshRelaySession.registerProviders` adds the `agent.hook` filter via `mux.onNotification((method, params) => { if (method === 'agent.hook') agentHookServer.ingestRemote(params, this.targetId) })` (after the async `session.resolveHome` round-trip at `ssh-relay-session.ts:131`). A push-on-`setWrite` flush before that runs would reach no handler that filters for `'agent.hook'` and the replays would be dropped on `mux.handleNotification`. The request-driven shape mirrors `session.registerRoot`: Orca issues `agent_hook.requestReplay` *after* the `agent.hook` handler is wired, and the relay forwards cached payloads only in response. Add cache eviction on PTY exit: `pty-handler.ts`'s `onExit` callback (around `pty-handler.ts:112`) calls `hookServer.clearPaneState(paneKey)` keyed on the `ORCA_PANE_KEY` injected into that PTY's env, so a terminated pane's cached entry never replays as a ghost event on a later reconnect (the local server's `agentHookServer.clearPaneState(paneKey)` on PTY teardown is the symmetric precedent). Add the relay-hook env vars to a fixed augmenter that `pty-handler.ts:spawn` consumes (point 4 below). Add `agent_hook.getPluginSources` request handler that returns `{}` initially (filled in point 7). On `shutdown`, call `hookServer.stop()`. Tests: integration test that boots a relay, opens a fake mux, POSTs `/hook/claude`, asserts the `agent.hook` notification fires with the expected envelope; reconnect test that issues `agent_hook.requestReplay` and asserts cached payloads arrive only after the request and strictly before the response; PTY-exit test that asserts `clearPaneState` is called with the right paneKey and a subsequent `requestReplay` does not resurrect the dead pane.
4. **relay PTY env: `src/relay/pty-handler.ts` (edit)** — extend `PtyHandler.spawn` (line 162) to call a new `getRelayHookEnv()` accessor on the dispatcher's relay context (or threaded through the constructor). Inject the four `ORCA_AGENT_HOOK_*` vars and `ORCA_AGENT_HOOK_ENDPOINT` (path to relay-local `endpoint.env`) into the spawn env after the existing `{ ...process.env, ...env }` merge at `pty-handler.ts:189`. Tests: spawn a PTY in a unit test using a fake `node-pty`, assert env carries the right keys.
5. **Orca multiplexer route: `src/main/ssh/ssh-relay-session.ts` (edit) + `src/main/agent-hooks/server.ts` (edit)** — add `agentHookServer.ingestRemote(envelope, connectionId)` (a sibling to the listener path that bypasses the HTTP route handler). The relay has *already* normalized the payload via the shared listener (see §1 diagram and §3: "the relay normalizes; Orca routes"); `ingestRemote` therefore skips re-normalization and forwards `envelope.payload` directly to the same `onAgentStatus` fanout the HTTP path uses. The `connectionId` arg is supplied by the caller from `mux` identity (the wire envelope carries `connectionId: null` — see commit #1). Wire a flat handler via `mux.onNotification((method, params) => { if (method === 'agent.hook') agentHookServer.ingestRemote(params, this.targetId) })` in `SshRelaySession.startSession` (the current registerRoots path, around `ssh-relay-session.ts:396`); the Orca-side mux's `notificationHandlers` is a flat array (`ssh-channel-multiplexer.ts:42`) with no method-keyed routing, so each handler filters by `method` itself — only the relay-side `RelayDispatcher.onNotification(method, handler)` (`src/relay/dispatcher.ts:75`) is method-keyed. Tests: feed a fake notification through the mux, assert `onAgentStatus` listener fires identically to a local POST.
6. **Orca PTY spawn: `src/main/ipc/pty.ts` (edit)** — drop the SSH guard around `agentHookServer.buildPtyEnv` *only for `ORCA_PANE_KEY`/`ORCA_TAB_ID`/`ORCA_WORKTREE_ID`* (these were already passed via `args.env`, so this is mostly a comment/test change confirming the shape). Do *not* inject the `ORCA_AGENT_HOOK_*` vars on the SSH path — those come from the relay. Add a regression test that asserts no `ORCA_AGENT_HOOK_TOKEN` is present in `args.env` when `connectionId` is set. Tests: unit test of `buildPtyHostEnv` SSH-guard contract.
7. **Plugin source sync: `src/main/ssh/ssh-relay-session.ts` (edit) + relay `agent_hook.installPlugins` handler (edit `relay.ts`)** — at session ready (after `registerRelayRoots` in `ssh-relay-session.ts:396`), call `mux.request('agent_hook.installPlugins', {opencodeSource, piSource, version})`. Relay materializes overlay dirs on disk and the relay's `pty-handler.ts:spawn` injects `OPENCODE_CONFIG_DIR=...` / `PI_CODING_AGENT_DIR=...`. **Why a separate commit from #4:** the four `ORCA_AGENT_HOOK_*` vars cover Claude/Codex/Gemini/Cursor (all four use settings.json hook scripts that we install separately on the remote — the user runs the install flow targeted at the remote machine). OpenCode/Pi need plugin file materialization. Splitting lets the first five commits ship and unlock four agents while plugin sync is reviewed.
8. **Hook installer for remote: `src/main/agent-hooks/installer-utils.ts` (edit) + per-CLI hook services (edit)** — add a `connectionId?` arg to `claudeHookService.install()` etc. When set, write the script to `~/.claude/settings.json` *on the remote* via existing SFTP utilities in `src/main/ssh/sftp-upload.ts`. **Why deferred to last:** the install flow is user-facing (settings UI button must be aware of connection scope) and depends on a stable remote-runtime contract from #1-7. Tests: end-to-end install with a fake SFTP, assertions against the rendered script body.

## 9. Test plan

Unit:
- `src/shared/agent-hook-relay.ts` — type round-trip.
- `src/shared/agent-hook-listener.ts` — POST parsing, endpoint-file atomic write, chmod, version+env warn-once (single suite covering both consumers, replacing the per-side parity tests).
- `src/relay/agent-hook-server.ts` — adapter contract: HTTP socket lifecycle, forward callback fires once per parsed payload.
- `src/relay/pty-handler.ts` — env injection for spawned PTY.
- `src/main/agent-hooks/server.ts` — new `ingestRemote` shape.
- `src/main/ssh/ssh-relay-session.ts` — `agent.hook` notification → `ingestRemote` routing.
- `src/main/ipc/pty.ts` — SSH-guard contract: no `ORCA_AGENT_HOOK_TOKEN` on SSH spawn.

End-to-end smoke (`src/relay/integration.test.ts` or a new `src/main/ssh/agent-status-e2e.test.ts`):
1. Boot a relay subprocess with the test harness (existing `subprocess-test-utils.ts` provides the scaffold).
2. Open a fake `MultiplexerTransport` connected to the subprocess's stdio; instantiate `SshChannelMultiplexer` and a stub `agentHookServer` with a Promise-resolving listener.
3. Issue a `pty.spawn` over the mux; capture the relay's spawn env (using a node-pty mock that records args).
4. Assert the env carries `ORCA_AGENT_HOOK_PORT/TOKEN/ENDPOINT/ENV/VERSION`.
5. Independently, POST `/hook/claude` to the relay's loopback port using the captured token; assert the listener Promise resolves with the parsed `AgentStatusPayload`.
6. Run a real `claude` CLI invocation (gated by env; CI may skip) — issue a `Read` tool call against a fixture file, assert a `working` then `done` payload reaches the listener.

## 10. Open questions and recommended defaults

1. **Should the relay's hook server bind a unix socket *and* TCP loopback?** Recommended default: **TCP loopback only** for v1 (uniform across CLIs and plugins). Revisit if a security review on a multi-tenant relay host requires socket-level chmod isolation; falling back is a one-file change.
2. **Cross-Orca-instance dev/prod cross-talk on a shared relay.** Local code uses `ORCA_AGENT_HOOK_ENV` to detect dev vs. prod hooks landing on the wrong server (`server.ts:1129-1139`). For the relay, two Orca instances on the same machine connecting to the *same* remote relay... do not happen with the current `RelayDispatcher.invalidateClient` semantics — only one client owns the relay at a time. Recommended default: forward `env` verbatim through the JSON-RPC notification so the existing warn-once still fires, no new code. On client takeover (`relay.ts:225` `replaced.destroy()`), the relay process retains its per-`paneKey` cache; entries that no longer match a live tab on the new Orca are dropped by the renderer's per-tab ownership filter (§7), so cross-Orca cache leakage is invisible to the user. Revisit if cross-Orca takeover becomes a supported workflow.
3. **Lost `Stop` on SSH drop** (Path 3 above). Recommended default: **request-driven replay on reconnect, scoped to the last payload per `paneKey`**. The relay maintains an O(panes) cache (one entry per paneKey, overwritten on each new hook for that pane). After `--connect` reattach Orca re-wires the `agent.hook` filter via `mux.onNotification((method, params) => { if (method === 'agent.hook') agentHookServer.ingestRemote(params, this.targetId) })` and *then* issues `agent_hook.requestReplay`; the relay walks the cache and re-emits each entry through `dispatcher.notify('agent.hook', ...)`. The PTY's `onExit` handler (relay side) evicts the entry so terminated panes don't resurface as ghost events. **Why request-driven, not push-on-`setWrite`:** the new `SshChannelMultiplexer` constructed on reconnect has an empty `notificationHandlers` array until `SshRelaySession.registerProviders` adds the `agent.hook`-filtering handler (after an async `session.resolveHome` round-trip). A push-on-reattach flush would write into a mux whose flat handler array still contains nothing that filters for `'agent.hook'`, dropping the replay; a request-driven shape (mirroring `session.registerRoot`) makes the order explicit. This is not an acknowledgement protocol — there is no per-event delivery guarantee, only "the last known state per *live* pane survives reconnect" — so it does not violate the fire-and-forget contract the local server depends on. Wi-Fi roams and laptop sleep make SSH drops common enough that "accept the loss" was undersized.
4. **Hook installer push to remote** (commit #8). Recommended default: **make it explicit, not automatic**. The install flow on the remote modifies `~/.claude/settings.json` and similar — doing this without user opt-in violates the principle that AGENT-CLI configs are the user's. Surface a "Install Orca hooks on this host" button in the connection-detail panel.
5. **OpenCode/Pi plugin source over the wire on every connect.** The two plugin source strings are tens of KB; pushing them on every reconnect is wasteful. Recommended default: hash-compare the plugin source in `agent_hook.installPlugins` (relay returns `{installedHashes}`, Orca skips upload when matching). Out of scope for v1, defer.
6. **Multi-user relay running as a daemon (one relay shared by N users).** Out of scope. The relay's design assumes one user per relay process (its socket and endpoint file are `0600`). If/when we add a system-daemon relay, the per-connection token scoping must be revisited.
