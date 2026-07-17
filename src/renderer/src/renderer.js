import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../assets/main.css'
import { FileTree } from './file-tree.js'
import { iconHtml } from './icons.js'

const treeHost = document.getElementById('session-tree')
const hostEl = document.getElementById('terminal-host')
const emptyStateEl = document.getElementById('empty-state')

/** @type {Map<string, { term: Terminal, fit: FitAddon, el: HTMLElement, ready: boolean }>} */
const terminals = new Map()
/** @type {Map<string, { unread: boolean, lastType?: string | null, lastEventAt?: number | null }>} */
const unreadStates = new Map()

let workspace = null
let activeId = null
let saveTimer = null
let markReadTimer = null
let windowState = { focused: true, visible: true }
/** @type {FileTree | null} */
let tree = null

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    persistWorkspace().catch((error) => console.error('save workspace failed', error))
  }, 200)
}

async function persistWorkspace() {
  if (!workspace || !tree) return
  workspace = {
    version: 1,
    activeId,
    nodes: tree.getJson()
  }
  await window.mica.workspace.save(workspace)
}

function setEmptyState(visible) {
  emptyStateEl.classList.toggle('hidden', !visible)
}

function isWindowReadable() {
  return !!windowState.visible && !!windowState.focused && document.visibilityState === 'visible'
}

function setUnreadState(id, state) {
  if (!id) return
  if (!state || !state.unread) {
    unreadStates.delete(id)
  } else {
    unreadStates.set(id, {
      unread: true,
      lastType: state.lastType ?? null,
      lastEventAt: state.lastEventAt ?? Date.now()
    })
  }
  tree?.refreshUnread()
}

function syncUnreadFromList(list) {
  const next = new Map()
  for (const item of list || []) {
    if (!item?.terminalId) continue
    if (!item.unread) continue
    next.set(item.terminalId, {
      unread: true,
      lastType: item.lastType ?? null,
      lastEventAt: item.lastEventAt ?? null
    })
  }
  unreadStates.clear()
  for (const [id, state] of next) unreadStates.set(id, state)
  tree?.refreshUnread()
}

function maybeMarkActiveRead(reason = 'view') {
  if (!activeId) return
  if (!isWindowReadable()) return
  const state = unreadStates.get(activeId)
  if (!state?.unread) return

  clearTimeout(markReadTimer)
  markReadTimer = setTimeout(() => {
    if (!activeId || !isWindowReadable()) return
    if (!unreadStates.get(activeId)?.unread) return
    window.mica.notify
      .markRead(activeId)
      .then(() => {
        setUnreadState(activeId, { unread: false })
      })
      .catch((error) => {
        console.error('mark read failed', reason, error)
      })
  }, 120)
}

function ensureTerminalView(id) {
  let entry = terminals.get(id)
  if (entry) return entry

  const el = document.createElement('div')
  el.className = 'terminal-view'
  el.dataset.id = id
  hostEl.appendChild(el)

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      '"JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
    theme: {
      background: '#0e0e0e',
      foreground: '#eaeaea',
      cursor: '#eaeaea',
      selectionBackground: 'rgba(234, 234, 234, 0.22)',
      black: '#1a1a1a',
      red: '#e75e78',
      green: '#55a583',
      yellow: '#c08532',
      blue: '#8a8a8a',
      magenta: '#9e94d5',
      cyan: '#6f9ba6',
      white: '#eaeaea',
      brightBlack: '#6a6a6a',
      brightRed: '#f2685c',
      brightGreen: '#46c57a',
      brightYellow: '#f2b33d',
      brightBlue: '#b0b0b0',
      brightMagenta: '#907bc9',
      brightCyan: '#2dd4bf',
      brightWhite: '#ffffff'
    },
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  entry = { term, fit, el, ready: false }
  terminals.set(id, entry)

  term.onData((data) => {
    window.mica.terminal.write(id, data)
    if (id === activeId) maybeMarkActiveRead('input')
  })

  term.onScroll(() => {
    if (id !== activeId) return
    maybeMarkActiveRead('scroll')
  })

  el.addEventListener('pointerdown', () => {
    if (id === activeId) maybeMarkActiveRead('pointer')
  })

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true

    const key = event.key.toLowerCase()
    const mod = event.metaKey || event.ctrlKey

    if (mod && !event.altKey && !event.shiftKey && (key === 'k' || key === 'l')) {
      term.clear()
      return false
    }

    if (mod && !event.altKey && !event.shiftKey && (key === 'backspace' || key === 'delete')) {
      window.mica.terminal.write(id, '\x01\x0b')
      return false
    }

    return true
  })

  return entry
}

