import { ipcMain } from 'electron'
import os from 'os'
import pty from 'node-pty'

const sessions = new Map()

function getDefaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

function createPty(id, sender, options = {}) {
  const shell = options.shell || getDefaultShell()
  const cwd = options.cwd || os.homedir()
  const cols = options.cols || 80
  const rows = options.rows || 24

  const term = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  })

  const session = { id, term, sender }
  sessions.set(id, session)

  term.onData((data) => {
    if (!sender.isDestroyed()) {
      sender.send('terminal:data', { id, data })
    }
  })

  term.onExit(({ exitCode, signal }) => {
    sessions.delete(id)
    if (!sender.isDestroyed()) {
      sender.send('terminal:exit', { id, exitCode, signal })
    }
  })

  return { id, shell, cwd }
}

export function registerTerminalIpc() {
  ipcMain.handle('terminal:create', (event, payload = {}) => {
    const id = payload.id
    if (!id) throw new Error('terminal id is required')
    if (sessions.has(id)) {
      return { id, reused: true }
    }
    return createPty(id, event.sender, payload)
  })

  ipcMain.handle('terminal:write', (_event, { id, data }) => {
    const session = sessions.get(id)
    if (!session) return false
    session.term.write(data)
    return true
  })

  ipcMain.handle('terminal:resize', (_event, { id, cols, rows }) => {
    const session = sessions.get(id)
    if (!session) return false
    session.term.resize(Math.max(cols, 2), Math.max(rows, 1))
    return true
  })

  ipcMain.handle('terminal:dispose', (_event, { id }) => {
    const session = sessions.get(id)
    if (!session) return false
    try {
      session.term.kill()
    } catch {
      // ignore
    }
    sessions.delete(id)
    return true
  })

  ipcMain.handle('terminal:dispose-all', () => {
    for (const [id, session] of sessions) {
      try {
        session.term.kill()
      } catch {
        // ignore
      }
      sessions.delete(id)
    }
    return true
  })
}

export function disposeAllTerminals() {
  for (const session of sessions.values()) {
    try {
      session.term.kill()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}
