import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from './keychain'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-claude-service-test'
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: () => 'claude'
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function createService(): unknown {
  return {}
}

async function readCapturedCredentials(
  configDir: string,
  previousLegacyKeychain: string | null
): Promise<string | null> {
  const { ClaudeAccountService } = await import('./service')
  const service = new ClaudeAccountService(
    createService() as never,
    createService() as never,
    createService() as never
  )
  return (
    service as unknown as {
      readCapturedCredentials(
        configDir: string,
        previousLegacyKeychain: string | null
      ): Promise<string | null>
    }
  ).readCapturedCredentials(configDir, previousLegacyKeychain)
}

describe('ClaudeAccountService credential capture', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('darwin')
    tempDir = null
    vi.mocked(readActiveClaudeKeychainCredentials).mockReset()
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockReset()
    vi.mocked(deleteActiveClaudeKeychainCredentialsStrict).mockClear()
    vi.mocked(writeActiveClaudeKeychainCredentials).mockReset()
    vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('accepts scoped Keychain capture even when it matches the previous legacy item', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce('same-account')
      .mockResolvedValueOnce('same-account')

    await expect(readCapturedCredentials('/tmp/claude-config', 'same-account')).resolves.toBe(
      'same-account'
    )

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith('/tmp/claude-config')
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
  })

  it('rejects unchanged legacy fallback when scoped capture is missing', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('previous')

    await expect(readCapturedCredentials('/tmp/claude-config', 'previous')).resolves.toBeNull()

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(
      1,
      '/tmp/claude-config'
    )
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2)
  })

  it('accepts changed legacy fallback for old Claude Code builds', async () => {
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('new-legacy')

    await expect(readCapturedCredentials('/tmp/claude-config', 'previous')).resolves.toBe(
      'new-legacy'
    )

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(
      1,
      '/tmp/claude-config'
    )
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2)
  })

  it('falls back to captured credentials file on macOS', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-capture-'))
    writeFileSync(join(tempDir, '.credentials.json'), '{"token":"file"}\n', 'utf-8')
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('previous')

    await expect(readCapturedCredentials(tempDir, 'previous')).resolves.toBe('{"token":"file"}\n')
  })

  it('fails login capture when legacy Keychain cleanup fails', async () => {
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue('previous-legacy')
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue('captured-scoped')
    vi.mocked(writeActiveClaudeKeychainCredentials).mockRejectedValue(new Error('restore failed'))
    const { ClaudeAccountService } = await import('./service')
    const service = new ClaudeAccountService(
      createService() as never,
      createService() as never,
      createService() as never
    )
    const testService = service as unknown as {
      runClaudeCommand: () => Promise<string>
      runClaudeLoginAndCapture(): Promise<{ credentialsJson: string }>
    }
    testService.runClaudeCommand = vi.fn(async () => '{"account":{"email":"user@example.com"}}')

    await expect(testService.runClaudeLoginAndCapture()).rejects.toThrow('restore failed')
  })
})
