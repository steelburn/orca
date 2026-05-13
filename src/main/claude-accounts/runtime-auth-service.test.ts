/* eslint-disable max-lines -- test suite covers Claude runtime auth refresh, identity guards, and snapshot restore cases */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const testState = {
  userDataDir: '',
  fakeHomeDir: '',
  activeKeychainCredentials: null as string | null,
  scopedKeychainCredentials: null as string | null,
  legacyKeychainCredentials: null as string | null,
  throwScopedKeychainRead: false,
  throwLegacyKeychainRead: false,
  throwRuntimeKeychainWrite: false,
  throwScopedKeychainWrite: false,
  runtimeWriteConfigDir: null as string | null,
  managedKeychainCredentials: new Map<string, string>()
}

function expectedRuntimeConfigDir(): string {
  return join(testState.fakeHomeDir, '.claude')
}

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => ({
  readActiveClaudeKeychainCredentials: vi.fn(async (configDir?: string) => {
    if (configDir) {
      if (configDir !== expectedRuntimeConfigDir()) {
        return testState.legacyKeychainCredentials
      }
      return testState.scopedKeychainCredentials ?? testState.legacyKeychainCredentials
    }
    return testState.legacyKeychainCredentials
  }),
  writeActiveClaudeKeychainCredentials: vi.fn(async (contents: string, configDir?: string) => {
    if (configDir) {
      if (configDir !== expectedRuntimeConfigDir()) {
        throw new Error(`Unexpected Claude config dir: ${configDir}`)
      }
      if (testState.throwScopedKeychainWrite) {
        throw new Error('scoped keychain write failed')
      }
      testState.scopedKeychainCredentials = contents
    } else {
      testState.legacyKeychainCredentials = contents
    }
    testState.activeKeychainCredentials = contents
  }),
  deleteActiveClaudeKeychainCredentials: vi.fn(async () => {
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    testState.activeKeychainCredentials = null
  }),
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) => {
    if (configDir) {
      if (configDir !== expectedRuntimeConfigDir()) {
        throw new Error(`Unexpected Claude config dir: ${configDir}`)
      }
      testState.scopedKeychainCredentials = null
    } else {
      testState.legacyKeychainCredentials = null
    }
    testState.activeKeychainCredentials = null
  }),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async (configDir?: string) =>
    configDir
      ? (() => {
          if (testState.throwScopedKeychainRead) {
            throw new Error('scoped keychain read failed')
          }
          return configDir === expectedRuntimeConfigDir()
            ? testState.scopedKeychainCredentials
            : null
        })()
      : (() => {
          if (testState.throwLegacyKeychainRead) {
            throw new Error('legacy keychain read failed')
          }
          return testState.legacyKeychainCredentials
        })()
  ),
  writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(
    async (contents: string, configDir: string) => {
      if (configDir !== expectedRuntimeConfigDir()) {
        throw new Error(`Unexpected Claude config dir: ${configDir}`)
      }
      if (testState.throwRuntimeKeychainWrite) {
        throw new Error('runtime keychain write failed')
      }
      testState.runtimeWriteConfigDir = configDir
      testState.scopedKeychainCredentials = contents
      testState.legacyKeychainCredentials = contents
      testState.activeKeychainCredentials = contents
    }
  ),
  readManagedClaudeKeychainCredentials: vi.fn(
    async (accountId: string) => testState.managedKeychainCredentials.get(accountId) ?? null
  ),
  writeManagedClaudeKeychainCredentials: vi.fn(async (accountId: string, contents: string) => {
    testState.managedKeychainCredentials.set(accountId, contents)
  })
}))

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(testState.fakeHomeDir),
    ...overrides
  }
}

function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = {
        ...settings,
        ...updates,
        notifications: {
          ...settings.notifications,
          ...updates.notifications
        }
      }
      return settings
    })
  }
}

