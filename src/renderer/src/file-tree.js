import { iconHtml } from './icons.js'

/**
 * Lightweight hierarchical tree for folders + terminals.
 * Replaces jstree with the same workspace model: flat nodes with parent ids.
 */

/**
 * @typedef {{
 *   id: string,
 *   parent: string,
 *   text: string,
 *   type: 'folder' | 'terminal',
 *   cwd?: string | null,
 *   state?: { opened?: boolean, selected?: boolean }
 * }} TreeNode
 */

export class FileTree {
  /**
   * @param {HTMLElement} rootEl
   * @param {{
   *   onSelect?: (node: TreeNode) => void,
   *   onChange?: () => void,
   *   onContextAction?: (action: string, node: TreeNode) => void,
   *   getUnread?: (id: string) => { unread: boolean, running?: boolean, lastType?: string | null } | null
   * }} handlers
   */
  constructor(rootEl, handlers = {}) {
    this.rootEl = rootEl
    this.handlers = handlers
    /** @type {Map<string, TreeNode>} */
    this.nodes = new Map()
    /** @type {Map<string, string[]>} */
    this.children = new Map()
    this.selectedId = null
    this.editingId = null
    this.dragId = null
    this.dropTargetId = null
    this.dropPosition = null
    this.menuEl = null
    this.menuNodeId = null
    /** @type {string} */
    this.query = ''
    /** @type {Set<string> | null} */
    this.visibleIds = null
    /** @type {Set<string>} */
    this.forceOpenIds = new Set()

    this.rootEl.classList.add('file-tree')
    this.rootEl.addEventListener('click', (e) => this.#onClick(e))
    this.rootEl.addEventListener('dblclick', (e) => this.#onDblClick(e))
    this.rootEl.addEventListener('contextmenu', (e) => this.#onContextMenu(e))
    this.rootEl.addEventListener('dragstart', (e) => this.#onDragStart(e))
    this.rootEl.addEventListener('dragover', (e) => this.#onDragOver(e))
    this.rootEl.addEventListener('dragleave', (e) => this.#onDragLeave(e))
    this.rootEl.addEventListener('drop', (e) => this.#onDrop(e))
    this.rootEl.addEventListener('dragend', () => this.#onDragEnd())

    document.addEventListener('pointerdown', (e) => {
      if (this.menuEl && !this.menuEl.contains(e.target)) this.closeMenu()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeMenu()
    })
  }

  /**
   * @param {TreeNode[]} flat
   */
  load(flat) {
    this.nodes.clear()
    this.children.clear()
    this.children.set('#', [])

    for (const raw of flat || []) {
      const node = {
        id: raw.id,
        parent: raw.parent || '#',
        text: raw.text || '',
        type: raw.type === 'folder' ? 'folder' : 'terminal',
        cwd: raw.type === 'folder' && typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
        state: {
          opened: false,
          selected: !!raw.state?.selected
        }
      }
      if (node.type === 'folder') {
        // Preserve explicit false; default open when state omitted.
        node.state.opened = raw.state?.opened === undefined ? true : !!raw.state.opened
      }
      this.nodes.set(node.id, node)
      if (!this.children.has(node.parent)) this.children.set(node.parent, [])
      this.children.get(node.parent).push(node.id)
      if (!this.children.has(node.id)) this.children.set(node.id, [])
    }

    // Prefer explicitly selected, else keep previous if still present
    const preferred = flat?.find((n) => n.state?.selected)?.id
    if (preferred && this.nodes.has(preferred)) {
      this.selectedId = preferred
    } else if (this.selectedId && !this.nodes.has(this.selectedId)) {
      this.selectedId = null
    }

    this.#recomputeFilter()
    this.render()
  }

  /**
   * Flat json compatible with previous workspace format.
   * @returns {TreeNode[]}
   */
  getJson() {
    const out = []
    const walk = (parentId) => {
      for (const id of this.children.get(parentId) || []) {
        const n = this.nodes.get(id)
        if (!n) continue
        /** @type {TreeNode} */
        const item = {
          id: n.id,
          parent: n.parent,
          text: n.text,
          type: n.type,
          state: {
            opened: n.type === 'folder' ? !!n.state?.opened : false,
            selected: n.id === this.selectedId
          }
        }
        if (n.type === 'folder' && n.cwd) item.cwd = n.cwd
        out.push(item)
        walk(id)
      }
    }
    walk('#')
    return out
  }

  getNode(id) {
    return this.nodes.get(id) || null
  }

  getSelected() {
    return this.selectedId ? this.nodes.get(this.selectedId) || null : null
  }

  /**
   * Set default cwd for a folder. Empty/null clears it.
   * @param {string} id
   * @param {string | null | undefined} cwd
   */
  setFolderCwd(id, cwd) {
    const node = this.nodes.get(id)
    if (!node || node.type !== 'folder') return false
    const next = typeof cwd === 'string' ? cwd.trim() : ''
    node.cwd = next || null
    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return true
  }

  /**
   * Resolve cwd for a new terminal under folderId by walking ancestors.
   * Nearest non-empty folder.cwd wins.
   * @param {string} folderId
   * @returns {string | null}
   */
  resolveDefaultCwd(folderId) {
    let cur = folderId
    while (cur && cur !== '#') {
      const node = this.nodes.get(cur)
      if (!node) break
      if (node.type === 'folder' && node.cwd) return node.cwd
      cur = node.parent
    }
    return null
  }

  /**
   * Case-insensitive filter by node text / folder cwd. Empty clears filter.
   * @param {string} query
   */
  setQuery(query) {
    this.query = (query || '').trim()
    this.#recomputeFilter()
    this.render()
  }

  getQuery() {
    return this.query
  }

  #recomputeFilter() {
    const q = this.query.toLowerCase()
    if (!q) {
      this.visibleIds = null
      this.forceOpenIds = new Set()
      return
    }

    // Collect all ids that match directly or are ancestors of a match
    const matched = new Set()
    const ancestors = new Set()

    const walk = (parentId, ancestorPath) => {
      let hasMatchInSubtree = false
      for (const id of this.children.get(parentId) || []) {
        const node = this.nodes.get(id)
        if (!node) continue

        const textMatch =
          node.text.toLowerCase().includes(q) ||
          (node.type === 'folder' && node.cwd && node.cwd.toLowerCase().includes(q))

        const childMatch = node.type === 'folder' ? walk(id, [...ancestorPath, id]) : false
        const anyMatch = textMatch || childMatch
        if (anyMatch) {
          matched.add(id)
          if (textMatch) {
            for (const aid of ancestorPath) {
              ancestors.add(aid)
              const an = this.nodes.get(aid)
              if (an && an.type === 'folder') this.forceOpenIds.add(aid)
            }
          }
          hasMatchInSubtree = true
        }
      }
      return hasMatchInSubtree
    }

    walk('#', [])
    this.visibleIds = new Set([...matched, ...ancestors])
  }

  /**
   * @param {string} parentId
   * @param {TreeNode} raw
   * @returns {string | null} created node id
   */
  createNode(parentId, raw) {
    if (!this.children.has(parentId)) this.children.set(parentId, [])
    const node = {
      id: raw.id,
      parent: parentId,
      text: raw.text || '',
      type: raw.type === 'folder' ? 'folder' : 'terminal',
      cwd: raw.type === 'folder' && typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      state: {
        opened: raw.type === 'folder' ? (raw.state?.opened === undefined ? true : !!raw.state.opened) : false,
        selected: !!raw.state?.selected
      }
    }
    this.nodes.set(node.id, node)
    this.children.get(parentId).push(node.id)
    if (!this.children.has(node.id)) this.children.set(node.id, [])
    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return node.id
  }

  deleteNode(id) {
    const node = this.nodes.get(id)
    if (!node) return false

    // Recursively remove children
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()
      for (const cid of this.children.get(cur) || []) {
        stack.push(cid)
      }
      this.nodes.delete(cur)
      this.children.delete(cur)
    }

    // Remove from parent's children list
    const siblings = this.children.get(node.parent)
    if (siblings) {
      const idx = siblings.indexOf(id)
      if (idx !== -1) siblings.splice(idx, 1)
    }

    if (this.selectedId === id) this.selectedId = null
    if (this.editingId === id) this.editingId = null

    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return true
  }

  select(id, scrollIntoView = false) {
    if (!this.nodes.has(id)) return false
    if (this.selectedId === id) return true
    this.selectedId = id
    this.render()
    if (scrollIntoView) {
      requestAnimationFrame(() => {
        const row = this.rootEl.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }
    this.handlers.onChange?.()
    return true
  }

  deselectAll() {
    if (this.selectedId === null) return
    this.selectedId = null
    this.render()
    this.handlers.onChange?.()
  }

  startEdit(id) {
    if (!this.nodes.has(id)) return
    this.editingId = id
    this.render()
  }

  rename(id, value) {
    const node = this.nodes.get(id)
    if (!node) return false
    const text = (value || '').trim()
    if (!text) return false
    if (node.text === text) {
      this.editingId = null
      this.render()
      return true
    }
    node.text = text
    this.editingId = null
    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return true
  }

  /**
   * Toggle folder open/close.
   * @param {string} id
   */
  toggle(id) {
    const node = this.nodes.get(id)
    if (!node || node.type !== 'folder') return
    node.state.opened = !node.state.opened
    if (this.query && node.state.opened) {
      this.forceOpenIds.add(id)
    } else if (this.query && !node.state.opened) {
      this.forceOpenIds.delete(id)
    }
    this.render()
    this.handlers.onChange?.()
  }

  /**
   * Move node (and subtree) under newParent at given index.
   * @param {string} id
   * @param {string} newParent
   * @param {number} [index]
   */
  move(id, newParent, index) {
    const node = this.nodes.get(id)
    if (!node) return false
    const targetParent = this.nodes.get(newParent)
    if (newParent !== '#' && (!targetParent || targetParent.type !== 'folder')) return false
    if (newParent === id) return false
    if (this.#isDescendant(newParent, id)) return false

    const oldSiblings = this.children.get(node.parent)
    if (oldSiblings) {
      const oldIdx = oldSiblings.indexOf(id)
      if (oldIdx !== -1) oldSiblings.splice(oldIdx, 1)
    }

    node.parent = newParent
    if (!this.children.has(newParent)) this.children.set(newParent, [])
    const newSiblings = this.children.get(newParent)
    const insertAt = typeof index === 'number' && index >= 0 && index <= newSiblings.length
      ? index
      : newSiblings.length
    newSiblings.splice(insertAt, 0, id)

    // Ensure auto-open when dragging into a closed folder
    if (targetParent?.type === 'folder' && !targetParent.state?.opened) {
      targetParent.state.opened = true
      if (this.query) this.forceOpenIds.add(newParent)
    }

    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return true
  }

  /**
   * Collect terminal ids under a folder (inclusive of nested).
   * @param {string} folderId
   * @returns {string[]}
   */
  getTerminalIdsUnder(folderId) {
    const out = []
    const walk = (id) => {
      for (const cid of this.children.get(id) || []) {
        const n = this.nodes.get(cid)
        if (!n) continue
        if (n.type === 'terminal') out.push(n.id)
        else walk(n.id)
      }
    }
    walk(folderId)
    return out
  }

  countTerminals() {
    let n = 0
    for (const node of this.nodes.values()) {
      if (node.type === 'terminal') n++
    }
    return n
  }

  firstFolderId() {
    for (const id of this.children.get('#') || []) {
      if (this.nodes.get(id)?.type === 'folder') return id
    }
    for (const node of this.nodes.values()) {
      if (node.type === 'folder') return node.id
    }
    return '#'
  }

  firstTerminal(excludeId) {
    for (const node of this.getJson()) {
      if (node.type === 'terminal' && node.id !== excludeId) return node
    }
    return null
  }

  refreshUnread() {
    // Cheap: only update classes on existing anchors
    for (const el of this.rootEl.querySelectorAll('[data-node-id]')) {
      const id = el.getAttribute('data-node-id')
      if (!id) continue
      const node = this.nodes.get(id)
      if (!node || node.type !== 'terminal') continue
      this.#applyUnread(el, id)
    }
  }

  closeMenu() {
    if (this.menuEl) {
      this.menuEl.remove()
      this.menuEl = null
      this.menuNodeId = null
    }
  }

  render() {
    const openEditId = this.editingId
    const body = this.#renderChildren('#', 0)
    const empty =
      this.query && !body
        ? `<div class="ft-empty">没有匹配的会话</div>`
        : ''
    const html = `${empty}<ul class="ft-root" role="tree">${body}</ul>`
    this.rootEl.innerHTML = html

    if (openEditId) {
      const input = this.rootEl.querySelector(`input[data-edit-id="${CSS.escape(openEditId)}"]`)
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
        const commit = () => {
          if (this.editingId !== openEditId) return
          this.rename(openEditId, input.value)
        }
        input.addEventListener('blur', commit)
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            input.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            this.editingId = null
            this.render()
          }
        })
      }
    }
  }

  /**
   * @param {string} parentId
   * @param {number} depth
   */
  #renderChildren(parentId, depth) {
    const ids = this.children.get(parentId) || []
    let html = ''
    for (const id of ids) {
      const node = this.nodes.get(id)
      if (!node) continue
      if (this.visibleIds && !this.visibleIds.has(id)) continue
      html += this.#renderNode(node, depth)
    }
    return html
  }

  /**
   * @param {TreeNode} node
   * @param {number} depth
   */
  #renderNode(node, depth) {
    const isFolder = node.type === 'folder'
    const opened =
      isFolder && (!!node.state?.opened || (this.query ? this.forceOpenIds.has(node.id) : false))
    const selected = node.id === this.selectedId
    const editing = node.id === this.editingId
    const pad = 8 + depth * 14

    let iconName = 'terminal'
    if (isFolder) iconName = opened ? 'folder-open' : 'folder'

    const unreadState = !isFolder ? this.handlers.getUnread?.(node.id) : null
    const running = !!unreadState?.running
    const unread = !running && !!unreadState?.unread
    const unreadClass = unread
      ? [
          'has-unread',
          unreadState.lastType === 'turn.error' ? 'has-unread-error' : '',
          unreadState.lastType === 'turn.completed' ? 'has-unread-completed' : '',
          unreadState.lastType === 'turn.aborted' ? 'has-unread-aborted' : ''
        ]
          .filter(Boolean)
          .join(' ')
      : ''
    const runningClass = running ? 'has-running' : ''

    const chevron = isFolder
      ? `<span class="ft-chevron${opened ? ' is-open' : ''}" data-action="toggle" data-node-id="${escapeAttr(node.id)}">${iconHtml('chevron-right', { size: 13 })}</span>`
      : `<span class="ft-chevron ft-chevron-spacer"></span>`

    const pathHint = isFolder && node.cwd ? node.cwd : ''
    const titleText = pathHint ? `${node.text} — ${pathHint}` : node.text
    const label = editing
      ? `<input class="ft-rename" data-edit-id="${escapeAttr(node.id)}" value="${escapeAttr(node.text)}" spellcheck="false" />`
      : `<span class="ft-label" title="${escapeAttr(titleText)}">${escapeHtml(node.text)}</span>${
          pathHint
          ?''
            : ''
        }`

    let childrenHtml = ''
    if (isFolder && opened) {
      childrenHtml = `<ul class="ft-children" role="group">${this.#renderChildren(node.id, depth + 1)}</ul>`
    }

    let dotHtml = ''
    if (running) {
      dotHtml = '<span class="ft-running-dot" aria-hidden="true"></span>'
    } else if (unread) {
      dotHtml = '<span class="ft-unread-dot" aria-hidden="true"></span>'
    }

    return `<li class="ft-node" role="treeitem" aria-expanded="${isFolder ? opened : undefined}" data-id="${escapeAttr(node.id)}">
      <div class="ft-row ${selected ? 'is-selected' : ''} ${unreadClass} ${runningClass}" data-node-id="${escapeAttr(node.id)}" data-type="${node.type}" draggable="${editing ? 'false' : 'true'}" style="padding-left:${pad}px">
        ${chevron}
        <span class="ft-icon ft-icon-${node.type}">${iconHtml(iconName, { size: 14 })}</span>
        ${label}
        ${dotHtml}
      </div>
      ${childrenHtml}
    </li>`
  }

  #applyUnread(rowEl, id) {
    const state = this.handlers.getUnread?.(id)
    const running = !!state?.running
    const unread = !running && !!state?.unread

    rowEl.classList.toggle('has-running', running)
    rowEl.classList.toggle('has-unread', unread)
    rowEl.classList.toggle('has-unread-error', unread && state?.lastType === 'turn.error')
    rowEl.classList.toggle('has-unread-completed', unread && state?.lastType === 'turn.completed')
    rowEl.classList.toggle('has-unread-aborted', unread && state?.lastType === 'turn.aborted')

    // Remove existing dots
    const existingDot = rowEl.querySelector('.ft-unread-dot, .ft-running-dot')
    if (existingDot) existingDot.remove()

    if (running) {
      const dot = document.createElement('span')
      dot.className = 'ft-running-dot'
      dot.setAttribute('aria-hidden', 'true')
      rowEl.appendChild(dot)
    } else if (unread) {
      const dot = document.createElement('span')
      dot.className = 'ft-unread-dot'
      dot.setAttribute('aria-hidden', 'true')
      rowEl.appendChild(dot)
    }
  }

  #isDescendant(maybeChild, ancestorId) {
    let cur = this.nodes.get(maybeChild)
    while (cur) {
      if (cur.id === ancestorId) return true
      if (cur.parent === '#' || !cur.parent) return false
      cur = this.nodes.get(cur.parent)
    }
    return false
  }

  // ── Event handlers ────────────────────────────────────

  #onClick(e) {
    const row = e.target.closest('[data-node-id]')
    if (!row) return

    const action = e.target.closest('[data-action]')
    if (action) {
      const actionType = action.getAttribute('data-action')
      const nodeId = action.getAttribute('data-node-id')
      if (actionType === 'toggle' && nodeId) {
        this.toggle(nodeId)
      }
      return
    }

    const id = row.getAttribute('data-node-id')
    if (!id) return

    this.select(id, false)
    const node = this.nodes.get(id)
    if (node) this.handlers.onSelect?.(node)
  }

