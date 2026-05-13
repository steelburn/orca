import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import devIcon from '../../../resources/icon-dev.png?asset'

const FLOATING_TERMINAL_WIDTH = 920
const FLOATING_TERMINAL_HEIGHT = 560
const FLOATING_TERMINAL_MIN_WIDTH = 420
const FLOATING_TERMINAL_MIN_HEIGHT = 280

let floatingTerminalWindow: BrowserWindow | null = null
let appQuitting = false

function isFloatingTerminalSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
): boolean {
  return floatingTerminalWindow?.webContents.id === event.sender.id
}

function sendWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }
  window.webContents.send('floating-terminal-window:maximize-changed', window.isMaximized())
  window.webContents.send('floating-terminal-window:pinned-changed', window.isAlwaysOnTop())
}

ipcMain.handle('floating-terminal-window:isMaximized', (event): boolean => {
  return isFloatingTerminalSender(event) && floatingTerminalWindow?.isMaximized() === true
})

ipcMain.handle('floating-terminal-window:isPinned', (event): boolean => {
  return isFloatingTerminalSender(event) && floatingTerminalWindow?.isAlwaysOnTop() === true
})

ipcMain.on('floating-terminal-window:hide', (event) => {
  if (isFloatingTerminalSender(event)) {
    floatingTerminalWindow?.hide()
  }
})

ipcMain.on('floating-terminal-window:toggleMaximized', (event) => {
  const window = floatingTerminalWindow
  if (!window || window.isDestroyed() || !isFloatingTerminalSender(event)) {
    return
  }
  if (window.isMaximized()) {
    window.unmaximize()
  } else {
    window.maximize()
  }
})

ipcMain.on('floating-terminal-window:togglePinned', (event) => {
  const window = floatingTerminalWindow
  if (!window || window.isDestroyed() || !isFloatingTerminalSender(event)) {
    return
  }
  window.setAlwaysOnTop(!window.isAlwaysOnTop(), 'floating')
  sendWindowState(window)
})

app.on('before-quit', () => {
  appQuitting = true
})

function loadFloatingTerminalWindow(window: BrowserWindow): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?orcaSurface=floating-terminal`)
    return
  }
  window.loadFile(join(__dirname, '../renderer/index.html'), {
    query: { orcaSurface: 'floating-terminal' }
  })
}

export function showFloatingTerminalWindow(): void {
  const existing = floatingTerminalWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.show()
    existing.focus()
    return
  }

  const window = new BrowserWindow({
    width: FLOATING_TERMINAL_WIDTH,
    height: FLOATING_TERMINAL_HEIGHT,
    minWidth: FLOATING_TERMINAL_MIN_WIDTH,
    minHeight: FLOATING_TERMINAL_MIN_HEIGHT,
    title: 'Floating Terminal',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    icon: is.dev ? devIcon : icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webviewTag: false
    }
  })

  floatingTerminalWindow = window
  window.setAlwaysOnTop(true, 'floating')
  window.webContents.setBackgroundThrottling(false)
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show()
    }
  })
  window.on('close', (event) => {
    if (appQuitting) {
      return
    }
    // Why: hiding preserves the renderer-owned xterm surfaces, so reopening
    // the native window does not repaint from scratch or kill live PTYs.
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    if (floatingTerminalWindow === window) {
      floatingTerminalWindow = null
    }
  })
  window.on('maximize', () => sendWindowState(window))
  window.on('unmaximize', () => sendWindowState(window))
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') {
      return
    }
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (mod && input.alt && !input.shift && input.code === 'KeyT') {
      event.preventDefault()
      window.hide()
    }
  })

  loadFloatingTerminalWindow(window)
}

export function toggleFloatingTerminalWindow(): void {
  const window = floatingTerminalWindow
  if (window && !window.isDestroyed() && window.isVisible()) {
    window.hide()
    return
  }
  showFloatingTerminalWindow()
}
