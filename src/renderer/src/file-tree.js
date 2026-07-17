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
   *   getUnread?: (id: string) => { unread: boolean, lastType?: string | null } | null
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

    /** @type {Set<string>} */
    const matched = new Set()
    for (const node of this.nodes.values()) {
      const hay = `${node.text} ${node.cwd || ''}`.toLowerCase()
      if (hay.includes(q)) matched.add(node.id)
    }

    /** @type {Set<string>} */
    const visible = new Set()
    /** @type {Set<string>} */
    const forceOpen = new Set()

    const markAncestors = (id) => {
      let cur = this.nodes.get(id)
      while (cur) {
        visible.add(cur.id)
        if (cur.parent && cur.parent !== '#') {
          forceOpen.add(cur.parent)
          cur = this.nodes.get(cur.parent)
        } else {
          break
        }
      }
    }

    const markDescendants = (id) => {
      visible.add(id)
      for (const cid of this.children.get(id) || []) {
        markDescendants(cid)
        const child = this.nodes.get(cid)
        if (child?.type === 'folder') forceOpen.add(cid)
      }
    }

    for (const id of matched) {
      markAncestors(id)
      const node = this.nodes.get(id)
      if (node?.type === 'folder') {
        forceOpen.add(id)
        markDescendants(id)
      } else {
        visible.add(id)
      }
    }

    this.visibleIds = visible
    this.forceOpenIds = forceOpen
  }


  /**
   * @param {string} id
   * @param {boolean} [silent]
   */
  select(id, silent = false) {
    if (id && !this.nodes.has(id)) return
    this.selectedId = id || null
    this.render()
    if (!silent && id) {
      const node = this.nodes.get(id)
      if (node) this.handlers.onSelect?.(node)
    }
  }

  deselectAll() {
    this.selectedId = null
    this.render()
  }

  /**
   * @param {string} parent
   * @param {Partial<TreeNode> & { id: string, text: string, type: 'folder'|'terminal' }} data
   * @returns {string|null}
   */
  createNode(parent, data) {
    if (parent !== '#' && this.nodes.get(parent)?.type !== 'folder') {
      parent = this.nodes.get(parent)?.parent || '#'
    }
    if (this.nodes.has(data.id)) return null

    const node = {
      id: data.id,
      parent,
      text: data.text,
      type: data.type,
      cwd: data.type === 'folder' && typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd.trim() : null,
      state: {
        opened: data.type === 'folder' ? data.state?.opened !== false : false,
        selected: false
      }
    }
    this.nodes.set(node.id, node)
    if (!this.children.has(parent)) this.children.set(parent, [])
    this.children.get(parent).push(node.id)
    if (!this.children.has(node.id)) this.children.set(node.id, [])

    // Ensure ancestors open
    let p = parent
    while (p && p !== '#') {
      const pn = this.nodes.get(p)
      if (pn?.type === 'folder') pn.state.opened = true
      p = pn?.parent
    }

    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
    return node.id
  }

  /**
   * @param {string} id
   */
  deleteNode(id) {
    const node = this.nodes.get(id)
    if (!node) return

    const removeRecursive = (nid) => {
      const kids = [...(this.children.get(nid) || [])]
      for (const kid of kids) removeRecursive(kid)
      this.children.delete(nid)
      this.nodes.delete(nid)
      if (this.selectedId === nid) this.selectedId = null
    }

    const siblings = this.children.get(node.parent)
    if (siblings) {
      const idx = siblings.indexOf(id)
      if (idx >= 0) siblings.splice(idx, 1)
    }
    removeRecursive(id)
    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
  }

  /**
   * @param {string} id
   * @param {string} text
   */
  rename(id, text) {
    const node = this.nodes.get(id)
    if (!node) return
    const next = text.trim()
    if (!next || next === node.text) {
      this.editingId = null
      this.render()
      return
    }
    node.text = next
    this.editingId = null
    this.#recomputeFilter()
    this.render()
    this.handlers.onChange?.()
  }

  /**
   * @param {string} id
   */
  startEdit(id) {
    if (!this.nodes.has(id)) return
    this.editingId = id
    this.render()
    const input = this.rootEl.querySelector(`input[data-edit-id="${CSS.escape(id)}"]`)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }

  /**
   * @param {string} id
   * @param {string} parent
   * @param {number} [index]
   */
  moveNode(id, parent, index) {
    const node = this.nodes.get(id)
    if (!node) return false
    if (parent !== '#' && this.nodes.get(parent)?.type !== 'folder') return false
    // Cannot move into self or descendant
    if (parent === id || this.#isDescendant(parent, id)) return false

    const from = this.children.get(node.parent)
    if (from) {
      const i = from.indexOf(id)
      if (i >= 0) from.splice(i, 1)
    }

    node.parent = parent
    if (!this.children.has(parent)) this.children.set(parent, [])
    const to = this.children.get(parent)
    const at = typeof index === 'number' && index >= 0 && index <= to.length ? index : to.length
    to.splice(at, 0, id)

    if (parent !== '#') {
      const p = this.nodes.get(parent)
      if (p) p.state.opened = true
    }

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
    const unreadClass = unreadState?.unread
      ? [
          'has-unread',
          unreadState.lastType === 'turn.error' ? 'has-unread-error' : '',
          unreadState.lastType === 'turn.completed' ? 'has-unread-completed' : '',
          unreadState.lastType === 'turn.aborted' ? 'has-unread-aborted' : ''
        ]
          .filter(Boolean)
          .join(' ')
      : ''

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

    return `<li class="ft-node" role="treeitem" aria-expanded="${isFolder ? opened : undefined}" data-id="${escapeAttr(node.id)}">
      <div class="ft-row ${selected ? 'is-selected' : ''} ${unreadClass}" data-node-id="${escapeAttr(node.id)}" data-type="${node.type}" draggable="${editing ? 'false' : 'true'}" style="padding-left:${pad}px">
        ${chevron}
        <span class="ft-icon ft-icon-${node.type}">${iconHtml(iconName, { size: 14 })}</span>
        ${label}
        ${unreadState?.unread ? '<span class="ft-unread-dot" aria-hidden="true"></span>' : ''}
      </div>
      ${childrenHtml}
    </li>`
  }

  #applyUnread(rowEl, id) {
    const state = this.handlers.getUnread?.(id)
    rowEl.classList.toggle('has-unread', !!state?.unread)
    rowEl.classList.toggle('has-unread-error', !!state?.unread && state?.lastType === 'turn.error')
    rowEl.classList.toggle('has-unread-completed', !!state?.unread && state?.lastType === 'turn.completed')
    rowEl.classList.toggle('has-unread-aborted', !!state?.unread && state?.lastType === 'turn.aborted')
    let dot = rowEl.querySelector('.ft-unread-dot')
    if (state?.unread) {
      if (!dot) {
        dot = document.createElement('span')
        dot.className = 'ft-unread-dot'
        dot.setAttribute('aria-hidden', 'true')
        rowEl.appendChild(dot)
      }
    } else if (dot) {
      dot.remove()
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

  #rowFromEvent(e) {
    const el = e.target instanceof Element ? e.target.closest('[data-node-id]') : null
    if (!el || !this.rootEl.contains(el)) return null
    return el
  }

  #onClick(e) {
    const target = e.target instanceof Element ? e.target : null
    if (!target) return
    if (target.closest('input.ft-rename')) return

    const toggle = target.closest('[data-action="toggle"]')
    if (toggle) {
      e.stopPropagation()
      const id = toggle.getAttribute('data-node-id')
      const node = id ? this.nodes.get(id) : null
      if (node?.type === 'folder') {
        node.state.opened = !node.state.opened
        this.render()
        this.handlers.onChange?.()
      }
      return
    }

    const row = this.#rowFromEvent(e)
    if (!row) return
    const id = row.getAttribute('data-node-id')
    if (!id) return
    this.select(id)
  }

  #onDblClick(e) {
    const row = this.#rowFromEvent(e)
    if (!row) return
    if (e.target instanceof Element && e.target.closest('input.ft-rename')) return
    const id = row.getAttribute('data-node-id')
    if (id) this.startEdit(id)
  }

  #onContextMenu(e) {
    e.preventDefault()
    const row = this.#rowFromEvent(e)
    if (!row) {
      this.closeMenu()
      return
    }
    const id = row.getAttribute('data-node-id')
    const node = id ? this.nodes.get(id) : null
    if (!node) return
    this.select(id, true)
    this.#openMenu(node, e.clientX, e.clientY)
  }

  #openMenu(node, x, y) {
    this.closeMenu()
    const menu = document.createElement('div')
    menu.className = 'ft-menu'
    menu.setAttribute('role', 'menu')

    /** @type {{ id: string, label: string, danger?: boolean }[]} */
    const items = [{ id: 'rename', label: '重命名' }]
    if (node.type === 'folder') {
      items.push(
        { id: 'createFolder', label: '新建子文件夹' },
        { id: 'createTerminal', label: '新建终端' },
        {
          id: 'setDefaultPath',
          label: node.cwd ? `默认路径: ${node.cwd}` : '添加默认路径'
        }
      )
    }
    items.push({ id: 'remove', label: '删除', danger: true })

    menu.innerHTML = items
      .map(
        (item) =>
          `<button type="button" class="ft-menu-item${item.danger ? ' is-danger' : ''}" data-action="${item.id}" role="menuitem">${escapeHtml(item.label)}</button>`
      )
      .join('')

    document.body.appendChild(menu)
    this.menuEl = menu
    this.menuNodeId = node.id

    const rect = menu.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8
    menu.style.left = `${Math.max(8, left)}px`
    menu.style.top = `${Math.max(8, top)}px`

    menu.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-action]') : null
      if (!btn) return
      const action = btn.getAttribute('data-action')
      const current = this.nodes.get(this.menuNodeId || '')
      this.closeMenu()
      if (action && current) this.handlers.onContextAction?.(action, current)
    })
  }

  #onDragStart(e) {
    const row = this.#rowFromEvent(e)
    if (!row || !(e instanceof DragEvent)) return
    if (row.querySelector('input.ft-rename')) {
      e.preventDefault()
      return
    }
    const id = row.getAttribute('data-node-id')
    if (!id) return
    this.dragId = id
    row.classList.add('is-dragging')
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  #onDragOver(e) {
    if (!this.dragId || !(e instanceof DragEvent)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

    const row = this.#rowFromEvent(e)
    this.#clearDropMarkers()
    if (!row) {
      this.dropTargetId = '#'
      this.dropPosition = 'inside'
      return
    }

    const targetId = row.getAttribute('data-node-id')
    const target = targetId ? this.nodes.get(targetId) : null
    if (!target || targetId === this.dragId || this.#isDescendant(targetId, this.dragId)) {
      this.dropTargetId = null
      return
    }

    const rect = row.getBoundingClientRect()
    const y = e.clientY - rect.top
    const ratio = y / rect.height

    if (target.type === 'folder') {
      if (ratio < 0.25) {
        this.dropTargetId = targetId
        this.dropPosition = 'before'
        row.classList.add('drop-before')
      } else if (ratio > 0.75) {
        this.dropTargetId = targetId
        this.dropPosition = 'after'
        row.classList.add('drop-after')
      } else {
        this.dropTargetId = targetId
        this.dropPosition = 'inside'
        row.classList.add('drop-inside')
      }
    } else {
      this.dropTargetId = targetId
      this.dropPosition = ratio < 0.5 ? 'before' : 'after'
      row.classList.add(ratio < 0.5 ? 'drop-before' : 'drop-after')
    }
  }

  #onDragLeave(e) {
    const row = this.#rowFromEvent(e)
    if (row) {
      row.classList.remove('drop-before', 'drop-after', 'drop-inside')
    }
  }

  #onDrop(e) {
    if (!this.dragId || !(e instanceof DragEvent)) return
    e.preventDefault()
    const dragId = this.dragId
    const targetId = this.dropTargetId
    const position = this.dropPosition
    this.#onDragEnd()
    if (!targetId || !position) return

    if (targetId === '#') {
      this.moveNode(dragId, '#')
      return
    }

    const target = this.nodes.get(targetId)
    if (!target) return

    if (position === 'inside') {
      this.moveNode(dragId, targetId)
      return
    }

    const parent = target.parent
    const siblings = this.children.get(parent) || []
    let index = siblings.indexOf(targetId)
    if (index < 0) return
    if (position === 'after') index += 1

    // Adjust if moving within same parent and from before index
    const fromParent = this.nodes.get(dragId)?.parent
    if (fromParent === parent) {
      const fromIndex = siblings.indexOf(dragId)
      if (fromIndex >= 0 && fromIndex < index) index -= 1
    }

    this.moveNode(dragId, parent, index)
  }

  #onDragEnd() {
    this.dragId = null
    this.dropTargetId = null
    this.dropPosition = null
    this.#clearDropMarkers()
    for (const el of this.rootEl.querySelectorAll('.is-dragging')) {
      el.classList.remove('is-dragging')
    }
  }

  #clearDropMarkers() {
    for (const el of this.rootEl.querySelectorAll('.drop-before, .drop-after, .drop-inside')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-inside')
    }
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
  return escapeHtml(value).replaceAll("'", '&#39;')
}
