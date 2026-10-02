// The agent socket: a loopback HTTP surface that lets a CLI agent drive this
// browser without impersonating a DevTools client.
//
// Why a socket instead of "just use CDP": a CDP attach pays full DevTools
// protocol setup for every connection, knows nothing about element refs or
// the read pipeline, and hands the caller a bigger gun than the tool
// contract allows. This socket wraps the same tool layer the in-app agent
// uses — same refusals, same verification — plus the tab vocabulary a
// detached process needs (list, open, pin to a tab) and the memory graph.
//
// Trust boundary: the socket exists only when the agent bridge was asked
// for, binds loopback only, and requires a per-launch bearer token written
// into agent-endpoint.json. The token travels in a header a browser page
// cannot set without passing a CORS preflight this server never answers
// with an allow, and the Host check keeps DNS-rebound names from reaching
// it. A page can still POST blindly with no token; it just gets a 401.
//
// Debugger leases are held per tab for the life of the socket (issue: one
// lease per session, not attach-per-read), so a CLI agent's repeated reads
// do not fight over the DevTools lock.

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { createTools } from '../agent/tools.js'
import { createTabPort } from './tabPort.js'
import { ElementRegistry } from '../agent/elements.js'
import { authorizeAction } from '../agent/policy.js'

const MAX_BODY = 64 * 1024

/**
 * @param {string | undefined} value
 */
