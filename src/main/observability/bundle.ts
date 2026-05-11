// Diagnostic bundle collection + upload (Mode 3 from
// telemetry-error-tracking.md). The single user-initiated network path from
// the error-tracking lane to Orca infrastructure. Every step here implements
// a hardening requirement from §Endpoint contract — the comments name the
// requirement number when they apply.
//
// Lifecycle:
//   1. `collectBundle()` — read the last N minutes of NDJSON across the
//      rotated family, run the redactor a second time over the merged
//      payload (belt-and-suspenders), embed the per-bundle
//      `bundle_submission_id`. NEVER carries `install_id` (Issue 8 in the
//      security review).
//   2. (renderer) — preview the bundle as plain text in an editable window.
//      User can edit, copy, or cancel. Out of this module's scope; the IPC
//      surface in `ipc/diagnostics.ts` exposes `previewBundle`/`uploadBundle`.
//   3. `uploadBundle()` — two-step:
//      a) POST `/diagnostics/token` → token + upload_url
//      b) POST `<upload_url>` with `Authorization: Bearer <token>` and the
//         (possibly user-edited) NDJSON payload. Returns ticket ID.
//   4. (renderer) — surface the ticket ID; offer "Copy ticket" and
//      "Delete this bundle" controls.
//
// Server-side endpoint contract is fully specified in
// telemetry-error-tracking.md §Endpoint contract. Implementation of those
// endpoints (token issuance, rate limit, storage, server-side redaction,
// retention, deletion) is operational TBD — flagged as an open question to
// the human dispatching this task. We ship the *client* of that contract
// with all hardening invariants the client controls (single retry, content-
// type pinning, body-size cap on upload, token-handling discipline).

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { listRotatedFiles } from './local-file-sink'
import { redactString } from './redactor'

const DEFAULT_LOOKBACK_MINUTES = 30
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024 // 10 MB — matches §Endpoint contract item 3
const TOKEN_REQUEST_TIMEOUT_MS = 10_000
const UPLOAD_TIMEOUT_MS = 30_000

export type CollectBundleOptions = {
  readonly traceFilePath: string
  readonly maxFiles: number
  readonly lookbackMinutes?: number
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  readonly osRelease: string
  readonly orcaChannel: 'stable' | 'rc' | 'dev'
}

export type CollectedBundle = {
  /** 128-bit unguessable random ID, base64url. NOT the install_id —
   *  bundles are deliberately join-incompatible with the PostHog lane. */
  readonly bundleSubmissionId: string
  /** UTF-8 NDJSON payload — header line + N redacted span lines. */
  readonly payload: string
  /** Byte length of `payload`. Pre-checked against the 10 MB upload cap. */
  readonly bytes: number
  /** Span-line count, for the preview window's "N spans" label. */
  readonly spanCount: number
}

type BundleHeader = {
  readonly bundle_submission_id: string
  readonly app_version: string
  readonly platform: string
  readonly arch: string
  readonly os_release: string
  readonly orca_channel: 'stable' | 'rc' | 'dev'
  readonly collected_at: string
  readonly schema_version: 1
}

/**
 * Read the last N minutes of NDJSON across the rotated family and produce
 * a redacted bundle payload. Caller renders this as the preview text;
 * `uploadBundle()` ships whatever bytes the user confirms (which may be
 * the original or an edited form — we trust the user's edits, the server-
 * side redactor is the final guarantee).
 */