async function activateTerminal(id) {
  if (!id) {
    activeId = null
    setEmptyState(true)
    for (const entry of terminals.values()) {
      entry.el.classList.remove('active')
    }
    scheduleSave()
    return
  }

  const entry = ensureTerminalView(id)
  activeId = id
  setEmptyState(false)

  for (const [key, item] of terminals) {
    item.el.classList.toggle('active', key === id)
  }

  if (!entry.ready) {
    await window.mica.terminal.create({ id })
    entry.ready = true
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
        const dims = entry.fit.proposeDimensions()
        if (dims?.cols && dims?.rows) {
          window.mica.terminal.resize(id, dims.cols, dims.rows)
        }
      } catch (error) {
        console.error(error)
      }
      entry.term.focus()
      maybeMarkActiveRead('activate')
    })
  } else {
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
      } catch {
        // ignore
      }
      entry.term.focus()
      maybeMarkActiveRead('activate')
    })
  }

  scheduleSave()
}

async function disposeTerminal(id) {
  const entry = terminals.get(id)
  if (entry) {
    entry.term.dispose()
    entry.el.remove()
    terminals.delete(id)
  }
  unreadStates.delete(id)
  await window.mica.terminal.dispose(id)
  if (activeId === id) {
    const next = tree?.firstTerminal(id)
    if (next) {
      tree.select(next.id, true)
      await activateTerminal(next.id)
    } else {
      tree?.deselectAll()
      await activateTerminal(null)
    }
  }
  scheduleSave()
}

function createFolder(parent = '#') {
  if (!tree) return
  const id = uid('folder')
  const nodeId = tree.createNode(parent, {
    id,
    text: '新建文件夹',
    type: 'folder',
    state: { opened: true }
  })
  if (nodeId) {
    tree.startEdit(nodeId)
    scheduleSave()
  }
}

function createTerminal(parent = 'folder-default') {
  if (!tree) return
  let target = parent
  if (target !== '#' && tree.getNode(target)?.type !== 'folder') {
    target = tree.getNode(target)?.parent || '#'
  }
  if (target === '#') {
    target = tree.firstFolderId()
  }

  const id = uid('term')
  const count = tree.countTerminals() + 1
  const text = `Terminal ${count}`
  const nodeId = tree.createNode(target, {
    id,
    text,
    type: 'terminal'
  })
  if (nodeId) {
    tree.select(nodeId, true)
    activateTerminal(id)
    tree.startEdit(nodeId)
    scheduleSave()
  }
}

async function handleContextAction(action, node) {
  if (!tree) return
  if (action === 'rename') {
    tree.startEdit(node.id)
    return
  }
  if (action === 'createFolder') {
    createFolder(node.id)
    return
  }
  if (action === 'createTerminal') {
    createTerminal(node.id)
    return
  }
  if (action === 'remove') {
    if (node.type === 'folder') {
      const children = tree.getTerminalIdsUnder(node.id)
      for (const childId of children) {
        await disposeTerminal(childId)
      }
      tree.deleteNode(node.id)
      scheduleSave()
      return
    }
    tree.deleteNode(node.id)
    await disposeTerminal(node.id)
  }
}

function bindToolbar() {
  document.getElementById('btn-new-folder')?.addEventListener('click', () => {
    const selected = tree?.getSelected()
    const parent =
      selected?.type === 'folder'
        ? selected.id
        : selected?.parent && selected.parent !== '#'
          ? selected.parent
          : '#'
    createFolder(parent)
  })

  document.getElementById('btn-new-terminal')?.addEventListener('click', () => {
    const selected = tree?.getSelected()
    createTerminal(selected?.id || 'folder-default')
  })
}

