import $ from 'jquery'
import 'jstree'
import 'jstree/dist/themes/default/style.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../assets/main.css'

window.$ = window.jQuery = $

const treeEl = $('#session-tree')
const hostEl = document.getElementById('terminal-host')
const emptyStateEl = document.getElementById('empty-state')
const activeTitleEl = document.getElementById('active-title')

/** @type {Map<string, { term: Terminal, fit: FitAddon, el: HTMLElement, ready: boolean }>} */
const terminals = new Map()
let workspace = null
let activeId = null
let saveTimer = null

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
  if (!workspace) return
  const tree = treeEl.jstree(true)
  workspace = {
    version: 1,
    activeId,
    nodes: tree.get_json('#', { flat: true }).map((node) => ({
      id: node.id,
      parent: node.parent,
      text: node.text,
      type: node.type,
      state: {
        opened: !!node.state?.opened,
        selected: node.id === activeId
      }
    }))
  }
  await window.mica.workspace.save(workspace)
}

function setEmptyState(visible) {
  emptyStateEl.classList.toggle('hidden', !visible)
}

function setActiveTitle(text) {
  activeTitleEl.textContent = text || '未选择终端'
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
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#0b0d11',
      foreground: '#e8ecf5',
      cursor: '#1677ff',
      selectionBackground: 'rgba(22, 119, 255, 0.35)'
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
  })

  term.attachCustomKeyEventHandler((event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l' && event.type === 'keydown') {
      term.clear()
      return false
    }
    return true
  })

  return entry
}

async function activateTerminal(id, title) {
  if (!id) {
    activeId = null
    setActiveTitle('未选择终端')
    setEmptyState(true)
    for (const entry of terminals.values()) {
      entry.el.classList.remove('active')
    }
    scheduleSave()
    return
  }

  const entry = ensureTerminalView(id)
  activeId = id
  setActiveTitle(title || id)
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
    })
  } else {
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
      } catch {
        // ignore
      }
      entry.term.focus()
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
  await window.mica.terminal.dispose(id)
  if (activeId === id) {
    const tree = treeEl.jstree(true)
    const next = tree
      .get_json('#', { flat: true })
      .find((node) => node.type === 'terminal' && node.id !== id)
    if (next) {
      tree.deselect_all(true)
      tree.select_node(next.id)
      await activateTerminal(next.id, next.text)
    } else {
      await activateTerminal(null)
    }
  }
  scheduleSave()
}

function getSelectedNode() {
  const tree = treeEl.jstree(true)
  const selected = tree.get_selected(true)
  return selected[0] || null
}

function createFolder(parent = '#') {
  const tree = treeEl.jstree(true)
  const id = uid('folder')
  const node = tree.create_node(parent, {
    id,
    text: '新建文件夹',
    type: 'folder',
    state: { opened: true }
  })
  if (node) {
    tree.edit(node)
    scheduleSave()
  }
}

function createTerminal(parent = 'folder-default') {
  const tree = treeEl.jstree(true)
  if (parent !== '#' && tree.get_type(parent) !== 'folder') {
    const parentNode = tree.get_node(parent)
    parent = parentNode?.parent || '#'
  }
  if (parent === '#') {
    const firstFolder = tree.get_json('#', { flat: true }).find((n) => n.type === 'folder')
    parent = firstFolder?.id || '#'
  }

  const id = uid('term')
  const count = tree.get_json('#', { flat: true }).filter((n) => n.type === 'terminal').length + 1
  const node = tree.create_node(parent, {
    id,
    text: `Terminal ${count}`,
    type: 'terminal'
  })
  if (node) {
    tree.deselect_all(true)
    tree.select_node(node)
    activateTerminal(id, `Terminal ${count}`)
    tree.edit(node)
    scheduleSave()
  }
}