export function collectBundle(opts: CollectBundleOptions): CollectedBundle {
  const lookbackMs = (opts.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000
  const cutoffNanos = BigInt(Date.now() - lookbackMs) * 1_000_000n
  const bundleSubmissionId = generateBundleSubmissionId()
  const header: BundleHeader = {
    bundle_submission_id: bundleSubmissionId,
    app_version: opts.appVersion,
    platform: opts.platform,
    arch: opts.arch,
    os_release: opts.osRelease,
    orca_channel: opts.orcaChannel,
    collected_at: new Date().toISOString(),
    schema_version: 1
  }

  const headerLine = JSON.stringify({ type: 'bundle-header', ...header })
  const lines: string[] = [headerLine]
  let spanCount = 0
  // Running byte counter for the eventual `lines.join('\n')` payload.
  // Starts with the header's byte length; each pushed line adds its own
  // length plus 1 for the newline separator that will join it. Avoids
  // re-running `lines.join('\n').length` every iteration — that's O(N²)
  // in span count and dominates collection time for large backlogs (F5).
  let currentBytes = Buffer.byteLength(headerLine)

  // Files from listRotatedFiles are newest → oldest. Reading newest first
  // means the cutoff filter naturally bounds our work — once we hit a span
  // older than the cutoff in an older file we can stop entirely. We don't
  // optimize that yet; the worst case (10 × 10 MB = 100 MB scan) takes
  // <1 s on a modern SSD and bundles are user-initiated, not hot-path.
  const files = listRotatedFiles(opts.traceFilePath, opts.maxFiles)
  outer: for (const file of files) {
    let text: string
    try {
      // statSync first to skip absurdly-large files defensively. The sink
      // caps at 10 MB per file; a tampered file could theoretically be
      // bigger, in which case we want to abort the bundle rather than
      // panic-allocate.
      const size = statSync(file).size
      if (size > 50 * 1024 * 1024) {
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // NDJSON parsing — one record per line. Skip malformed lines silently;
    // a partial-write at process crash time can leave a half-line.
    for (const raw of text.split('\n')) {
      if (raw.length === 0) {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const record = parsed as { startTimeUnixNano?: string; endTimeUnixNano?: string }
      // Filter by end-time, not start-time. A long-lived span started 35
      // minutes ago but ending inside the lookback is exactly what we want
      // in the bundle for diagnosing "session crashed at minute 32."
      if (typeof record.endTimeUnixNano === 'string') {
        try {
          if (BigInt(record.endTimeUnixNano) < cutoffNanos) {
            continue
          }
        } catch {
          // Non-numeric end-time — keep it; better to over-include than to
          // drop a record we couldn't classify.
        }
      }

      // Run the redactor a SECOND TIME over the serialized bytes. This is the
      // §Endpoint contract belt-and-suspenders. The sink-write pass already
      // redacted; this catches anything that slipped through (a future bug
      // in the sink path) before the user's eyes hit the preview window.
      const redacted = redactString(raw)
      lines.push(redacted)
      spanCount += 1
      // +1 accounts for the '\n' that `lines.join('\n')` will insert before
      // this line in the final payload.
      currentBytes += Buffer.byteLength(redacted) + 1
      if (currentBytes > MAX_BUNDLE_BYTES) {
        // Hard ceiling at the same 10 MB the upload endpoint enforces (F4).
        // Previously we collected up to 20 MB so the user could preview a
        // bundle the server would reject — confusing UX. Now the preview
        // matches what'll actually ship; the trailing '\n' added at payload
        // assembly is a single byte of slack absorbed by the cap.
        break outer
      }
    }
  }

  const payload = `${lines.join('\n')}\n`
  return {
    bundleSubmissionId,
    payload,
    bytes: Buffer.byteLength(payload),
    spanCount
  }
}

// ── Upload (two-step) ────────────────────────────────────────────────────

export type UploadBundleOptions = {
  /** Server endpoint that issues short-lived tokens. From a build-time
   *  constant or a user-set env var (developer mode). */
  readonly tokenEndpoint: string
  /** Already-collected payload bytes the user confirmed in the preview. */
  readonly payload: string
  readonly bundleSubmissionId: string
}

export type UploadBundleResult = {
  readonly ticketId: string
}

type TokenResponse = {
  readonly token: string
  readonly expires_at: string
  readonly upload_url: string
  readonly max_bytes: number
}

type UploadResponse = {
  readonly ticket_id: string
}

/**
 * Two-step upload per §Endpoint contract item 1. Failures throw an Error
 * with a human-readable message — the IPC handler in `ipc/diagnostics.ts`
 * surfaces them in the renderer toast.
 */
export async function uploadBundle(opts: UploadBundleOptions): Promise<UploadBundleResult> {
  const bytes = Buffer.byteLength(opts.payload)
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(`bundle exceeds 10 MB cap (${bytes} bytes)`)
  }

  // (1) Request a token. The token endpoint is rate-limited per IP at the
  // edge (≤10/hour). A failure here typically means the user has hit the
  // rate limit or the network is offline.
  const tokenRes = (await postJsonForJson(
    opts.tokenEndpoint,
    {
      bundle_submission_id: opts.bundleSubmissionId,
      bytes
    },
    TOKEN_REQUEST_TIMEOUT_MS
  )) as TokenResponse
  if (
    typeof tokenRes.token !== 'string' ||
    typeof tokenRes.upload_url !== 'string' ||
    typeof tokenRes.max_bytes !== 'number'
  ) {
    throw new Error('malformed token response')
  }
  if (bytes > tokenRes.max_bytes) {
    throw new Error(`bundle exceeds server-issued cap (${bytes} > ${tokenRes.max_bytes})`)
  }

  // Validate `upload_url` BEFORE we send the bearer token + user data to it.
  // A misconfigured or compromised token endpoint could otherwise redirect
  // the upload (with the bearer token and the user's NDJSON payload) to an
  // attacker-controlled host. We require https in production and only relax
  // to http when the configured tokenEndpoint is itself non-https — i.e.
  // localhost dev. (F2 in the security review.)
  validateUploadUrl(tokenRes.upload_url, opts.tokenEndpoint)

  // (2) Upload using the bearer token. `Content-Type: application/x-ndjson`
  // matches the §Endpoint contract item 4 allow-list. The server rejects
  // any other content-type at the edge.
  const uploadRes = (await postBodyForJson(
    tokenRes.upload_url,
    opts.payload,
    {
      authorization: `Bearer ${tokenRes.token}`,
      'content-type': 'application/x-ndjson',
      'content-length': String(bytes)
    },
    UPLOAD_TIMEOUT_MS
  )) as UploadResponse

  if (typeof uploadRes.ticket_id !== 'string' || uploadRes.ticket_id.length === 0) {
    throw new Error('malformed upload response: missing ticket_id')
  }
  return { ticketId: uploadRes.ticket_id }
}

// ── Bundle submission ID ─────────────────────────────────────────────────

/**
 * 128-bit cryptographic random, URL-safe base64. Generated per bundle —
 * NOT persisted. A user submitting two bundles produces two unrelated IDs.
 * This is the primary structural mitigation for Issue 8 (bundle ↔
 * install_id correlation).
 */
export function generateBundleSubmissionId(): string {
  // 16 bytes = 128 bits → base64url is 22 chars (no padding). Matches the
  // §Endpoint contract requirement that ticket IDs be unguessable and
  // non-enumerable; we use the same shape for the submission ID.
  return randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ── Upload URL validation ────────────────────────────────────────────────

/**
 * Reject an `upload_url` returned by the token endpoint that we can't safely
 * POST a bearer token + the user's diagnostic payload to. Exists because the
 * upload destination is chosen by the server response, not pinned at build
 * time — without this gate, a misconfigured or compromised token endpoint
 * could exfiltrate bundles to an attacker-controlled host. (F2.)
 *
 * Rules:
 *  - Must parse as a URL.
 *  - Must use https:, EXCEPT when the configured `tokenEndpoint` is itself
 *    non-https (localhost / dev). Mixing http upload with https token
 *    issuance is never allowed in production.
 *  - Host must match the configured `tokenEndpoint` host. This is the
 *    same-origin pin from the F2 fix: even if the scheme is https, a
 *    compromised or misconfigured token endpoint could otherwise direct
 *    the upload to an attacker-controlled HTTPS host that has a valid
 *    certificate. Pinning to the token endpoint's host means the bearer
 *    token + user payload only ever go to the host the user already
 *    trusted enough to ask for a token from.
 */
export function validateUploadUrl(uploadUrl: string, tokenEndpoint: string): void {
  let parsedUpload: URL
  try {
    parsedUpload = new URL(uploadUrl)
  } catch {
    throw new Error(`invalid upload_url from token endpoint: ${uploadUrl}`)
  }
  let parsedToken: URL
  try {
    parsedToken = new URL(tokenEndpoint)
  } catch {
    throw new Error(`invalid tokenEndpoint configuration: ${tokenEndpoint}`)
  }
  const tokenIsHttps = parsedToken.protocol === 'https:'
  if (tokenIsHttps && parsedUpload.protocol !== 'https:') {
    throw new Error(
      `upload_url must use https when tokenEndpoint is https (got ${parsedUpload.protocol}//${parsedUpload.host})`
    )
  }
  if (parsedUpload.protocol !== 'https:' && parsedUpload.protocol !== 'http:') {
    throw new Error(`upload_url must use http(s) (got ${parsedUpload.protocol})`)
  }
  // Same-origin host pin. Defends against a compromised token endpoint that
  // returns a valid-https upload_url pointing at an attacker-controlled host
  // (a certificate alone proves nothing about who the operator is). We only
  // ship the bearer token + user payload to the host the user already
  // trusted by virtue of the configured tokenEndpoint.
  if (parsedUpload.host !== parsedToken.host) {
    throw new Error(
      `upload_url host (${parsedUpload.host}) must match tokenEndpoint host (${parsedToken.host})`
    )
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

function postJsonForJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  return postRaw(
    url,
    JSON.stringify(body),
    {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    timeoutMs
  )
}

function postBodyForJson(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  return postRaw(url, body, { ...headers, accept: 'application/json' }, timeoutMs)
}

function postRaw(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const protocol = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = protocol(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          if (status >= 200 && status < 300) {
            try {
              resolve(text.length > 0 ? JSON.parse(text) : {})
            } catch {
              reject(new Error(`malformed JSON response (HTTP ${status})`))
            }
          } else {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('upload timeout'))
    })
    req.write(body)
    req.end()
  })
}

// Test-only export.
export const _internalsForTests = {
  MAX_BUNDLE_BYTES
}
