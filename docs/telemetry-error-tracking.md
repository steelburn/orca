# Error Tracking — Companion Lane to Product Telemetry

Companion to Orca's product-telemetry design — an enum-only, funnel-shaped PostHog schema that deliberately does not carry raw errors. This doc answers the adjacent question:

**Source of truth:** yes. This doc defines the current diagnostics-lane design that complements product telemetry.

> **When a user hits a bug, what signal do we collect, where does it live, and how does it get back to us without compromising the no-UGC promise?**

**The short version.** Adopt T3 Code's two-lane split. The product-telemetry lane (PostHog) stays exactly as specified — enum-only, no error messages, no paths. Add a second lane specifically for error/debug data that is UGC-tolerant *because it never leaves the user's machine by default*. Users who want to share a failure send it to us explicitly (a diagnostic bundle they can inspect first), or point the app at their own OTLP endpoint (Grafana LGTM, Jaeger, Tempo) and keep the data entirely under their control.

No Sentry. No second cloud vendor. No second PostHog project. One local file + optional OTLP export, modeled directly on `t3code/apps/server/src/observability/Layers/Observability.ts` and `t3code/docs/observability.md`.

**Where this fits in the v1 schema.** The product-telemetry lane ships exactly one error-shaped event: `agent_error { error_class, agent_kind }`, where `error_class` is currently the trimmed enum `'binary_not_found' | 'unknown'`. Everything else that would historically have lived in a product-analytics error event — crash rates, PTY-exit outcomes, stack traces, the full sibling-span context of a failure — lives in the T3-style lane this doc specifies. Three specific architectural shifts follow from that:

