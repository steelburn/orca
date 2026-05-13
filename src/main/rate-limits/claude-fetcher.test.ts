import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { readActiveClaudeKeychainCredentials } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const { netFetchMock, readFileMock, resolveProxyMock, setProxyMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('electron', () => ({
  net: {
    fetch: netFetchMock
  },
  session: {
    defaultSession: {
      resolveProxy: resolveProxyMock,
      setProxy: setProxyMock
    }
  }
}))

vi.mock('./claude-pty', () => ({
  fetchViaPty: vi.fn()
}))

vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentials: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

describe('fetchClaudeRateLimits', () => {
  beforeEach(() => {
    setPlatform('darwin')
    vi.clearAllMocks()
    readFileMock.mockRejectedValue(new Error('missing file'))
    resolveProxyMock.mockResolvedValue('DIRECT')
    netFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 }
        }),
        { status: 200 }
      )
    )
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads scoped default-config Keychain credentials for OAuth usage fetches', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentials).toHaveBeenCalledWith(configDir)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token'
        })
      })
    )
  })

  it('falls back to the credentials file when Keychain access fails', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValue(new Error('Keychain locked'))
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok'
    })

    expect(readFileMock).toHaveBeenCalledWith('/Users/test/.claude/.credentials.json', 'utf-8')
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer file-oauth-token'
        })
      })
    )
  })
})
