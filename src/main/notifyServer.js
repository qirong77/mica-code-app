import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const MAX_BODY_BYTES = 64 * 1024

/**
 * Local-only notify server for mica plugins running inside app terminals.
 * Binds 127.0.0.1 only; auth via bearer token injected into pty env.
 */
export async function createNotifyServer() {
  const token = randomBytes(16).toString('hex')
  const states = new Map()
  const bus = new EventEmitter()
  bus.setMaxListeners(20)

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, { token, states, bus })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('notify server failed to bind local port')
  }

  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    token,
    getTerminalEnv(terminalId) {
      return {
        MICA_HOST: 'mica-code-app',
        MICA_TERMINAL_ID: String(terminalId),
        MICA_APP_NOTIFY_URL: baseUrl,
        MICA_APP_TOKEN: token
      }
    },
    list() {
      return serializeStates(states)
    },
    get(terminalId) {
      return states.get(terminalId) ?? null
    },
    markRead(terminalId) {
      return markRead(states, bus, terminalId)
    },
    clear(terminalId) {
      if (!states.has(terminalId)) return false
      states.delete(terminalId)
      bus.emit('change', { type: 'cleared', terminalId, states: serializeStates(states) })
      return true
    },
    onChange(listener) {
      bus.on('change', listener)
      return () => bus.off('change', listener)
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}

async function handleRequest(req, res, ctx) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (!authorize(req, ctx.token)) {
    writeJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && (path === '/v1/terminals' || path === '/terminals')) {
    writeJson(res, 200, { ok: true, terminals: serializeStates(ctx.states) })
    return
  }

  const eventMatch = path.match(/^\/(?:v1\/)?terminals\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    const terminalId = decodeURIComponent(eventMatch[1])
    const body = await readJsonBody(req)
    const type = normalizeEventType(body?.type)
    if (!type) {
      writeJson(res, 400, { ok: false, error: 'invalid event type' })
      return
    }

    const state = {
      terminalId,
      unread: true,
      lastType: type,
      lastEventAt: Number(body?.ts) > 0 ? Number(body.ts) : Date.now(),
      summary: typeof body?.summary === 'string' ? body.summary.slice(0, 200) : undefined
    }
    ctx.states.set(terminalId, state)
    ctx.bus.emit('change', {
      type: 'event',
      terminalId,
      state,
      states: serializeStates(ctx.states)
    })
    writeJson(res, 200, { ok: true, state })
    return
  }

  const readMatch = path.match(/^\/(?:v1\/)?terminals\/([^/]+)\/read$/)
  if (req.method === 'POST' && readMatch) {
    const terminalId = decodeURIComponent(readMatch[1])
    const state = markRead(ctx.states, ctx.bus, terminalId)
    writeJson(res, 200, { ok: true, state })
    return
  }

  writeJson(res, 404, { ok: false, error: 'not found' })
}

function markRead(states, bus, terminalId) {
  const current = states.get(terminalId)
  if (!current) {
    return { terminalId, unread: false, lastType: null, lastEventAt: null }
  }
  if (!current.unread) return current

  const next = {
    ...current,
    unread: false,
    readAt: Date.now()
  }
  states.set(terminalId, next)
  bus.emit('change', {
    type: 'read',
    terminalId,
    state: next,
    states: serializeStates(states)
  })
  return next
}

function authorize(req, token) {
  const header = req.headers.authorization || ''
  if (header === `Bearer ${token}`) return true
  const raw = req.headers['x-mica-token']
  return raw === token
}

function normalizeEventType(value) {
  if (typeof value !== 'string') return null
  const type = value.trim()
  if (type === 'turn.completed' || type === 'turn.error' || type === 'turn.aborted') return type
  if (type === 'completed' || type === 'error' || type === 'aborted') return `turn.${type}`
  return null
}

function serializeStates(states) {
  return [...states.values()].map((item) => ({
    terminalId: item.terminalId,
    unread: !!item.unread,
    lastType: item.lastType ?? null,
    lastEventAt: item.lastEventAt ?? null,
    summary: item.summary,
    readAt: item.readAt ?? null
  }))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Mica-Token'
  }
}