function fitActiveTerminal() {
  if (!activeId) return
  const entry = terminals.get(activeId)
  if (!entry) return
  try {
    entry.fit.fit()
    const dims = entry.fit.proposeDimensions()
    if (dims?.cols && dims?.rows) {
      window.mica.terminal.resize(activeId, dims.cols, dims.rows)
    }
  } catch {
    // ignore
  }
}

function bindNotifyAndWindowState() {
  window.mica.notify.onChanged((payload) => {
    if (payload?.type === 'cleared' && payload.terminalId) {
      setUnreadState(payload.terminalId, { unread: false })
      return
    }

    if (payload?.state?.terminalId) {
      const id = payload.state.terminalId
      if (payload.state.unread && id === activeId && isWindowReadable()) {
        setUnreadState(id, { unread: false })
        window.mica.notify.markRead(id).catch((error) => {
          console.error('mark read failed', 'notify-while-active', error)
        })
        return
      }
      setUnreadState(id, payload.state)
      return
    }

    if (Array.isArray(payload?.states)) {
      syncUnreadFromList(payload.states)
      maybeMarkActiveRead('notify-sync')
    }
  })

  window.mica.app.onWindowState((state) => {
    windowState = {
      focused: !!state?.focused,
      visible: !!state?.visible
    }
    maybeMarkActiveRead('window-state')
  })

  document.addEventListener('visibilitychange', () => {
    maybeMarkActiveRead('visibility')
  })

  window.addEventListener('focus', () => {
    windowState = { ...windowState, focused: true }
    maybeMarkActiveRead('window-focus')
  })
}

function paintToolbarIcons() {
  const folderBtn = document.getElementById('btn-new-folder')
  const termBtn = document.getElementById('btn-new-terminal')
  if (folderBtn) folderBtn.innerHTML = iconHtml('folder-plus', { size: 15 })
  if (termBtn) termBtn.innerHTML = iconHtml('plus', { size: 15 })
}

async function bootstrap() {
  paintToolbarIcons()

  workspace = await window.mica.workspace.get()
  const nodes = (workspace.nodes || []).map((node) => ({
    id: node.id,
    parent: node.parent,
    text: node.text,
    type: node.type || (node.parent === '#' ? 'folder' : 'terminal'),
    state: node.state || {}
  }))

  tree = new FileTree(treeHost, {
    onSelect: (node) => {
      if (node.type === 'terminal') {
        activateTerminal(node.id)
      }
    },
    onChange: () => scheduleSave(),
    onContextAction: (action, node) => {
      handleContextAction(action, node).catch((error) => console.error(error))
    },
    getUnread: (id) => unreadStates.get(id) || null
  })
  tree.load(nodes)

  bindToolbar()
  bindNotifyAndWindowState()

  try {
    windowState = (await window.mica.app.getWindowState()) || windowState
  } catch {
    // ignore
  }

  try {
    const list = await window.mica.notify.list()
    syncUnreadFromList(list)
  } catch (error) {
    console.error('load notify states failed', error)
  }

  window.mica.terminal.onData(({ id, data }) => {
    const entry = terminals.get(id)
    if (entry) entry.term.write(data)
  })

  window.mica.terminal.onExit(async ({ id }) => {
    const entry = terminals.get(id)
    if (entry) {
      entry.ready = false
      entry.term.writeln('\r\n[process exited]')
    }
  })

  window.addEventListener('resize', () => fitActiveTerminal())

  const resizeObserver = new ResizeObserver(() => fitActiveTerminal())
  resizeObserver.observe(hostEl)

  const preferred = workspace.activeId
  const all = tree.getJson()
  const target =
    all.find((n) => n.id === preferred && n.type === 'terminal') ||
    all.find((n) => n.type === 'terminal')
  if (target) {
    tree.select(target.id, true)
    await activateTerminal(target.id)
  } else {
    setEmptyState(true)
  }
}

bootstrap().catch((error) => {
  console.error(error)
  emptyStateEl.textContent = String(error)
  setEmptyState(true)
})