- **Crashes are handled entirely by this lane.** The earlier-drafted `app_closed { was_crash }` heartbeat event (emdash's pattern) is out of v1 — it would have been a redundant binary signal alongside the span-level crash record already captured here.
- **Session-level failure tracking is not in product telemetry.** The earlier-drafted `agent_stopped { exit_reason }` event was cut because PTY exit alone can't distinguish completed / user-cancelled / error, so `exit_reason` would be ~100% `unknown` in aggregate. Session-failure diagnosis happens through the spans captured here.
- **Daemon / PTY health telemetry (`pty_disconnected` etc.) is always v2.** It belongs on this side of the split, alongside crash reporting — not on the PostHog side.

## Why a separate lane at all

The current plan's `agent_error` event is the right design for *aggregate* reliability questions — "what fraction of sessions fail with auth errors?" is answerable from a classified enum. It is the wrong tool for *diagnostic* questions — "why did Brennan's session fail at 3pm on Tuesday?" That question needs a stack trace, a cwd, the exact error message, and the sibling span timeline. All four are things we have sworn never to ship through PostHog.

Three things fall out of this if we don't fix it:

1. **We under-diagnose.** When a user files a bug, we ask them to reproduce with debug logs on, or to paste a stack. That's the current Orca experience and it's worse than the one our peers offer.
2. **The `agent_error` enum rots faster in Orca than in peers.** Without per-failure context, the `unknown` slice grows into a long tail that no one can break down into real bugs. The trimmed v1 enum (`'binary_not_found' | 'unknown'`) makes this even more pronounced — most agent-side failures are unobservable to Orca's parent process and would not have populated the larger enum either, but the dashboard reads as ~all-`unknown` for the same reason.
3. **Pressure builds on the product-telemetry lane.** Every bug report that could have been diagnosed from trace data becomes an argument to add "just this one raw field" to the PostHog schema. T3 Code's architecture explicitly keeps that pressure off by putting errors in a different place. We should too.

Peer evidence for the split (audit-grounded, 2026-05-01 — detailed per-peer survey in [Competitor error-tracking survey](#competitor-error-tracking-survey) below):

- **T3 Code**, **Ghostty**, **VS Code** separate the two lanes at the *architecture* level — error data lives in a different code path with different consent gates and different transport than product telemetry.
- **Warp** unifies the vendor but routes via a per-event `contains_ugc()` flag to a second write key — same vendor, different destinations. A principled alternative to a separate lane.
- **cmux**, **GitButler**, **Zed** split at the *vendor* level — PostHog for product, Sentry for crashes. Two toggles or two SDKs, one product lane still disciplined.
- **superset-sh**, **Conductor**, **emdash** conflate the lanes — raw error strings (stack traces, error messages, cwd) ship through the analytics vendor. The anti-pattern this doc counter-designs.
- **open-vibe-island** — cautionary tale on policy/implementation drift. README states "No server, no telemetry, no account" ([`README.md:46`](https://github.com/open-vibe-island/open-vibe-island/blob/HEAD/README.md)) but the installed app bundle links `Sentry.framework` and ships to a Sentry DSN ([`docs/installed-app-bundle-analysis.md:46,290-292`](https://github.com/open-vibe-island/open-vibe-island/blob/HEAD/docs/installed-app-bundle-analysis.md)). Whatever discipline we impose at v1 has to be preserved in the build pipeline or it decays silently.

Every peer that handles both signals *well* separates them either architecturally or via explicit per-event UGC routing. The peers that conflate are the ones our plan already cites as schema anti-patterns.

## Non-goals

- Replacing `agent_error` in PostHog. The enum-only event stays — it answers aggregate questions this lane does not.
- Sentry. Adding a third managed vendor doubles the privacy-audit surface for developer users who already inspect our SDK list. If we need crash content beyond what local traces + optional OTLP give us, revisit — but only then.
- Server-side logs. Orca has no server; this doc scopes to the desktop process.
- Renderer performance profiling. Out of scope; covered adequately by Chromium devtools for now.


## The two lanes, side by side

| Concern | Product-telemetry lane (existing) | Error-tracking lane (this doc) |
|---|---|---|
| Vendor | PostHog Cloud US | None by default. Local file on disk. Optional OTLP to a user-run endpoint. |
| Always on? | Yes (subject to consent) | Yes for local capture. No for network export. |
| Leaves the machine by default? | Yes (PostHog) | **No.** Only via explicit user action (bundle share) or explicit user config (OTLP env var). |
| UGC-tolerant? | No — schema is enum/bool/bucket only, typed event map + runtime sanitizer | Yes — local file can contain paths, cwd, stack traces, error messages |
| Retention | 12 months (PostHog config) | Rotated locally: ~10 files × 10 MB, FIFO |
| Primary audience | Orca dev team, aggregate dashboards | The user first; Orca dev team only if the user ships us a bundle |
| Runtime | Main process (Node) | Main process (Node) |
| Identity | `install_id` UUID | None locally. **Bundles uploaded in Mode 3 carry a fresh per-bundle `bundle_submission_id`, never the PostHog `install_id`** — the two lanes must not share a join key. |
| Cost at any scale | Free → $256/mo around 1k users | $0. No vendor. |

The key asymmetry: the product lane treats every user's machine as a source of data that flows outward by default; the error lane treats every user's machine as a destination for data that flows *inward* by default. The only way a user's debug context reaches Orca is if the user actively sends it.

## What the error-tracking lane captures

Scope is the same as T3 Code's: completed spans from the main process, with their attributes, events, and exit outcome.

**Included in the local NDJSON file** (`~/Library/Application Support/Orca/logs/main.trace.ndjson` on macOS; equivalent paths on Windows and Linux):

- Span name, `traceId`, `spanId`, `parentSpanId`
- `durationMs`, start/end timestamps
- Attributes: free-form. Paths, cwds, command args, thread IDs all allowed here. The file is local.
- Events: embedded log messages (`console.error`, `logger.warn`) attached as span events
- Exit outcome: `Success` / `Failure` / `Interrupted` with the pretty-printed cause string — this is where the stack trace lives

**Explicitly excluded, even in the local file:**
- File contents
- Terminal / PTY output byte streams
- Agent prompts
- Agent responses
- Credentials, tokens, API keys — redacted at the sink

The file is local by default, but it exists on a device the user may hand to a colleague, upload to GitHub, or sync to iCloud. Secrets redaction is non-negotiable even locally.

**What is *never* captured in any lane:**
- Anything the product-telemetry plan's "What we never send" list forbids from the PostHog lane, with the narrow carve-outs above. The forbid-list is additive across lanes, not per-lane.

## The three modes

Modeled on T3 Code's `docs/observability.md` §"Run The Server In Instrumented Mode", adapted for the Electron main process.

### Mode 1 — Local only (default)

Always on. No user action required.
- Spans written to `~/Library/Application Support/Orca/logs/main.trace.ndjson` (platform-equivalent elsewhere).
- File rotation: 10 MB × 10 files (matches T3 Code's defaults). Oldest deleted on rotation.
- Zero network traffic from this lane.
- Zero cost.

Purpose: if a user reports a bug, we ask for the trace file. They inspect it first, decide whether to share.

### Mode 2 — Local + OTLP export (opt-in, user-configured)

A user who wants to debug their own Orca usage — or a developer on the Orca team dogfooding — sets env vars pointing the app at their own OTLP endpoint:

```
ORCA_OTLP_TRACES_URL=http://localhost:4318/v1/traces
ORCA_OTLP_METRICS_URL=http://localhost:4318/v1/metrics    # reserved for v2 — traces only in v1
ORCA_OTLP_SERVICE_NAME=orca-desktop-myname
```

Paired with T3 Code's documented `docker run grafana/otel-lgtm` command, a user can stand up a full trace UI in ~30 seconds. The data never leaves their machine (or their infra if they run LGTM elsewhere).

Important: **no Orca-operated OTLP endpoint.** The env var contract is deliberately "point at your own thing." The README **Privacy & Telemetry** section can truthfully say we do not run an OTLP ingest for user traces.

### Mode 3 — Diagnostic bundle share (opt-in, per-incident)

The only user-initiated network path from this lane back to Orca. A button in Settings → Privacy → Diagnostics labeled "Share a diagnostic bundle with Orca support":

1. User clicks the button. The main process collects the last N minutes of trace NDJSON, the current app version, platform/arch/OS release, build channel, collection timestamp, and a fresh `bundle_submission_id` (128-bit random, generated per bundle — **not** the PostHog `install_id`). See "Why bundles do not carry `install_id`" below.
2. Runs the redactor (see [The redactor](#the-redactor), rules 1–5) a second time over the collected bundle — belt-and-suspenders with the sink-write pass.
3. Opens a local preview window: the user can see exactly what will be sent as plain text. They can copy, edit, or cancel.
4. On confirm, the client requests a **short-lived upload token** from the Orca auth endpoint (see Endpoint contract below), then uploads the bundle to the ingest endpoint using that token.
5. Server-side the ingest endpoint runs the redactor a **third time** (see [Where the redactor runs](#the-redactor), layer 3), writes the bundle to a private object-storage bucket, and returns a ticket ID to the client.
6. The client surfaces the ticket ID in the Privacy pane and offers "Copy ticket ID" and "Delete this bundle" controls.
7. User attaches the ticket ID to their GitHub issue or support email.

**Why a bundle and not a send-on-crash hook.** Send-on-crash is the Sentry pattern. It moves fastest but it ships before the user knows what's being shipped. Making it a button keeps the consent model crisp: *product* telemetry transmits quietly because it has nothing sensitive in it; *error* telemetry transmits only when the user clicks send on a payload they just looked at.

This trades some bug-report volume for a much cleaner privacy story. That tradeoff is the whole point of the split.

#### Endpoint contract

Two endpoints, both fronted by the same edge (Cloudflare / API gateway):

- `POST /diagnostics/token` — client requests an upload token. Returns `{ token: string, expires_at: ISO, upload_url: string, max_bytes: 10485760 }`. Token is a 256-bit cryptographically-random string, lives 5 minutes, is single-use (redeemed-at-upload, invalidated thereafter).
- `POST /diagnostics/upload` — client uploads the bundle. Headers: `Authorization: Bearer <token>`, `Content-Type: application/x-ndjson` (or `application/json`), `Content-Length: <bytes>`. Body must be valid NDJSON or JSON; binary content-types are rejected.

**Hardening requirements** (each is ship-blocking for Mode 3):

1. **Short-lived token auth.** The bundle-upload endpoint requires a valid, unexpired, unredeemed token obtained from the token endpoint. Tokens are single-use and scoped to one bundle. Extracting the binary does not give an attacker a persistent credential — they'd have to re-request a token every time, and the token endpoint is rate-limited independently.
2. **Per-IP rate limit at the edge.** `POST /diagnostics/token`: ≤ 10 tokens per IP per hour. `POST /diagnostics/upload`: ≤ 10 uploads per IP per hour. Bundle sharing is a deliberate human action measured in seconds-to-click, not requests-per-second; anything above this is either a bug or abuse.
3. **Max body size 10 MB.** Matches the default local-file rotation size. Rejected at the edge before the request reaches the ingest worker; no request body is ever buffered in memory past the limit.
4. **Strict content-type allowlist.** `application/x-ndjson` and `application/json` only. Reject `multipart/form-data`, `application/octet-stream`, and everything else. The bundle is structured data, not a binary payload.
5. **Ticket IDs are unguessable and non-enumerable.** 128-bit cryptographically-random identifier, URL-safe encoded (e.g., 22-char base64url). No sequential component. No user-identifying prefix. A ticket ID leaked into a public GitHub issue gives anyone who sees it the ability to (optionally) request deletion via the same ticket ID — which is exactly the authorization model we want ("ticket ID is the whole auth story"), so there is no higher-privilege lookup that needs protecting.
6. **Private storage.** Object-storage bucket with no public-read ACL, no CDN fronting. Orca staff access bundles via a short-lived pre-signed URL issued by an internal admin tool. Bucket access logs retained ≤ 30 days.
7. **Server-side redaction on ingest.** The ingest worker runs the same redactor rules 1–5 as the client before writing to storage. The client-side redactor runs on an attacker-controllable binary; server-side redaction is the guarantee. An optional secret-shape scanner flags bundles with likely-unredacted provider keys for manual review — this is defense-in-depth against a bug in the redactor itself.
8. **Retention and deletion.** Bundles are retained 30 days, then auto-deleted. A `POST /diagnostics/delete/:ticket_id` endpoint (rate-limited to 10 per IP per hour, no auth required beyond the ticket ID) deletes on demand within 7 days. The app surfaces the delete action in the Privacy pane alongside the ticket ID.
9. **No authenticated user identity.** Deliberate. The token + ticket ID model is the entire auth story; tying the bundle to a login would undo the "we don't collect identity" promise and break the anonymous `install_id` design.
10. **No renderer access to any of these endpoints.** The main process is the only caller. The renderer triggers the flow via the `window.api.diagnostics.*` IPC namespace (see `src/preload/api-types.ts`); the HTTP work stays in main. A compromised renderer can initiate a bundle share (which requires the user to click through the preview), but cannot silently POST to the ingest endpoint.

**Open items that do not block the spec:** decision on ingest cloud provider (Cloudflare R2 vs S3), admin-tool implementation, and the exact edge rate-limit platform. All are operational choices that inherit from the hardening list; the contract above constrains the implementation enough that any reasonable cloud stack satisfies it.

#### Why bundles do not carry `install_id`

The PostHog lane's anonymity story rests on `install_id` being an opaque UUID with no external coupling — no GitHub username, no SHA of a provider account ID, nothing an Orca operator can resolve to a person. The diagnostic bundle lane breaks that property by construction: bundles contain paths, cwds, stack frames, and potentially git-config output — any of which can include a real-world name. If a bundle also carried the `install_id`, an Orca staff member who opened one bundle could then join back to every PostHog event that user has ever emitted (daily actives, settings changes, agent errors, crashes), re-identifying the entire event history for that `install_id`.

The fix is structural: bundles carry a fresh `bundle_submission_id` (128-bit random, generated at bundle-collection time, not persisted anywhere client-side) and no `install_id`. A user who submits two bundles produces two unrelated IDs. The two lanes are join-incompatible on the client side, and because the server-side redactor runs before storage, no span field in the bundle should carry the `install_id` either — add the `install_id` UUID shape (or the literal current `install_id` value at ingest time) to the server-side redactor's block-list to enforce this. This is ship-blocking for Mode 3 and is documented in the README **Privacy & Telemetry** section as an explicit non-correlation guarantee.

## Architecture

### Where it lives in the main process

Mirrors the product-telemetry main-process layout so the two lanes are symmetric in structure and distinct in wire destination.

```
src/main/telemetry/
  client.ts              # PostHog wrapper
  validator.ts           # typed event map + runtime sanitizer
  burst-cap.ts           # per-event burst limiter
  consent.ts             # consent + kill-switch resolution
  install-id.ts          # anonymous install identifier

src/main/observability/   # NEW — the error-tracking lane
  index.ts               # composition root (init / shutdown / consent)
  tracer.ts              # span recorder modeled on T3 Code's TraceSink
  local-file-sink.ts     # NDJSON writer with rotation
  otlp-exporter.ts       # optional OTLP exporter, gated on env var
  redactor.ts            # secrets scrubber run on every span before sink write
  bundle.ts              # diagnostic-bundle collection + preview + upload
  instrumentation.ts     # withGitSpan / withWorktreeSpan / etc helpers
```

Two hard rules, enforced in review:

1. **Nothing in `src/main/telemetry/` imports from `src/main/observability/` or vice versa.** The two lanes never share a code path. Cross-contamination is the failure mode we're explicitly counter-designing.
2. **PostHog's typed event map never references anything from the observability lane.** No "this error object shows up in both places" pattern. The enum is the enum; the trace is the trace.

### The redactor

Run synchronously at sink-write time — before NDJSON serialization, before OTLP export, before bundle collection. Applied to every attribute value, every span-event message, and every exit-status `cause` field on every span.

**Why v1 redaction is comprehensive.** The redactor is the guarantee behind three promises: "local trace files don't contain provider credentials," "OTLP exports don't leak keys to a user's self-hosted collector," and "diagnostic bundles the user previews before sending don't surface a key the user might miss in the preview window." For an AI agent tool, provider errors commonly echo the credential back ("Invalid token: sk-ant-..."), so secret leakage into spans is the expected case, not an edge case. Redaction has to cover the common shapes at v1.

**Rule 1 — labeled key-value redaction.** Any string containing a match for the labeled-credential pattern:

```
/(?:api[-_]?key|token|secret|password|bearer|authorization)\s*[:=]\s*\S+/i
```

→ replace the whole matched value segment with `[redacted]`. Catches `"api_key: sk-..."`, `"Authorization=Bearer ..."`, `"password='hunter2'"`.

**Rule 2 — provider-key fingerprint redaction.** Each shape is matched independently — a single string can match multiple shapes and all matches are replaced. Replacement is `[redacted:<shape>]` so the debug context preserves *what was redacted* for triage (e.g., `[redacted:anthropic-key]` tells the Orca team the user hit a Claude auth failure without exposing the key).

| Shape | Regex | Where it appears |
|---|---|---|
| Anthropic API key | `/sk-ant-[a-zA-Z0-9_-]{40,}/g` | Every Claude error echoed back |
| OpenAI API key (legacy + project) | `/sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g` | Every Codex / OpenAI error |
| GitHub personal/app/OAuth tokens | `/gh[pousr]_[A-Za-z0-9]{36,}/g` | Git push/pull auth failures |
| AWS access key ID | `/AKIA[0-9A-Z]{16}/g` | AWS CLI error spans |
| AWS secret access key (labeled) | `/aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi` | `.env` dumps in stack frames |
| JWT | `/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g` | Session tokens, provider auth state |
| Slack tokens | `/xox[baprsoe]-[A-Za-z0-9-]{10,}/g` | Slack MCP integrations |
| PEM-encoded private keys | `/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g` | Accidentally-pasted keys in cwd |

**Rule 3 — URLs with embedded credentials.** Any URL matching `https?://[^/\s:]+:[^@\s]+@` → strip the userinfo component. `https://ghp_abc123@github.com/foo/bar` becomes `https://[redacted]@github.com/foo/bar`. Preserves the host and path for debug context; removes the credential.

**Rule 4 — `.env`-shape line redaction.** Any line matching `/^\s*[A-Z_][A-Z0-9_]*\s*=\s*\S+/m` inside a string attribute → redact the value but keep the key name (`FOO_SECRET=sk-abc123` becomes `FOO_SECRET=[redacted:env-value]`). Catches the "user pasted their .env into the terminal and it ended up in a span" case.

**Rule 5 — attribute-key block-list.** Drop attributes whose key is in the block-list, regardless of value: `env`, `environment`, `env_vars`, `headers.authorization`, `authorization`, `cookie`, `set-cookie`, `proxy-authorization`. Case-insensitive match. **Mode 3 server-side pass additionally drops `install_id`, `installId`, and `distinct_id`** — bundles are not supposed to carry the PostHog lane's identifier (see [Why bundles do not carry `install_id`](#why-bundles-do-not-carry-install_id)); the server-side pass treats any leaked occurrence as a bug and strips it before storage.

**No per-attribute length cap.** Worst-case sizing is already handled by envelope-level bounds: the local file rotates at 10 MB × 10 files, and Mode 3 uploads cap at 10 MB. A per-attribute cap (e.g. truncating strings >4 KB) was considered and rejected — it specifically eats the *tail* of long strings, which for `Cause.pretty()` stack chains is the original throw site (the most diagnostic frames). Matches T3 Code's tracer, which has shipped without a per-attribute cap and has not produced complaints. Spans dumping a multi-MB blob into an attribute are a call-site bug, not a sink-write concern.

**Leave paths and cwds alone.** Paths are the most useful debug field; the file is local by default and the user previews the bundle before any send. The rules above redact credentials *inside* paths (Rule 3 for URL userinfo); raw filesystem paths are intentionally preserved.

**Where the redactor runs.**
1. **Synchronously at sink-write time** for the local NDJSON file and any OTLP export. Every span goes through redaction before serialization.
2. **Synchronously at bundle-collection time**, as a second pass before the user-preview window renders. Belt-and-suspenders: if rule 1–5 have a bug, the preview is the user's last chance to see unredacted content before send.
3. **Server-side on bundle ingest** (see [Mode 3 — Diagnostic bundle share](#mode-3--diagnostic-bundle-share-opt-in-per-incident)). The client-side redactor runs on an attacker-controllable binary; server-side redaction on ingest is the defense-in-depth guarantee for the one path where user content reaches Orca infrastructure.

**Test strategy for the redactor.** Fixture-based for each of the eight shapes above: for each, feed a span with the secret embedded in (a) an attribute value, (b) a span-event message, (c) an exit-status `cause` field. Assert the secret does not appear verbatim in the serialized output. Property-based fuzz test (optional but cheap): generate random strings containing known-secret shapes, assert the serialized span never contains the raw shape verbatim. Catches regex edge cases faster than hand-picked fixtures.

**v2 candidates:** user-configurable additional regex rules (operator-supplied allowlist of secret shapes specific to their internal tooling); per-provider entropy heuristic as a last-resort catch-all for unlabeled high-entropy strings (accepting false positives on legitimately-opaque IDs).

### Span boundaries worth capturing

T3 Code's list in `docs/observability.md` §"How To Think About Adding Tracing To Future Code" maps cleanly onto Orca:

- IPC boundaries (renderer → main preload calls)
- Agent session lifecycle — start, turn, stop, recover
- Git command execution
- Worktree setup (clone / checkout / install)
- PTY session lifecycle
- External editor launches
- Updater operations

Avoid tracing every small helper. Inherit the active span. This is the same guidance the product-telemetry lane does *not* get to give, because PostHog events are discrete and named; trace spans are a tree and overtracing ruins the shape of the tree.

### User controls

Settings → Privacy → Diagnostics, below the existing telemetry toggle:

- **"Open trace folder"** — reveals `main.trace.ndjson` in Finder/Explorer/file manager. Precedent: Aider's sample-log publication; this is the equivalent for a live running app.
- **"Clear local traces"** — deletes all rotated trace files. Useful before handing a laptop to someone else.
- **"Share a diagnostic bundle with Orca support"** — the Mode 3 button.
- **"OTLP export"** — display-only status. Reads the env var at launch; shows "Disabled" or "Enabled — exporting to `<url>`". Not a UI toggle; users flip it by setting the env var and restarting. Matches how the existing Privacy pane surfaces env-var state for blocked-by-environment toggles.

### Consent boundaries

The error-tracking lane honors the same env-var kill switches as the product lane:

- `DO_NOT_TRACK=1` — disables OTLP export and the diagnostic-bundle button. **Does not disable local file writes** — they never leave the machine, so they are not "tracking" in the DNT sense. Rationale matches how Wave Terminal splits `telemetry:enabled` from `WAVETERM_NOPING`: two channels, two toggles, no forced bundling.
- `ORCA_TELEMETRY_DISABLED=1` — same as `DO_NOT_TRACK` for this lane (disables OTLP + bundle, keeps local file).
- `ORCA_DIAGNOSTICS_DISABLED=1` — **new.** Disables local file writes too. The escape hatch for users who run on a device where even local debug logs are policy-forbidden (regulated industries, shared kiosks). Uncommon case, cheap to support.
- CI detection — disables everything in this lane (no local file in CI, no bundle button).

The Privacy pane toggle does *not* gate this lane. The lane's only outbound paths are already user-initiated (Mode 2 env var, Mode 3 button) or user-scoped (Mode 1 local file). Adding a second UI toggle would be noise without signal.

## How this interacts with `agent_error`

`agent_error` in the PostHog lane is enum-only. This doc is additive.

**Final v1 shape:**

- `error_class` — closed enum, currently `'binary_not_found' | 'unknown'`. The narrower v1 enum reflects Orca's PTY-shell-typed-command launch architecture: agent-side errors (auth, rate-limit, provider failures) live inside the agent CLI subprocess and are not observable to Orca. The earlier 10-value enum (`network_timeout`, `auth_expired`, `rate_limited`, `provider_unavailable`, `provider_error_generic`, `binary_not_found`, `binary_version_mismatch`, `workspace_gone`, `user_cancelled`, `unknown`) was deferred. Expand only when a real call site lands.
- `agent_kind` — the same enum used by `agent_started` (`claude-code` / `codex` / `gemini` / `other`).

The `error_name` property and its closed `AGENT_ERROR_NAME_WHITELIST` were also part of the earlier draft. Both were deferred when the enum trim collapsed `error_name`'s utility (with two enum values, the per-name whitelist carries no additional signal). When this property is re-introduced, prefer a closed whitelist over a shape-only regex — a regex passes identifier-shaped leaks like `PaymentFailedForUserAlice` or `AuthExpiredForAcmeCorp`; a closed whitelist closes that class of bug by construction. Same pattern as `SETTINGS_CHANGED_WHITELIST`.

The relationship between the two lanes when an agent fails:

1. The error is caught at the provider-adapter boundary.
2. A classifier maps it to one of the `error_class` enum values (`binary_not_found` for ENOENT/"not found"; `unknown` for everything else). The enum-only event fires into PostHog with common props (`install_id`, `app_version`, etc.), `agent_kind`, and `error_class`.
3. In parallel, the span that wrapped the failing call has already recorded — via its exit outcome — the full cause, including the message and stack. That span ends up in the local NDJSON file.

The two lanes describe the same event at different fidelities:
- **PostHog** answers "how often does this class of failure happen across the user base?" (aggregate, no diagnostic content)
- **Local trace** answers "what exactly happened in this one failure?" (full cause, never leaves the machine by default)

No single call site writes to both. The classifier writes to PostHog; the tracer writes to the file. They share no mutable state beyond the process itself. This separation is enforced by the two hard import rules in [Architecture → Where it lives in the main process](#where-it-lives-in-the-main-process).

## Costs

- **Infra:** $0. No vendor for the default mode. The bundle-upload endpoint (Mode 3) is a single HTTP POST into object storage; traffic will be low because bundles fire only when a user clicks a button after reviewing a payload. Budget ~$5/mo S3 + egress at any plausible v1 volume.
- **Disk on the user's machine:** 10 files × 10 MB = 100 MB worst case, FIFO rotated. Matches T3 Code's default and has caused no reported complaints there.
- **Process overhead:** Effect's local-file tracer batches every 200 ms (T3 Code's default). Main-process cost is dominated by the serialization, not the I/O; negligible at our span volume.
- **Engineering:** the local-file tracer + rotation is ~300 LOC following T3 Code's implementation (`apps/server/src/observability/LocalFileTracer.ts`, `TraceSink.ts`). OTLP export is already a first-party Effect module (`OtlpTracer.make`), no custom transport. Diagnostic bundle preview + upload is ~200 LOC renderer + ~100 LOC main. Total ~600 LOC v1.

## Open questions

1. **Bundle-upload endpoint implementation.** Contract is specified in [Endpoint contract](#endpoint-contract); the remaining choices are operational (Cloudflare R2 vs S3, edge rate-limit platform, admin-tool implementation for staff retrieval). Any stack that satisfies the hardening list works.
2. **macOS sandboxing of the trace folder.** If Orca moves into the Mac App Store, sandboxed writes to `~/Library/Application Support/Orca/logs/` are fine; `Reveal in Finder` works; `Open trace folder` works. But a future tightened sandbox policy could block the env-var-driven OTLP exporter's outbound socket. Flag to re-check if/when the sandbox posture changes.
3. **Renderer-side errors.** This lane is main-only for v1 (matches the product-telemetry lane's main-only position). React error boundaries in the renderer currently log to `console.error` and nothing more. Decision: do we pipe renderer errors into the same span tree via an IPC bridge (symmetric with how renderer events reach PostHog), or leave renderer errors to devtools? Leaning toward IPC bridge, deferred to v2 until we have a concrete bug class we can't diagnose today. **When this lands**, the IPC bridge must enforce (a) the per-event-name burst cap pattern from the PostHog lane, (b) a per-session byte ceiling (e.g., ≤100 MB written by renderer-originated spans per `session_id`, because rotation deletes old files but doesn't prevent a compromised renderer from writing faster than rotation reclaims), and (c) a main-process allowlist of span shapes the renderer can submit (same validator-pattern the PostHog lane uses). Writing to the local trace file from the renderer is a compromised-renderer disk-fill surface otherwise.
4. **Retention of uploaded bundles.** Resolved in [Endpoint contract](#endpoint-contract) item 8: 30-day retention, user-initiated delete via ticket-ID endpoint with 7-day SLA. Language to be mirrored in the README **Privacy & Telemetry** section.
5. **Does the bundle include recent `agent_error` event IDs?** Cross-linking PostHog-side aggregate failure-rate data with a specific trace could be useful for reproduction, but it also re-couples the two lanes. Default: no cross-link in v1. Users can paste the ticket ID into the PostHog query manually when needed.

## What to copy from T3 Code verbatim

Files from `/Users/thebr/source/repos/public/t3code` that are direct implementation references:

- `apps/server/src/observability/LocalFileTracer.ts` — the Effect `Tracer.Tracer` wrapper that serializes spans on end. Port to `src/main/observability/tracer.ts`.
- `apps/server/src/observability/TraceSink.ts` — NDJSON writer with batch-flush and rotation. Port to `src/main/observability/local-file-sink.ts`.
- `apps/server/src/observability/TraceRecord.ts` — the serialization format. We can use it unchanged; the schema is vendor-neutral OpenTelemetry-shaped JSON.
- `apps/server/src/observability/Layers/Observability.ts` — the composition root, wires local file + optional OTLP + metrics. Port to `src/main/observability/index.ts`.
- `apps/server/src/observability/Attributes.ts` — attribute normalization, the pattern for handling Error instances cleanly. Keep.
- `docs/observability.md` — documentation template. Our user-facing copy will be shorter, but the structure (three modes, jq cookbook, trace-vs-metrics rubric) translates directly.

What **not** to copy: the `Identify.ts` file that hashes provider account IDs into a `distinct_id`. That's T3 Code's product-telemetry identity, already rejected in Orca's telemetry plan. The error-tracking lane doesn't need an identifier at all.

## Competitor error-tracking survey

Source-verified 2026-05-01 against locally-cloned repos under `/Users/thebr/source/repos/public/`. Here we look only at how each project handles crashes, exceptions, stack traces, and diagnostic tracing — the signal this lane is built to carry.

Five architectural strategies emerge across the set. Rows below are ordered by how closely each peer's approach aligns with ours.

### Strategy A — Structured tracing, local-first, operator-oriented

**T3 Code** (`apps/server/src/observability/`). The design we're porting. Errors live in Effect span exit status (`TraceRecord.ts:35-46`) — each completed span carries `exit: { _tag: "Success" | "Interrupted" | "Failure", cause: string }`, where `cause` is `Cause.pretty(exit.cause)` (the formatted stack). NDJSON is the persistent source of truth; OTLP is an opt-in mirror for operators running Grafana LGTM. PostHog schema carries zero error events — this is the *only* peer in the survey whose product telemetry has no error signal at all, because the error signal is deliberately elsewhere.

Why this works: the error representation (span exit) is richer than a stack trace alone — it ties the failure to its enclosing request, the sibling spans, and the attributes at each level. T3 can afford to be strict on product-telemetry UGC precisely because span data picks up the slack.

### Strategy B — Local-only crash dumps, opt-in upload by user

**Ghostty** ([`README.md:189-226`](https://github.com/ghostty-org/ghostty/blob/HEAD/README.md)). The strictest position in the set. On crash, Ghostty writes `.ghosttycrash` files in `$XDG_STATE_HOME/ghostty/crash` using **Sentry envelope format** — a documented open format, no Sentry SDK installed, no network traffic. To share a crash with the project, the user runs `sentry-cli send-envelope` themselves with the Ghostty-owned DSN in the command. The README includes an explicit warning: *"The crash report can contain sensitive information... it does contain the full stack memory of each thread at the time of the crash."*

This is the local-first stance taken to its logical end. Three things transfer to Orca:

1. **Sentry envelope as a file format** — decoupled from any SDK. A user can inspect the envelope with `sentry-cli`, and a future Orca could switch upload destinations without rewriting the capture path. Worth considering as an alternative to raw NDJSON for Mode 1, especially for true crashes (segfaults) where the process can't write structured JSON.
2. **Explicit CLI command to list crash reports** (`ghostty +crash-report`). Our Mode 3 button is the GUI equivalent; a CLI shortcut for power users is a cheap addition.
3. **An honest warning.** Ghostty does not pretend local crash reports are sanitized. They aren't — stack memory dumps cannot be. The warning prose is short and direct; we should match its tone in our Settings → Privacy → Diagnostics copy.

### Strategy C — Same vendor, per-event UGC-routing flag

**Warp** (`crates/warp_core/src/telemetry.rs:29-61, 165, 194`). Doesn't split by vendor or by lane. Every event implements a `contains_ugc() -> bool` method on the `TelemetryEvent` trait (line 57). At send time, Warp routes to one of two Rudderstack write keys based on that flag — `write_key` (non-UGC destination) vs `ugc_write_key` (UGC destination). One vendor, two backends, per-event routing decision enforced by the trait.

This is a genuinely different answer to the same problem. The split-lane approach assumes errors are fundamentally different from product events; the `contains_ugc()` approach assumes any event type can carry UGC or not depending on context, and the routing decision should be per-event. For a schema as constrained as ours (enum-only, no raw strings), the flag would always be `false` in the PostHog lane and always `true` in the error lane — effectively the same topology. But if we ever add an event that *sometimes* carries UGC — for example, a user-submitted feedback string — Warp's pattern is more flexible than the strict two-lane split.

Not adopting for v1: our lane split is already architectural (different code paths, different destinations), and the `contains_ugc()` flag on top would be redundant. Noting it for the open-question list in case we grow an event that blurs the line.

### Strategy D — Vendor-level split: PostHog for product, Sentry for crashes

**cmux** (`Sources/AppDelegate.swift:1010-1040`). Native Swift, PostHog + Sentry running side by side, both gated by `TelemetrySettings.enabledForCurrentLaunch`. The PostHog lane ships just two active-user pings. Everything else — crashes, app-hangs (`appHangTimeoutInterval: 8.0`), performance traces (`tracesSampleRate: 0.1`), breadcrumbs — flows through Sentry with `attachStacktrace: true` on every event.

Content risk in this model: Sentry breadcrumbs carry `[String: Any]` dictionaries with no redaction. `Sources/TerminalController.swift` ships `requestedPath` / `fallbackPath` as raw filesystem strings inside a breadcrumb; when a subsequent Sentry error fires, those paths go out with it. Same failure mode as emdash's `$exception_stack_trace_raw` despite being ostensibly "just breadcrumbs."

**GitButler**, **Zed** — same topology at a lower fidelity (Sentry for crash content, PostHog for product). Both enable Sentry performance monitoring, widening the content surface.

**superset-sh** (`apps/web/sentry.server.config.ts:11`). Ships `sendDefaultPii: true` on its server Sentry init. Not "no redaction configured" — PII explicitly *enabled*. This is the ceiling of what a careless Sentry setup looks like. The bright line our redactor replaces.

What to adopt from Strategy D: the vendor split itself is defensible — Sentry does real work on stack symbolication, deduplication, and crash triage that NDJSON doesn't. What to avoid: `sendDefaultPii: true`, breadcrumb-as-string-bucket, `attachStacktrace: true` globally. If we ever add Sentry to Orca, `beforeSend` + a strict allowlist for breadcrumb data is the mandatory path.

### Strategy E — VS Code: separate setting keys, cascade gate

**VS Code** (`src/vs/platform/telemetry/common/telemetryUtils.ts:135-159`). The most disciplined consent model in the set. Three separate setting keys:

- `telemetry.telemetryLevel` — multi-level: `all` / `error` / `crash` / `off`.
- `telemetry.enableCrashReporter` — boolean for the crash-reporter specifically.
- `telemetry.enableTelemetry` — legacy boolean, retained for back-compat.

The cascade: *"If `telemetry.enableCrashReporter` is false OR `telemetry.enableTelemetry` is false, disable telemetry"* (lines 143-144). Either signal forces everything off. This is belt-and-suspenders — a user who turns off crash reporting gets product telemetry turned off too, because Microsoft's position is that the less-invasive lane should not outlive the more-invasive one.

Relevance to Orca: our lane split goes the other direction (both lanes default on, user can kill either independently). VS Code's cascade is the opposite philosophical choice — they treat the lanes as an ordering ("if you don't want crashes, you definitely don't want usage"), which we explicitly don't. Worth noting as the thoughtful opposite of our design rather than as a pattern to copy.

### The three lane-conflation anti-patterns

**emdash** (`src/main/lib/telemetry.ts:381-395`). `captureException` sends `$exception_message` (500 chars), `$exception_type`, `$exception_stack_trace_raw` (2000 chars) — all through the same PostHog pipe as product events. No path redaction on the stack trace. Provider errors, file paths, and prompt fragments routinely end up in the analytics event store. Our plan's `error_class`-only rule is the direct response.

**Conductor** (`conductor.build/docs/reference/privacy`). Captures crash traces with stack traces, model-provider errors with error messages. Same pattern at the schema level.

**superset-sh** — in addition to the Sentry PII issue above, product events carry raw `error_message` + `cwd` strings.

Three peers, three variants of the same mistake: the lane is singular, the signal types are different, and the product-telemetry destination has no way to refuse the UGC when it arrives.

### Summary table

| Project | Strategy | Error payload includes | Vendor | Consent model | Evidence |
|---|---|---|---|---|---|
| **T3 Code** | A — structured tracing, local-first | Span exit status + `Cause.pretty` | Local NDJSON (opt-in OTLP) | Env vars only | `apps/server/src/observability/TraceRecord.ts:35-46` |
| **Ghostty** | B — local-only crash dumps | Full thread stack memory (Sentry envelope format) | None — file on disk | User runs `sentry-cli` themselves | `README.md:189-226` |
| **Warp** | C — per-event UGC flag | Depends on event's `contains_ugc()` | Rudderstack (two write keys) | Feature-flag + `is_telemetry_enabled` | `crates/warp_core/src/telemetry.rs:29-61,165,194` |
| **cmux** | D — vendor split | Stack traces + breadcrumbs (unredacted paths) | PostHog + Sentry | Single toggle gates both | `Sources/AppDelegate.swift:1010-1040` |
| **GitButler** | D — vendor split | Sentry crashes + perf traces | PostHog EU + Sentry | `update_telemetry` IPC | `crates/but-server/src/lib.rs` CSP |
| **Zed** | D — vendor split (separable) | Sentry crashes + Amplitude metrics | Sentry + Snowflake + Amplitude + Hex | `telemetry.diagnostics` vs `telemetry.metrics` | [`zed.dev/docs/telemetry`](https://zed.dev/docs/telemetry) |
| **VS Code** | E — cascade gate | Electron `crashReporter` minidumps | First-party | `enableCrashReporter` + `telemetryLevel` | `src/vs/platform/telemetry/common/telemetryUtils.ts:135-159` |
| **emdash** | conflated | `$exception_stack_trace_raw` (2KB, unredacted) | PostHog (same pipe as product) | Single toggle | `src/main/lib/telemetry.ts:381-395` |
| **Conductor** | conflated | Stack traces + error messages | PostHog | Single toggle | [`conductor.build/docs/reference/privacy`](https://conductor.build/docs/reference/privacy) |
| **superset-sh** | conflated + PII-on | `sendDefaultPii: true` + raw `error_message`/`cwd` | Sentry + PostHog | Environment-gated, no user toggle | `apps/web/sentry.server.config.ts:11` |
| **open-vibe-island** | drift | Claims no telemetry, bundle ships Sentry DSN | Sentry (actual) / none (claimed) | None | `docs/installed-app-bundle-analysis.md:46,290-292` vs `README.md:46` |

### Five takeaways for Orca's design

1. **Strategy A (our port) is the rarest choice in the set.** Only T3 Code ships it. That's a feature, not a bug — it's what lets us have both rich diagnostic data *and* an enum-only product-telemetry schema without either lane compromising the other.
2. **Ghostty's Sentry-envelope-as-file-format is worth evaluating as an alternative to NDJSON for true crashes.** NDJSON assumes the process can still write structured JSON on the way out. For native crashes (segfaults in Electron's main process), a minidump-style format survives better. Add to open questions.
3. **Warp's `contains_ugc()` flag is the cleanest answer to the "what if an event sometimes carries UGC" question our two-lane split can't gracefully handle.** Not blocking for v1 — our events don't blur — but the trait is a pattern to reach for if we ever grow one that does.
4. **VS Code's cascade (`enableCrashReporter=false ⇒ all telemetry off`) is a philosophical inversion of ours.** Their model: the less-invasive signal should not outlive the more-invasive one. Ours: the two lanes are independent and the user can kill either. Worth documenting *why* we chose independence — the Mode 1 local file doesn't leave the machine, so turning it off to disable product telemetry would be a UX trap.
5. **The drift problem (open-vibe-island) is not just about code discipline — it's about build pipeline discipline.** Whatever redactor we ship needs a CI check that fails if a span attribute key matches the blocklist at build time. Without that, "we don't send PII" is a claim that decays the moment someone adds a new attribute and forgets. Add to open questions.

## Sources

- T3 Code observability implementation: `/Users/thebr/source/repos/public/t3code/apps/server/src/observability/` (verified 2026-05-01). Span exit shape at `TraceRecord.ts:35-46`.
- T3 Code user-facing docs: `/Users/thebr/source/repos/public/t3code/docs/observability.md`.
- T3 Code absence of error events in product schema: `grep -n "analytics.record" /Users/thebr/source/repos/public/t3code/apps/server/src/**/*.ts` → 9 call sites, none carrying error strings. Transport at `apps/server/src/telemetry/Layers/AnalyticsService.ts`.
- Ghostty local crash reporter: `/Users/thebr/source/repos/public/ghostty/README.md:189-226`. Sentry envelope format, `$XDG_STATE_HOME/ghostty/crash`, opt-in upload via `sentry-cli send-envelope`.
- Warp `contains_ugc()` flag on `TelemetryEvent` trait: `/Users/thebr/source/repos/public/warp/crates/warp_core/src/telemetry.rs:29-61,165,194`. Dual-write-key routing based on per-event flag.
- cmux Sentry setup: `/Users/thebr/source/repos/public/cmux/Sources/AppDelegate.swift:1010-1040` (`attachStacktrace: true`, `appHangTimeoutInterval: 8.0`, `tracesSampleRate: 0.1`). Breadcrumb call sites in `Sources/SentryHelper.swift`, `Sources/TerminalController.swift`. PostHog-only lane verified at `Sources/PostHogAnalytics.swift` (two daily/hourly active events).
- VS Code telemetry-level cascade and crash-reporter separation: `/Users/thebr/source/repos/public/vscode/src/vs/platform/telemetry/common/telemetryUtils.ts:135-159`.
- emdash `$exception` capture: `/Users/thebr/source/repos/public/emdash/src/main/lib/telemetry.ts:381-395`. Heartbeat crash detection at lines 299, 319-343.
- superset-sh `sendDefaultPii: true`: `/Users/thebr/source/repos/public/superset/apps/web/sentry.server.config.ts:11`.
- open-vibe-island policy/implementation drift: README claim at `/Users/thebr/source/repos/public/open-vibe-island/README.md:46` vs bundle analysis at `/Users/thebr/source/repos/public/open-vibe-island/docs/installed-app-bundle-analysis.md:46,290-292`.
- Wave Terminal two-channel toggle: included here only as an architectural precedent for separate controls.
- Grafana LGTM single-container stack: `grafana/otel-lgtm` Docker image, referenced in T3 Code's `docs/observability.md` §"Run With A Local LGTM Stack".
