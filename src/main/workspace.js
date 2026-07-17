import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const DEFAULT_WORKSPACE = {
  version: 1,
  activeId: 'term-1',
  nodes: [
    {
      id: 'folder-default',
      parent: '#',
      text: 'Sessions',
      type: 'folder',
      state: { opened: true }
    },
    {
      id: 'term-1',
      parent: 'folder-default',
      text: 'Terminal 1',
      type: 'terminal'
    }
  ]
}

function getWorkspacePath() {
  return join(app.getPath('userData'), 'workspace.json')
}

function loadWorkspace() {
  const file = getWorkspacePath()
  if (!existsSync(file)) {
    return structuredClone(DEFAULT_WORKSPACE)
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || !Array.isArray(data.nodes)) {
      return structuredClone(DEFAULT_WORKSPACE)
    }
    return data
  } catch {
    return structuredClone(DEFAULT_WORKSPACE)
  }
}

function saveWorkspace(workspace) {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getWorkspacePath(), JSON.stringify(workspace, null, 2), 'utf8')
  return true
}

export function registerWorkspaceIpc() {
  ipcMain.handle('workspace:get', () => loadWorkspace())
  ipcMain.handle('workspace:save', (_event, workspace) => {
    saveWorkspace(workspace)
    return true
  })
}
