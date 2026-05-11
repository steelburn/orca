// Bundle collection tests — focused on the data-shape contracts. The HTTP
// upload path is exercised by integration tests against a real or mocked
// server endpoint and is intentionally out of scope here.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectBundle, generateBundleSubmissionId, validateUploadUrl } from './bundle'

let dir: string
let traceFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bundle-'))
  traceFile = join(dir, 'main.trace.ndjson')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeNDJSON(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
}

function makeSpan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = BigInt(Date.now()) * 1_000_000n
  return {
    type: 'effect-span',
    name: 'test',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: String(now - 1_000_000_000n),
    endTimeUnixNano: String(now),
    durationMs: 1.0,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}

describe('bundle — submission ID', () => {
  it('is base64url, 22 chars (128 bits)', () => {
    const id = generateBundleSubmissionId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
  it('is unique across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateBundleSubmissionId())
    }
    expect(ids.size).toBe(100)
  })
})

describe('bundle — collection', () => {
  it('emits a header line with bundle_submission_id, app_version, platform', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.0.0',
      orcaChannel: 'dev'
    })
    const lines = bundle.payload.split('\n').filter(Boolean)
    const header = JSON.parse(lines[0])
    expect(header.type).toBe('bundle-header')
    expect(header.bundle_submission_id).toBe(bundle.bundleSubmissionId)
    expect(header.app_version).toBe('1.2.3')
    expect(header.platform).toBe('darwin')
    expect(header.arch).toBe('arm64')
    expect(header.orca_channel).toBe('dev')
    expect(header.schema_version).toBe(1)
  })

  it('NEVER carries install_id in the header (Issue 8)', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan()]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    const header = JSON.parse(bundle.payload.split('\n')[0])
    expect(header).not.toHaveProperty('install_id')
    expect(header).not.toHaveProperty('installId')
    expect(header).not.toHaveProperty('distinct_id')
  })

  it('reads spans from the rotated family', () => {
    writeFileSync(traceFile, makeNDJSON([makeSpan({ name: 'a' })]))
    writeFileSync(`${traceFile}.1`, makeNDJSON([makeSpan({ name: 'b' })]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.spanCount).toBe(2)
  })

  it('drops spans older than the lookback window', () => {
    const oldNanos = BigInt(Date.now() - 60 * 60 * 1000) * 1_000_000n // 1h ago
    writeFileSync(
      traceFile,
      makeNDJSON([
        makeSpan({ name: 'recent' }),
        makeSpan({
          name: 'old',
          startTimeUnixNano: String(oldNanos - 1n),
          endTimeUnixNano: String(oldNanos)
        })
      ])
    )
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    // Header + recent only.
    expect(bundle.spanCount).toBe(1)
    expect(bundle.payload).toContain('"name":"recent"')
    expect(bundle.payload).not.toContain('"name":"old"')
  })

  it('runs the redactor on the merged payload (belt-and-suspenders)', () => {
    // Simulate a sink-write bug that leaked a secret through. The bundle
    // pass should still strip it.
    const span = makeSpan({
      attributes: {
        // raw secret embedded in serialized form — bypass the API surface.
        leaked: `sk-ant-api03-${'a'.repeat(50)}`
      }
    })
    writeFileSync(traceFile, makeNDJSON([span]))
    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })
    expect(bundle.payload).not.toContain('sk-ant-api03-aaaaa')
    expect(bundle.payload).toContain('[redacted:anthropic-key]')
  })

  it('skips malformed (non-JSON) lines without throwing', () => {
    writeFileSync(traceFile, [JSON.stringify(makeSpan()), 'not json', ''].join('\n'))
    expect(() =>
      collectBundle({
        traceFilePath: traceFile,
        maxFiles: 10,
        appVersion: '1',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '24',
        orcaChannel: 'dev'
      })
    ).not.toThrow()
  })
})

describe('validateUploadUrl', () => {
  it('allows https upload_url when tokenEndpoint is https', () => {
    expect(() =>
      validateUploadUrl('https://api.example.com/upload', 'https://api.example.com/token')
    ).not.toThrow()
  })

  it('rejects http upload_url when tokenEndpoint is https (mixed scheme)', () => {
    expect(() =>
      validateUploadUrl('http://api.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must use https/)
  })

  it('allows http upload_url when tokenEndpoint is http (localhost dev)', () => {
    expect(() =>
      validateUploadUrl('http://localhost:8080/upload', 'http://localhost:8080/token')
    ).not.toThrow()
  })

  it('rejects an unparseable upload_url', () => {
    expect(() => validateUploadUrl('not a url', 'https://api.example.com/token')).toThrow(
      /invalid upload_url/
    )
  })

  it('rejects a mismatched host even when both are https (same-origin pin)', () => {
    expect(() =>
      validateUploadUrl('https://attacker.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must match tokenEndpoint host/)
  })

  it('rejects a non-http(s) scheme like file://', () => {
    expect(() => validateUploadUrl('file:///tmp/upload', 'https://api.example.com/token')).toThrow(
      /must use https/
    )
  })
})