function originOf(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/**
 * @param {{
 *   listTabs: () => Array<{ id: number, url: string, title: string, active: boolean, loading: boolean }>,
 *   resolveTab: (tabId?: number) => { id: number, webContents: any } | null,
 *   openTab: (url?: string) => number | null,
 *   selectTab: (id: number) => void,
 *   closeTab: (id: number) => void,
 *   resolve: (input: string) => { kind: string, url?: string, reason?: string },
 *   ocr: any,
 *   memory?: { recordRead?: Function, recordAction?: Function, recall?: Function, forget?: Function, stats?: Function } | null | (() => any),
 * }} deps
 * @returns {Promise<{ port: number, token: string, close: () => Promise<void> }>}
 */
export async function createAgentSocket(deps) {
  const token = randomBytes(24).toString('hex')
  /** Origins this bridge session may act on: every open web tab plus every
   *  origin the caller explicitly grants or navigates to. */
  const origins = /** @type {Set<string>} */ (new Set())
  const granted = /** @type {Set<string>} */ (new Set())
  /** Per-tab agent sessions: debugger port lease, element registry, tools. */
  const sessions = /** @type {Map<number, { port: any, elements: any, tools: any }>} */ (new Map())
  /** Tabs this bridge opened; only those may be closed through the socket. */
  const ownedTabs = /** @type {Set<number>} */ (new Set())

  const memoryOf = () => (typeof deps.memory === 'function' ? deps.memory() : deps.memory)

  function refreshOrigins() {
    for (const tab of deps.listTabs()) {
      const origin = originOf(tab.url)
      if (origin) origins.add(origin)
    }
    for (const origin of granted) origins.add(origin)
  }

  /**
   * @param {number} tabId
   */
  function sessionFor(tabId) {
    let session = sessions.get(tabId)
    if (session && session.port) {
      try {
        session.port.context()
        return session
      } catch {
        sessions.delete(tabId)
        session = undefined
      }
    }
    const resolved = deps.resolveTab(tabId)
    if (!resolved) return null
    const wc = resolved.webContents
    const port = createTabPort(wc, { tabId: resolved.id, ocr: deps.ocr })
    const elements = new ElementRegistry()
    const authorize = (/** @type {any} */ request) => {
      refreshOrigins()
      return authorizeAction({ ...request, allowedOrigins: origins })
    }
    const memory = memoryOf()
    const tools = createTools(
      {
        read: () => port.read(),
        readVisual: () => port.readVisual(),
        evaluate: (expression) => port.evaluate(expression),
        resolve: deps.resolve,
        load: (url) => port.load(url),
        exec: () => Promise.resolve({ missing: 'the bridge session cannot run subprocesses' }),
        settle: async () => {
          await port.settle()
        },
        context: () => port.context(),
        invalidate: () => port.invalidate(),
      },
      { elements, authorize, memory: memory ?? undefined },
    )
    session = { port, elements, tools }
    sessions.set(tabId, session)
    try {
      wc.once('destroyed', () => {
        session.port.close()
        sessions.delete(tabId)
      })
    } catch {
      // The tab can already be gone.
    }
    return session
  }

  /**
   * @param {number | undefined} tabId
   * @param {string} name
   * @param {any} args
   */
  function runTool(tabId, name, args) {
    const resolved = deps.resolveTab(tabId)
    if (!resolved) return Promise.resolve({ error: 'no such tab', code: 'no-tab' })
    const session = sessionFor(resolved.id)
    if (!session) return Promise.resolve({ error: 'no such tab', code: 'no-tab' })
    return session.tools.run(name, args ?? {})
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {Record<string, any>} body
   */
  async function route(req, body) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    switch (url.pathname) {
      case '/health':
        return { ok: true, tabs: deps.listTabs().length }
      case '/tabs':
        return { ok: true, tabs: deps.listTabs() }
      case '/open': {
        const input = String(body.url ?? '').trim()
        if (!input) {
          const id = deps.openTab()
          if (id === null) return { ok: false, error: 'no window to open a tab in' }
          ownedTabs.add(id)
          return { ok: true, id, url: '' }
        }
        const resolved = deps.resolve(input)
        const target = resolved.kind === 'url' || resolved.kind === 'search' ? resolved.url : null
        if (!target) {
          return { ok: false, error: `${input} will not open here (${resolved.reason ?? resolved.kind})` }
        }
        const id = deps.openTab(target)
        if (id === null) return { ok: false, error: 'no window to open a tab in' }
        ownedTabs.add(id)
        const origin = originOf(target)
        if (origin) origins.add(origin)
        return { ok: true, id, url: target }
      }
      case '/activate': {
        const id = Number(body.tabId)
        if (!Number.isFinite(id)) return { ok: false, error: 'no tabId' }
        deps.selectTab(id)
        return { ok: true }
      }
      case '/close': {
        const id = Number(body.tabId)
        if (!ownedTabs.has(id)) {
          return { ok: false, error: 'this bridge session did not open that tab; refusing to close it' }
        }
        deps.closeTab(id)
        ownedTabs.delete(id)
        return { ok: true }
      }
      case '/grant-origin': {
        const origin = originOf(body.origin)
        if (!origin) return { ok: false, error: 'grant needs an http(s) origin' }
        granted.add(origin)
        origins.add(origin)
        return { ok: true, origin }
      }
      case '/tool': {
        const name = String(body.name ?? '')
        const tabId = body.tabId === undefined ? undefined : Number(body.tabId)
        const result = await runTool(tabId, name, body.args)
        return { ok: !result?.error, ...result }
      }
      case '/recall': {
        const memory = memoryOf()
        if (!memory?.recall) return { ok: false, error: 'page memory is not enabled' }
        return { ok: true, ...memory.recall(String(body.query ?? ''), { origin: body.origin, limit: body.limit }) }
      }
      case '/forget': {
        const memory = memoryOf()
        if (!memory?.forget) return { ok: false, error: 'page memory is not enabled' }
        return { ok: true, ...memory.forget(body.origin) }
      }
      case '/memory': {
        const memory = memoryOf()
        return { ok: true, enabled: Boolean(memory), ...(memory?.stats?.() ?? {}) }
      }
      default:
        return { ok: false, error: `no route ${url.pathname}`, status: 404 }
    }
  }

  const server = http.createServer((req, res) => {
    /** @param {number} status @param {Record<string, any>} payload */
    const respond = (status, payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
      })
      res.end(text)
    }

    const host = String(req.headers.host ?? '')
    if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
      return respond(403, { ok: false, error: 'wrong host' })
    }
    if (req.headers['x-troy-agent'] !== token) {
      return respond(401, { ok: false, error: 'missing agent token' })
    }
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      // Still token-gated above: even "troy is here" is information a random
      // web page has no business reading.
      route(req, {})
        .then((r) => respond(200, r))
        .catch((e) => respond(500, { ok: false, error: String(e?.message ?? e) }))
      return
    }
    if (req.method !== 'POST') {
      return respond(405, { ok: false, error: 'POST only' })
    }

    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        respond(413, { ok: false, error: 'body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      /** @type {Record<string, any>} */
      let body
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      } catch {
        return respond(400, { ok: false, error: 'body must be JSON' })
      }
      route(req, body)
        .then((result) => respond(result?.status === 404 ? 404 : 200, result))
        .catch((error) => respond(500, { ok: false, error: String(error?.message ?? error) }))
    })
    req.on('error', () => {})
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    token,
    async close() {
      for (const session of sessions.values()) session.port.close()
      sessions.clear()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