  #onDblClick(e) {
    const row = e.target.closest('[data-node-id]')
    if (!row) return
    const id = row.getAttribute('data-node-id')
    if (!id) return
    const node = this.nodes.get(id)
    if (!node) return
    if (node.type === 'folder') {
      this.toggle(id)
    } else {
      this.startEdit(id)
    }
  }

  #onContextMenu(e) {
    e.preventDefault()
    const row = e.target.closest('[data-node-id]')
    if (!row) return
    const id = row.getAttribute('data-node-id')
    if (!id) return
    const node = this.nodes.get(id)
    if (!node) return

    this.closeMenu()

    this.menuNodeId = id
    const menu = document.createElement('div')
    menu.className = 'ft-menu'

    const items = []
    items.push({ label: '重命名', action: 'rename' })
    if (node.type === 'folder') {
      items.push({ label: '新建文件夹', action: 'createFolder' })
      items.push({ label: '新建终端', action: 'createTerminal' })
      items.push({ label: '设置默认路径…', action: 'setDefaultPath' })
    }
    items.push({ label: '删除', action: 'remove', danger: true })

    menu.innerHTML = items
      .map(
        (item) =>
          `<button class="ft-menu-item${item.danger ? ' is-danger' : ''}" data-action="${item.action}">${escapeHtml(item.label)}</button>`
      )
      .join('')

    menu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]')
      if (!btn) return
      const action = btn.getAttribute('data-action')
      this.closeMenu()
      if (action) this.handlers.onContextAction?.(action, node)
    })

    document.body.appendChild(menu)

    // Position
    const rect = row.getBoundingClientRect()
    const menuH = menu.offsetHeight || 200
    const menuW = menu.offsetWidth || 148
    let top = rect.bottom + 4
    let left = rect.left
    if (top + menuH > window.innerHeight) top = rect.top - menuH - 4
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8
    if (left < 4) left = 4
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`

    this.menuEl = menu
  }

  #onDragStart(e) {
    const row = e.target.closest('[data-node-id]')
    if (!row) return
    const id = row.getAttribute('data-node-id')
    if (!id || id === this.editingId) return
    this.dragId = id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    row.classList.add('is-dragging')
  }

  #onDragOver(e) {
    if (!this.dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    const row = e.target.closest('[data-node-id]')
    if (!row) return
    const targetId = row.getAttribute('data-node-id')
    if (!targetId || targetId === this.dragId) return

    // Clear previous drop classes
    if (this.dropTargetId) {
      const prev = this.rootEl.querySelector(`[data-node-id="${CSS.escape(this.dropTargetId)}"]`)
      if (prev) {
        prev.classList.remove('drop-before', 'drop-after', 'drop-inside')
      }
    }

    this.dropTargetId = targetId
    const rect = row.getBoundingClientRect()
    const y = e.clientY
    const h = rect.height
    const pct = (y - rect.top) / h

    const targetNode = this.nodes.get(targetId)
    if (targetNode?.type === 'folder' && pct > 0.25 && pct < 0.75) {
      this.dropPosition = 'inside'
      row.classList.add('drop-inside')
    } else if (pct < 0.5) {
      this.dropPosition = 'before'
      row.classList.add('drop-before')
    } else {
      this.dropPosition = 'after'
      row.classList.add('drop-after')
    }
  }

  #onDragLeave(e) {
    const row = e.target.closest('[data-node-id]')
    if (!row) return
    if (row.getAttribute('data-node-id') !== this.dropTargetId) return
    row.classList.remove('drop-before', 'drop-after', 'drop-inside')
  }

  #onDrop(e) {
    e.preventDefault()
    if (!this.dragId || !this.dropTargetId) return
    const row = this.rootEl.querySelector(`[data-node-id="${CSS.escape(this.dropTargetId)}"]`)
    if (row) {
      row.classList.remove('drop-before', 'drop-after', 'drop-inside')
    }

    const targetNode = this.nodes.get(this.dropTargetId)
    if (!targetNode) return

    let newParent = targetNode.parent
    let index = undefined

    if (this.dropPosition === 'inside') {
      newParent = this.dropTargetId
    } else {
      const siblings = this.children.get(targetNode.parent) || []
      const idx = siblings.indexOf(this.dropTargetId)
      if (idx !== -1) {
        index = this.dropPosition === 'after' ? idx + 1 : idx
      }
    }

    this.move(this.dragId, newParent, index)

    this.dragId = null
    this.dropTargetId = null
    this.dropPosition = null
  }

  #onDragEnd() {
    if (this.dragId) {
      const row = this.rootEl.querySelector(`[data-node-id="${CSS.escape(this.dragId)}"]`)
      if (row) row.classList.remove('is-dragging')
    }
    this.dragId = null
    this.dropTargetId = null
    this.dropPosition = null
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
