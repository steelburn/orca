import { execFile, execFileSync, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { ElectronApplication } from '@stablyai/playwright-test'

const execFileAsync = promisify(execFile)
const CLOSE_TIMEOUT_MS = 10_000

export type ProcessTreeSnapshot = {
  rootPid: number
  descendantPids: number[]
}

async function collectPosixDescendantPids(rootPid: number): Promise<number[]> {
  let stdout = ''
  try {
    ;({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=']))
  } catch {
    return []
  }

  const childrenByParent = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [pidText, parentPidText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parentPid = Number(parentPidText)
    if (!Number.isFinite(pid) || !Number.isFinite(parentPid)) {
      continue
    }
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }

  const descendants: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [...(childrenByParent.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (!pid || seen.has(pid)) {
      continue
    }
    seen.add(pid)
    descendants.push(pid)
    queue.push(...(childrenByParent.get(pid) ?? []))
  }
  return descendants
}

export async function snapshotProcessTree(
  proc: ChildProcess | null | undefined
): Promise<ProcessTreeSnapshot | null> {
  const rootPid = proc?.pid
  if (!rootPid) {
    return null
  }

  return {
    rootPid,
    descendantPids: process.platform === 'win32' ? [] : await collectPosixDescendantPids(rootPid)
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already exited */
  }
}

export function forceKillProcessTreeSnapshot(snapshot: ProcessTreeSnapshot | null): void {
  if (!snapshot) {
    return
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(snapshot.rootPid), '/T', '/F'], {
        stdio: 'ignore'
      })
    } catch {
      /* already exited */
    }
    return
  }

  for (const pid of [...snapshot.descendantPids].reverse()) {
    killPid(pid)
  }
  killPid(snapshot.rootPid)
}

type CloseOptions = {
  killProcessTreeAfterClose?: boolean
}

export async function closeElectronApp(
  app: ElectronApplication,
  options: CloseOptions = {}
): Promise<ProcessTreeSnapshot | null> {
  const snapshot = await snapshotProcessTree(app.process())
  let closeTimer: NodeJS.Timeout | undefined
  let timedOut = false

  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => {
          timedOut = true
          reject(new Error('Timed out closing Electron app'))
        }, CLOSE_TIMEOUT_MS)
      })
    ])
  } catch {
    // Why: CI showed all e2e assertions passing, then worker teardown timing
    // out with orphaned Electron children. Reap descendants when close stalls.
    forceKillProcessTreeSnapshot(snapshot)
  } finally {
    if (closeTimer) {
      clearTimeout(closeTimer)
    }
  }

  if (!timedOut && options.killProcessTreeAfterClose) {
    // Why: Electron can resolve close while renderer/PTY children are still
    // alive, leaving Playwright workers open until their teardown timeout.
    forceKillProcessTreeSnapshot(snapshot)
  }

  return snapshot
}