function createManagedClaudeAuth(
  rootDir: string,
  accountId: string,
  credentialsJson: string,
  oauthAccountJson = `{"accountUuid":"${accountId}"}\n`
): string {
  const managedAuthPath = join(rootDir, 'claude-accounts', accountId, 'auth')
  mkdirSync(managedAuthPath, { recursive: true })
  writeFileSync(join(managedAuthPath, '.credentials.json'), credentialsJson, 'utf-8')
  writeFileSync(join(managedAuthPath, 'oauth-account.json'), oauthAccountJson, 'utf-8')
  testState.managedKeychainCredentials.set(accountId, credentialsJson)
  return managedAuthPath
}

function createClaudeAccount(
  id: string,
  managedAuthPath: string,
  overrides: Partial<ClaudeManagedAccount> = {}
): ClaudeManagedAccount {
  return {
    id,
    email: 'user@example.com',
    managedAuthPath,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function createClaudeCredentialsJson(
  email: string,
  accessToken: string,
  organizationUuid: string | null = null,
  expiresAt = Date.now() + 60_000
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      email,
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt
    }
  })}\n`
}

function createClaudeCredentialsWithoutEmail(
  accessToken: string,
  organizationUuid: string | null = null
): string {
  return `${JSON.stringify({
    claudeAiOauth: {
      ...(organizationUuid ? { organizationUuid } : {}),
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt: Date.now() + 60_000
    }
  })}\n`
}

function readManagedCredentialsForTest(accountId: string, managedAuthPath: string): string | null {
  if (process.platform === 'darwin') {
    return testState.managedKeychainCredentials.get(accountId) ?? null
  }
  return readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')
}

function readRuntimeOauthAccountForTest(): unknown {
  const configPath = join(testState.fakeHomeDir, '.claude.json')
  if (!existsSync(configPath)) {
    return null
  }
  return (
    (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>).oauthAccount ?? null
  )
}

describe('ClaudeRuntimeAuthService', () => {
  beforeEach(() => {
    setPlatform('darwin')
    vi.resetModules()
    vi.clearAllMocks()
    testState.activeKeychainCredentials = null
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    testState.throwScopedKeychainRead = false
    testState.throwLegacyKeychainRead = false
    testState.throwRuntimeKeychainWrite = false
    testState.throwScopedKeychainWrite = false
    testState.runtimeWriteConfigDir = null
    testState.managedKeychainCredentials.clear()
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-claude-runtime-'))
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-home-'))
    mkdirSync(join(testState.fakeHomeDir, '.claude'), { recursive: true })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(testState.userDataDir, { recursive: true, force: true })
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  })

  it('rematerializes unchanged managed credentials when the runtime file is missing', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      '{"token":"managed"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe('{"token":"managed"}\n')

    rmSync(runtimeCredentialsPath, { force: true })
    await service.prepareForClaudeLaunch()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe('{"token":"managed"}\n')
    expect(testState.runtimeWriteConfigDir).toBe(expectedRuntimeConfigDir())
  })

  it('removes runtime credentials when deselecting with a missing system-default snapshot', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    writeFileSync(runtimeCredentialsPath, '{"token":"managed"}\n', 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      '{"token":"managed"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBeNull()
      expect(testState.legacyKeychainCredentials).toBeNull()
    }
  })

  it('falls back to atomic write when the unchanged check cannot read the target', async () => {
    if (process.platform === 'win32') {
      return
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      '{"token":"managed"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    testState.managedKeychainCredentials.set('account-1', '{"token":"rotated"}\n')
    writeFileSync(join(managedAuthPath, '.credentials.json'), '{"token":"rotated"}\n', 'utf-8')
    chmodSync(runtimeCredentialsPath, 0o000)
    try {
      await service.syncForCurrentSelection()
    } finally {
      if (existsSync(runtimeCredentialsPath)) {
        chmodSync(runtimeCredentialsPath, 0o600)
      }
      warn.mockRestore()
    }

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe('{"token":"rotated"}\n')
  })

  it('tightens credential file permissions when unchanged content is already present', async () => {
    if (process.platform === 'win32') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      '{"token":"managed"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    chmodSync(runtimeCredentialsPath, 0o644)
    await service.syncForCurrentSelection()

    expect(statSync(runtimeCredentialsPath).mode & 0o777).toBe(0o600)
  })

  it('reads back refreshed credentials when the Claude identity still matches', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
  })

  it('reads back verified same-account credentials on first sync after restart', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'original',
      null,
      1_000
    )
    const refreshedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'refreshed',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
  })

  it('rejects older same-account Claude credentials on first sync after restart', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const staleRuntimeCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'stale',
      null,
      1_000
    )
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed-newer',
      null,
      2_000
    )
    writeFileSync(runtimeCredentialsPath, staleRuntimeCredentials, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(managedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
  })

  it('rejects runtime read-back from a different Claude identity', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('other@example.com', 'stale')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedCredentials)
  })

  it('rejects runtime read-back from the same Claude email in a different organization', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-b' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedCredentials)
  })

  it('rejects same-email Claude read-back using stored managed organization identity', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedCredentials)
  })

  it('rejects same-email Claude read-back using stored oauth-account organization identity', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials,
      '{"organizationUuid":"org-b"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedCredentials)
  })

  it('rejects no-email Claude read-back when organization identity conflicts', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const selectedCredentials = createClaudeCredentialsJson('user@example.com', 'selected', 'org-b')
    const staleCredentials = createClaudeCredentialsWithoutEmail('stale', 'org-a')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { organizationUuid: 'org-b' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(selectedCredentials)
  })

  it('rejects unverifiable refreshed runtime credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsWithoutEmail('original')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(originalCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(originalCredentials)
  })

  it('restores the system default after rejecting unverifiable managed credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const originalCredentials = createClaudeCredentialsWithoutEmail('original')
    const refreshedCredentials = createClaudeCredentialsWithoutEmail('refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('restores system default after same-identity managed Claude refresh on deselect', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed', 'org-1')
    const externalCredentials = createClaudeCredentialsJson('user@example.com', 'external', 'org-1')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, {
          organizationUuid: 'org-1'
        })
      ]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(externalCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
  })

  it('preserves external stale Claude credentials without writing them to managed storage', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const selectedCredentials = createClaudeCredentialsJson('selected@example.com', 'selected')
    const staleCredentials = createClaudeCredentialsJson('stale@example.com', 'stale')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      selectedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, { email: 'selected@example.com' })
      ]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, staleCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(selectedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(staleCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not persist unverifiable stale Claude credentials into another active account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const staleUnverifiableCredentials = createClaudeCredentialsWithoutEmail('stale')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, staleUnverifiableCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('does not carry the reauth read-back skip across Claude account switches', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const account2RefreshedCredentials = createClaudeCredentialsJson(
      'two@example.com',
      'two-refreshed'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    service.clearLastWrittenCredentialsJson()
    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account2RefreshedCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(
      account2RefreshedCredentials
    )
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2RefreshedCredentials)
  })

  it('does not apply inactive-account Claude reauth skip to the active account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Credentials = createClaudeCredentialsJson('one@example.com', 'one')
    const account1RefreshedCredentials = createClaudeCredentialsJson(
      'one@example.com',
      'one-refreshed'
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Credentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account1RefreshedCredentials, 'utf-8')
    service.clearLastWrittenCredentialsJson('account-2')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(
      account1RefreshedCredentials
    )
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account1RefreshedCredentials)
  })

  it('keeps external Claude logout when deselecting managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    rmSync(runtimeCredentialsPath, { force: true })
    testState.activeKeychainCredentials = null
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('reads back refreshed active keychain credentials on macOS', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
  })

  it('reads back refreshed legacy keychain credentials on old Claude Code builds', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = originalCredentials
    testState.legacyKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(refreshedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(refreshedCredentials)
  })

  it('restores system default when mismatched Claude keychain auth appears before deselect', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalKeychainCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    testState.scopedKeychainCredentials = externalKeychainCredentials
    testState.legacyKeychainCredentials = externalKeychainCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalKeychainCredentials)
    expect(testState.legacyKeychainCredentials).toBe(externalKeychainCredentials)
  })

  it('restores unchanged scoped keychain while preserving external legacy keychain logout', async () => {
    if (process.platform !== 'darwin') {
      return
    }

    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    testState.legacyKeychainCredentials = null
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('preserves external scoped keychain login while restoring unchanged legacy keychain', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalScopedCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { readActiveClaudeKeychainCredentials } = await import('./keychain')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    expect(readActiveClaudeKeychainCredentials).toHaveBeenCalledWith(expectedRuntimeConfigDir())

    testState.scopedKeychainCredentials = externalScopedCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalScopedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('preserves external oauth metadata while restoring owned credentials', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    const externalOauthAccount = { accountUuid: 'external-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: externalOauthAccount })}\n`,
      'utf-8'
    )
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(externalOauthAccount)
  })

  it('restores owned oauth metadata when external credentials change but metadata does not', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(externalCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('uses managed credentials as ownership baseline after restart with partial external changes', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalScopedCredentials = createClaudeCredentialsJson(
      'external@example.com',
      'external'
    )
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: null,
        keychainCredentialsJson: systemCredentials,
        scopedKeychainCredentialsJson: systemCredentials,
        legacyKeychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = externalScopedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalScopedCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('preserves external file and scoped login while restoring unchanged legacy keychain', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const externalCredentials = createClaudeCredentialsJson('external@example.com', 'external')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, externalCredentials, 'utf-8')
    testState.scopedKeychainCredentials = externalCredentials
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(externalCredentials)
    expect(testState.scopedKeychainCredentials).toBe(externalCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('restores legacy keychain credentials from old system-default snapshots', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: systemCredentials,
        configOauthAccount: null,
        keychainCredentialsJson: systemCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not recapture managed file as system default after a partial keychain write failure', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    testState.throwRuntimeKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('runtime keychain write failed')

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(managedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    testState.throwRuntimeKeychainWrite = false
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('keeps managed ownership baseline when keychain restore fails and retries', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    testState.throwScopedKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain write failed')

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
    testState.throwScopedKeychainWrite = false
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
  })

  it('does not enter managed mode when keychain snapshot capture fails', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    testState.throwScopedKeychainRead = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow(
      'Cannot capture current Claude Keychain credentials'
    )

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(testState.scopedKeychainCredentials).toBe(systemCredentials)
    expect(testState.legacyKeychainCredentials).toBe(systemCredentials)
    warn.mockRestore()
  })

  it('treats corrupt system-default snapshots as missing and clears owned runtime auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(snapshotPath, '{not-json', 'utf-8')
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
    warn.mockRestore()
  })

  it('treats wrong-shaped system-default snapshots as missing and clears owned runtime auth', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const snapshotPath = join(
      testState.userDataDir,
      'claude-runtime-auth',
      'system-default-auth.json'
    )
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    mkdirSync(join(testState.userDataDir, 'claude-runtime-auth'), { recursive: true })
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        credentialsJson: { token: 'system' },
        keychainCredentialsJson: managedCredentials,
        scopedKeychainCredentialsJson: { token: 'scoped' },
        legacyKeychainCredentialsJson: managedCredentials,
        capturedAt: Date.now()
      })}\n`,
      'utf-8'
    )
    writeFileSync(runtimeCredentialsPath, managedCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'account-1' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = managedCredentials
    testState.legacyKeychainCredentials = managedCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(snapshotPath)).toBe(false)
    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
    warn.mockRestore()
  })

  it('preserves invalid external runtime oauth metadata when deselecting', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(runtimeConfigPath, `${JSON.stringify({})}\n`, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      'null\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(runtimeConfigPath, '{not-json', 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('{not-json')
  })

  it('preserves external oauth logout when managed oauth metadata is null', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: { accountUuid: 'system-account' } })}\n`,
      'utf-8'
    )
    testState.scopedKeychainCredentials = systemCredentials
    testState.legacyKeychainCredentials = systemCredentials
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      'null\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    rmSync(runtimeCredentialsPath, { force: true })
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    writeFileSync(runtimeConfigPath, `${JSON.stringify({})}\n`, 'utf-8')
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(existsSync(runtimeCredentialsPath)).toBe(false)
    expect(readRuntimeOauthAccountForTest()).toBeNull()
    expect(testState.scopedKeychainCredentials).toBeNull()
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('restores reordered owned oauth metadata using stable json equality', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account', emailAddress: 'system@example.com' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      '{"accountUuid":"account-1","emailAddress":"user@example.com"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    writeFileSync(
      runtimeConfigPath,
      '{"oauthAccount":{"emailAddress":"user@example.com","accountUuid":"account-1"}}\n',
      'utf-8'
    )
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('restores owned oauth metadata during rollback after removing the added account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const runtimeConfigPath = join(testState.fakeHomeDir, '.claude.json')
    const systemCredentials = createClaudeCredentialsJson('system@example.com', 'system')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const systemOauthAccount = { accountUuid: 'system-account' }
    writeFileSync(runtimeCredentialsPath, systemCredentials, 'utf-8')
    writeFileSync(
      runtimeConfigPath,
      `${JSON.stringify({ oauthAccount: systemOauthAccount })}\n`,
      'utf-8'
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials,
      '{"accountUuid":"account-1"}\n'
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)]
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    settings.claudeManagedAccounts = []
    await service.forceMaterializeCurrentSelectionForRollback()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials)
    expect(readRuntimeOauthAccountForTest()).toEqual(systemOauthAccount)
  })

  it('reads back refreshed file credentials when keychain reads fail', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const refreshedCredentials = createClaudeCredentialsJson('user@example.com', 'refreshed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    testState.throwScopedKeychainRead = true
    testState.throwLegacyKeychainRead = true
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(refreshedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(refreshedCredentials)
    warn.mockRestore()
  })

  it('captures a fresh system-default snapshot when re-entering managed mode', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const systemCredentials1 = createClaudeCredentialsJson('system1@example.com', 'system1')
    const systemCredentials2 = createClaudeCredentialsJson('system2@example.com', 'system2')
    const managedCredentials = createClaudeCredentialsJson('user@example.com', 'managed')
    writeFileSync(runtimeCredentialsPath, systemCredentials1, 'utf-8')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()
    writeFileSync(runtimeCredentialsPath, systemCredentials2, 'utf-8')

    settings.activeClaudeManagedAccountId = 'account-1'
    await service.syncForCurrentSelection()
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()

    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(systemCredentials2)
  })

  it('reads back refreshed credentials for the outgoing Claude account before switching', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, account1Refreshed, 'utf-8')
    settings.activeClaudeManagedAccountId = 'account-2'
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('routes refreshed Claude credentials to the matching managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1Original = createClaudeCredentialsJson('one@example.com', 'one-original')
    const account1Refreshed = createClaudeCredentialsJson('one@example.com', 'one-refreshed')
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1Original
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    // A stale account-1 Claude process refreshed the shared runtime file after
    // Orca selected account-2. Persist that refresh to account-1, then restore
    // the selected account in the shared Claude runtime credentials.
    writeFileSync(runtimeCredentialsPath, account1Refreshed, 'utf-8')
    testState.scopedKeychainCredentials = account1Refreshed
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1Refreshed)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBe(account2Credentials)
      expect(testState.legacyKeychainCredentials).toBe(account2Credentials)
    }
  })

  it('rejects stale cold-start read-back for inactive matching account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const account1ManagedNewer = createClaudeCredentialsJson(
      'one@example.com',
      'one-managed-newer',
      null,
      5_000
    )
    const account1RuntimeStale = createClaudeCredentialsJson(
      'one@example.com',
      'one-runtime-stale',
      null,
      2_000
    )
    const account2Credentials = createClaudeCredentialsJson('two@example.com', 'two', null, 1_000)
    writeFileSync(runtimeCredentialsPath, account1RuntimeStale, 'utf-8')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      account1ManagedNewer
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      account2Credentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'one@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'two@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-2'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(account1ManagedNewer)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(account2Credentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(account2Credentials)
  })

  it('rejects ambiguous Claude read-back instead of choosing a managed account', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('same@example.com', 'same-original')
    const refreshedCredentials = createClaudeCredentialsJson('same@example.com', 'same-refreshed')
    const activeCredentials = createClaudeCredentialsJson('active@example.com', 'active')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      originalCredentials
    )
    const managedAuthPath3 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-3',
      activeCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, { email: 'same@example.com' }),
        createClaudeAccount('account-3', managedAuthPath3, { email: 'active@example.com' })
      ],
      activeClaudeManagedAccountId: 'account-3'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedCredentials, 'utf-8')
    testState.scopedKeychainCredentials = refreshedCredentials
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(originalCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(originalCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(activeCredentials)
    if (process.platform === 'darwin') {
      expect(testState.scopedKeychainCredentials).toBe(activeCredentials)
      expect(testState.legacyKeychainCredentials).toBe(activeCredentials)
    }
  })

  it('rejects same-email read-back when another account needs organization proof', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const refreshedWithoutOrg = createClaudeCredentialsJson('same@example.com', 'refreshed')
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, refreshedWithoutOrg, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(noOrgCredentials)
  })

  it('rejects same-email read-back with conflicting organization for no-org accounts', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const noOrgCredentials = createClaudeCredentialsJson('same@example.com', 'no-org')
    const orgCredentials = createClaudeCredentialsJson('same@example.com', 'org', 'org-b')
    const conflictingOrgCredentials = createClaudeCredentialsJson(
      'same@example.com',
      'conflicting-org',
      'org-c'
    )
    const managedAuthPath1 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      noOrgCredentials
    )
    const managedAuthPath2 = createManagedClaudeAuth(
      testState.userDataDir,
      'account-2',
      orgCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath1, { email: 'same@example.com' }),
        createClaudeAccount('account-2', managedAuthPath2, {
          email: 'same@example.com',
          organizationUuid: 'org-b'
        })
      ],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    writeFileSync(runtimeCredentialsPath, conflictingOrgCredentials, 'utf-8')
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath1)).toBe(noOrgCredentials)
    expect(readManagedCredentialsForTest('account-2', managedAuthPath2)).toBe(orgCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(noOrgCredentials)
  })

  it('clears an invalid active Claude account before launch preparation', async () => {
    const settings = createSettings({
      activeClaudeManagedAccountId: 'missing-account'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(store.updateSettings).toHaveBeenCalledWith({ activeClaudeManagedAccountId: null })
    expect(preparation.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    expect(preparation.stripAuthEnv).toBe(false)
    expect(preparation.provenance).toBe('system')
  })

  it('does not clobber fresh Claude credentials after clearLastWrittenCredentialsJson', async () => {
    const runtimeCredentialsPath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
    const originalCredentials = createClaudeCredentialsJson('user@example.com', 'original')
    const reauthedCredentials = createClaudeCredentialsJson('user@example.com', 'reauthed')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      originalCredentials
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection()

    testState.managedKeychainCredentials.set('account-1', reauthedCredentials)
    writeFileSync(join(managedAuthPath, '.credentials.json'), reauthedCredentials, 'utf-8')
    service.clearLastWrittenCredentialsJson()
    await service.syncForCurrentSelection()

    expect(readManagedCredentialsForTest('account-1', managedAuthPath)).toBe(reauthedCredentials)
    expect(readFileSync(runtimeCredentialsPath, 'utf-8')).toBe(reauthedCredentials)
  })
})
