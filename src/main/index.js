import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { disposeAllTerminals, registerTerminalIpc, setNotifyServer } from './terminals'
import { registerWorkspaceIpc } from './workspace'
import { createNotifyServer } from './notifyServer'

let mainWindow = null
let notifyServer = null
let stopNotifyBridge = null

const HEADER_HEIGHT_PX = 34
const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 12 }

function createWindow() {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Mica Code',
    backgroundColor: '#0e0e0e',
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isMac) {
    mainWindow.setSheetOffset(HEADER_HEIGHT_PX)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('focus', () => {
    broadcastWindowState()
  })

  mainWindow.on('blur', () => {
    broadcastWindowState()
  })

  mainWindow.on('show', () => {
    broadcastWindowState()
  })

  mainWindow.on('hide', () => {
    broadcastWindowState()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function broadcastWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const payload = {
    focused: mainWindow.isFocused(),
    visible: mainWindow.isVisible() && !mainWindow.isMinimized()
  }
  mainWindow.webContents.send('app:window-state', payload)
}

function broadcastNotifyChange(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('notify:changed', payload)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.mica.code')

  notifyServer = await createNotifyServer()
  setNotifyServer(notifyServer)
  stopNotifyBridge = notifyServer.onChange((payload) => {
    broadcastNotifyChange(payload)
  })

  registerTerminalIpc()
  registerWorkspaceIpc()

  ipcMain.handle('app:get-window-state', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { focused: false, visible: false }
    }
    return {
      focused: mainWindow.isFocused(),
      visible: mainWindow.isVisible() && !mainWindow.isMinimized()
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      broadcastWindowState()
      return
    }

    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', (event) => {
  event.preventDefault()
})

app.on('before-quit', async () => {
  app.isQuitting = true
  disposeAllTerminals()
  if (typeof stopNotifyBridge === 'function') {
    stopNotifyBridge()
    stopNotifyBridge = null
  }
  if (notifyServer) {
    await notifyServer.close()
    notifyServer = null
  }
})