function bindToolbar() {
  document.getElementById('btn-new-folder').addEventListener('click', () => {
    const selected = getSelectedNode()
    const parent =
      selected?.type === 'folder' ? selected.id : selected?.parent && selected.parent !== '#' ? selected.parent : '#'
    createFolder(parent)
  })

  document.getElementById('btn-new-terminal').addEventListener('click', () => {
    const selected = getSelectedNode()
    createTerminal(selected?.id || 'folder-default')
  })

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!activeId) return
    terminals.get(activeId)?.term.clear()
  })
}

function initTree(nodes) {
  treeEl.jstree({
    core: {
      animation: 120,
      themes: {
        name: 'default',
        dots: false,
        icons: true,
        stripes: false,
        responsive: false
      },
      check_callback: (operation, node, parent) => {
        if (operation === 'move_node') {
          // terminals cannot contain children
          if (parent && parent.type === 'terminal') return false
          // folders cannot be nested into terminals (already covered)
          return true
        }
        return true
      },
      data: nodes
    },
    types: {
      default: {
        icon: false
      },
      folder: {
        icon: 'jstree-folder',
        valid_children: ['folder', 'terminal']
      },
      terminal: {
        icon: 'jstree-file',
        valid_children: []
      }
    },
    plugins: ['types', 'dnd', 'contextmenu', 'wholerow', 'unique'],
    dnd: {
      is_draggable: () => true,
      inside_pos: 'last'
    },
    contextmenu: {
      items: (node) => {
        const tree = treeEl.jstree(true)
        const items = {
          rename: {
            label: '重命名',
            action: () => tree.edit(node)
          }
        }

        if (node.type === 'folder') {
          items.createFolder = {
            label: '新建子文件夹',
            action: () => createFolder(node.id)
          }
          items.createTerminal = {
            label: '新建终端',
            action: () => createTerminal(node.id)
          }
        }

        items.remove = {
          label: '删除',
          action: async () => {
            if (node.type === 'folder') {
              const children = tree.get_json(node.id, { flat: true }).filter((n) => n.type === 'terminal')
              for (const child of children) {
                await disposeTerminal(child.id)
              }
              tree.delete_node(node)
              scheduleSave()
              return
            }
            tree.delete_node(node)
            await disposeTerminal(node.id)
          }
        }

        return items
      }
    },
    unique: {
      duplicate: (name, counter) => `${name} ${counter}`
    }
  })

  treeEl.on('select_node.jstree', async (_e, data) => {
    const node = data.node
    if (node.type === 'terminal') {
      await activateTerminal(node.id, node.text)
    }
  })

  treeEl.on('rename_node.jstree move_node.jstree create_node.jstree delete_node.jstree', () => {
    scheduleSave()
  })

  treeEl.on('rename_node.jstree', (_e, data) => {
    if (data.node.type === 'terminal' && data.node.id === activeId) {
      setActiveTitle(data.text)
    }
  })

  treeEl.on('dblclick.jstree', '.jstree-anchor', function () {
    const tree = treeEl.jstree(true)
    const node = tree.get_node(this)
    if (node) tree.edit(node)
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

async function bootstrap() {
  workspace = await window.mica.workspace.get()
  const nodes = (workspace.nodes || []).map((node) => ({
    id: node.id,
    parent: node.parent,
    text: node.text,
    type: node.type || (node.parent === '#' ? 'folder' : 'terminal'),
    state: node.state || {}
  }))

  initTree(nodes)
  bindToolbar()

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

  // restore active terminal
  const preferred = workspace.activeId
  const tree = treeEl.jstree(true)
  const all = tree.get_json('#', { flat: true })
  const target = all.find((n) => n.id === preferred && n.type === 'terminal') || all.find((n) => n.type === 'terminal')
  if (target) {
    tree.deselect_all(true)
    tree.select_node(target.id)
    await activateTerminal(target.id, target.text)
  } else {
    setEmptyState(true)
  }
}

bootstrap().catch((error) => {
  console.error(error)
  setActiveTitle('启动失败')
  emptyStateEl.textContent = String(error)
  setEmptyState(true)
})
