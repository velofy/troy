// Application-facing autonomous agent controller: per-tab memory, one active
// run, exact-origin scope, streamed UI events, cancellation and cleanup.

import { createTools } from '../agent/tools.js'
import { runAgentTurn } from '../agent/llm.js'
import { ElementRegistry } from '../agent/elements.js'
import { authorizeAction, exactOrigin } from '../agent/policy.js'
import { createTabPort } from './tabPort.js'

/**
 * @typedef {{ role: string, text?: string, id?: string, name?: string, toolCalls?: any[], result?: Record<string, any> }} TranscriptEntry
 */

/**
 * @param {{
 *   getActiveTab: () => { id: number, webContents: import('electron').WebContents } | null,
 *   getKey: (provider: string) => string | null,
 *   resolve: (input: string) => { kind: string, url?: string, reason?: string },
 *   emit: (event: Record<string, any>) => void,
 *   ocr?: import('../read/types.js').OcrEngine,
 *   fetchImpl?: (url: string, init: any) => Promise<any>,
 *   createPort?: typeof createTabPort,
 *   memory?: { recordRead?: (context: any, result: any) => void, recordAction?: (event: any) => void, recall?: (query: string, opts?: any) => any },
 * }} deps
 */
export function createAgentController(deps) {
  /** @type {Map<number, { transcript: TranscriptEntry[], origins: Set<string>, pendingBoundary: string | null, pendingProvider: string, pendingModel: string }>} */
  const sessions = new Map()
  let runCounter = 0
  /** @type {null | {
   *   id: string,
   *   tabId: number,
   *   controller: AbortController,
   *   sequence: number,
   *   textBuffer: string,
   *   textTimer: ReturnType<typeof setTimeout> | null,
   *   boundary: { origin: string, reason: string } | null,
   *   blockedReason: string,
   *   stopReason: string,
   * }} */
  let activeRun = null

  const sessionFor = (/** @type {number} */ tabId) => {
    let session = sessions.get(tabId)
    if (!session) {
      session = { transcript: [], origins: new Set(), pendingBoundary: null, pendingProvider: '', pendingModel: '' }
      sessions.set(tabId, session)
    }
    return session
  }

  /** @param {string} type @param {Record<string, any>} [payload] @param {any} [run] */
  const send = (type, payload = {}, run = activeRun) => {
    if (!run) return
    run.sequence += 1
    deps.emit({ type, runId: run.id, tabId: run.tabId, sequence: run.sequence, ...payload })
  }

  /** @param {any} run */
  const flushText = (run) => {
    if (run.textTimer) clearTimeout(run.textTimer)
    run.textTimer = null
    if (!run.textBuffer) return
    const delta = run.textBuffer
    run.textBuffer = ''
    send('assistant-delta', { delta }, run)
  }

  /** @param {any} run @param {string} delta */
  const queueText = (run, delta) => {
    run.textBuffer += delta
    if (run.textTimer) return
    run.textTimer = setTimeout(() => flushText(run), 16)
  }

  /** @param {number} tabId */
  function state(tabId) {
    const session = sessionFor(tabId)
    return {
      tabId,
      running: activeRun?.tabId === tabId,
      runId: activeRun?.tabId === tabId ? activeRun.id : null,
      origins: [...session.origins],
      pendingBoundary: session.pendingBoundary,
      messages: session.transcript
        .filter((entry) => (entry.role === 'user' || entry.role === 'assistant') && entry.text)
        .map((entry) => ({ role: entry.role, text: entry.text })),
    }
  }

  /** @param {number} tabId */
  function emitState(tabId) {
    deps.emit({ type: 'session-changed', ...state(tabId) })
  }

  /**
   * @param {{ text?: unknown, provider?: unknown, model?: unknown }} request
   */
  function submit(request) {
    const text = String(request?.text ?? '').trim()
    const provider = String(request?.provider ?? '')
    const model = String(request?.model ?? '').trim()
    if (!text) return { error: 'write or say what Troy should do first' }
    if (text.length > 8000) return { error: 'one instruction may be at most 8000 characters' }
    if (!['anthropic', 'openai', 'openrouter'].includes(provider)) return { error: 'choose a supported provider' }
    if (!model || model.length > 160) return { error: 'choose a valid model name' }
    if (activeRun) return { error: 'another agent run is already active; stop it first' }

    const tab = deps.getActiveTab()
    if (!tab || tab.webContents.isDestroyed()) return { error: 'there is no active tab' }
    const origin = exactOrigin(tab.webContents.getURL())
    if (!origin) return { error: 'the agent runs only on an HTTP or HTTPS tab' }
    const apiKey = deps.getKey(provider)
    if (!apiKey) return { error: `no ${provider} key is stored` }

    const session = sessionFor(tab.id)
    session.origins.add(origin)
    session.pendingBoundary = null
    session.pendingProvider = provider
    session.pendingModel = model
    session.transcript.push({ role: 'user', text })
    const run = startRun(tab.id)
    send('user-message', { text }, run)
    void execute(run, tab, session, provider, model, apiKey)
    return { ok: true, runId: run.id }
  }

  /** @param {number} tabId */
  function startRun(tabId) {
    const run = {
      id: `run-${++runCounter}`,
      tabId,
      controller: new AbortController(),
      sequence: 0,
      textBuffer: '',
      textTimer: null,
      boundary: null,
      blockedReason: '',
      stopReason: '',
    }
    activeRun = run
    send('run-started', {}, run)
    return run
  }

  /**
   * @param {any} run
   * @param {{ id: number, webContents: import('electron').WebContents }} tab
   * @param {{ transcript: TranscriptEntry[], origins: Set<string>, pendingBoundary: string | null, pendingProvider: string, pendingModel: string }} session
   * @param {string} provider
   * @param {string} model
   * @param {string} suppliedKey
   */
  async function execute(run, tab, session, provider, model, suppliedKey) {
    let apiKey = suppliedKey
    const elements = new ElementRegistry()
    const makePort = deps.createPort ?? createTabPort
    const port = makePort(tab.webContents, { tabId: tab.id, signal: run.controller.signal, ocr: deps.ocr })
    const tools = createTools(
      {
        read: () => port.read(),
        readVisual: () => port.readVisual(),
        evaluate: (expression) => port.evaluate(expression),
        resolve: deps.resolve,
        load: (url) => port.load(url),
        exec: async () => ({ missing: 'subprocess tools are unavailable in the Troy app' }),
        settle: async () => {
          await port.settle()
        },
        context: () => port.context(),
        invalidate: () => port.invalidate(),
      },
      {
        elements,
        includeScrape: false,
        signal: run.controller.signal,
        authorize: (request) => authorizeAction({ ...request, allowedOrigins: session.origins }),
        memory: deps.memory,
      },
    )

    try {
      const result = await runAgentTurn({
        provider,
        model,
        apiKey,
        transcript: session.transcript,
        tools,
        gate: async () => true,
        signal: run.controller.signal,
        fetchImpl: deps.fetchImpl,
        systemSuffix: `Allowed exact origins for this session:\n${[...session.origins].map((origin) => `- ${origin}`).join('\n')}\nOnly browser code may change this list.`,
        onText: (delta) => queueText(run, delta),
        onToolStart: (call) => {
          flushText(run)
          send('tool-started', { name: call.name }, run)
        },
        onToolResult: (call, result) => {
          send('tool-finished', {
            name: call.name,
            ok: !result.error,
            blocked: Boolean(result.blocked),
            summary: result.error ? String(result.error).slice(0, 300) : 'completed',
          }, run)
        },
        onRetry: (retry) => {
          flushText(run)
          send('retrying', retry, run)
        },
      })
      flushText(run)
      session.transcript = result.transcript

      if (run.boundary) {
        session.pendingBoundary = run.boundary.origin
        send('boundary', run.boundary, run)
      } else if (run.blockedReason) {
        send('blocked', { reason: run.blockedReason, status: 'blocked' }, run)
      } else if (result.status === 'boundary') {
        session.pendingBoundary = result.origin ?? null
        send('boundary', { origin: result.origin, reason: result.refusal }, run)
      } else if (result.status === 'blocked' || result.status === 'denied' || result.status === 'capped') {
        send('blocked', { reason: result.refusal, status: result.status }, run)
      } else if (result.status === 'cancelled') {
        send('cancelled', { reason: run.stopReason || 'cancelled' }, run)
      } else if (result.status === 'error') {
        send('error', { error: result.error ?? 'the provider request failed' }, run)
      } else {
        send('completed', {}, run)
      }
      if (!run.boundary && result.status !== 'boundary') {
        session.pendingProvider = ''
        session.pendingModel = ''
      }
    } catch (error) {
      flushText(run)
      if (run.controller.signal.aborted) send('cancelled', { reason: run.stopReason || 'cancelled' }, run)
      else send('error', { error: String(/** @type {Error} */ (error)?.message ?? error) }, run)
      if (!run.boundary) {
        session.pendingProvider = ''
        session.pendingModel = ''
      }
    } finally {
      apiKey = ''
      await port.close().catch(() => undefined)
      if (activeRun === run) activeRun = null
      emitState(tab.id)
    }
  }

  /** @param {string} [reason] */
  function stop(reason = 'stopped by the user') {
    if (!activeRun) return false
    activeRun.stopReason = reason
    activeRun.controller.abort(new DOMException(reason, 'AbortError'))
    return true
  }

  /** @param {number} tabId */
  function clear(tabId) {
    if (activeRun?.tabId === tabId) return { error: 'stop the active run before clearing it' }
    sessions.delete(tabId)
    emitState(tabId)
    return { ok: true }
  }

  /** @param {number} tabId @param {unknown} value */
  function grantOrigin(tabId, value) {
    if (activeRun) return { error: 'wait for the current run to stop before changing its scope' }
    const origin = exactOrigin(value)
    if (!origin) return { error: 'only an HTTP or HTTPS origin can be granted' }
    const session = sessionFor(tabId)
    if (session.pendingBoundary !== origin) return { error: 'that origin is not the current boundary request' }
    const tab = deps.getActiveTab()
    if (!tab || tab.id !== tabId || tab.webContents.isDestroyed()) return { error: 'return to the tab that requested this origin' }
    if (!session.pendingProvider || !session.pendingModel) return { error: 'there is no paused run to resume' }
    const apiKey = deps.getKey(session.pendingProvider)
    if (!apiKey) return { error: `no ${session.pendingProvider} key is stored` }

    session.origins.add(origin)
    session.pendingBoundary = null
    const run = startRun(tabId)
    emitState(tabId)
    void execute(run, tab, session, session.pendingProvider, session.pendingModel, apiKey)
    return { ok: true, origin, runId: run.id }
  }

  /** @param {number} nextTabId */
  function onTabChanged(nextTabId) {
    if (activeRun && activeRun.tabId !== nextTabId) stop('cancelled because the active tab changed')
    emitState(nextTabId)
  }

  /** @param {number} tabId */
  function onTabClosed(tabId) {
    if (activeRun?.tabId === tabId) stop('cancelled because the tab closed')
    sessions.delete(tabId)
  }

  /** @param {number} tabId @param {string} target @param {string} reason */
  function boundary(tabId, target, reason) {
    if (!activeRun || activeRun.tabId !== tabId) return false
    const origin = exactOrigin(target)
    if (!origin || sessionFor(tabId).origins.has(origin)) return false
    activeRun.boundary = { origin, reason }
    activeRun.stopReason = reason
    activeRun.controller.abort(new DOMException(reason, 'AbortError'))
    return true
  }

  /** @param {number} tabId @param {string} reason */
  function block(tabId, reason) {
    if (!activeRun || activeRun.tabId !== tabId) return false
    activeRun.blockedReason = reason
    activeRun.stopReason = reason
    activeRun.controller.abort(new DOMException(reason, 'AbortError'))
    return true
  }

  /** @param {number} tabId @param {string} target */
  function allows(tabId, target) {
    return sessionFor(tabId).origins.has(exactOrigin(target) ?? '')
  }

  return {
    submit,
    stop,
    clear,
    state,
    grantOrigin,
    onTabChanged,
    onTabClosed,
    boundary,
    block,
    allows,
    get activeTabId() {
      return activeRun?.tabId ?? null
    },
    get running() {
      return Boolean(activeRun)
    },
  }
}
