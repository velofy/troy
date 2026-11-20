// One scoped debugger lease for an autonomous run. Structural reads, visual
// reads and actions share this port, serialize CDP calls, capture per-tab
// console/network ring buffers, and release whatever Troy attached when the
// run ends.

import { READ_PAGE_EXPRESSION, normaliseReadResult } from '../agent/read.js'
import { readPage } from '../read/pipeline.js'
import { toMarkdown } from '../read/render.js'
import { settle } from '../read/settle.js'

const MAX_LOG_ENTRIES = 100
const MAX_PENDING_REQUESTS = 200
const MAX_FULLPAGE_HEIGHT = 16384

/** @type {Record<string, { key: string, code: string, windowsVirtualKeyCode: number, text?: string }>} */
const SPECIAL_KEYS = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  del: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}

/**
 * Parse a key or chord string like "Enter", "Control+A", "Meta+Shift+K" into
 * CDP Input.dispatchKeyEvent parameters.
 *
 * @param {string} combo
 * @returns {{ modifiers: number, key: string, code: string, windowsVirtualKeyCode: number, text?: string }}
 */
export function parseKeyCombo(combo) {
  const raw = String(combo ?? '').trim()
  if (!raw) throw new Error('key combo is empty')
  // Preserve literal '+' when combo is '+' or ends with '++'
  const parts = raw === '+' ? ['+'] : raw.split('+').map((p) => p.trim()).filter(Boolean)
  let modifiers = 0
  let main = parts[parts.length - 1] ?? raw
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase()
    if (mod === 'alt' || mod === 'option') modifiers |= 1
    else if (mod === 'control' || mod === 'ctrl') modifiers |= 2
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command' || mod === 'super') modifiers |= 4
    else if (mod === 'shift') modifiers |= 8
    else throw new Error(`unknown key modifier "${parts[i]}"`)
  }
  const lower = main.toLowerCase()
  const special = SPECIAL_KEYS[lower]
  if (special) {
    const text = special.text && !(modifiers & (1 | 2 | 4)) ? special.text : undefined
    return {
      modifiers,
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.windowsVirtualKeyCode,
      ...(text !== undefined ? { text } : {}),
    }
  }
  if (main.length === 1) {
    const ch = main
    const upper = ch.toUpperCase()
    const isLetter = /^[A-Z]$/.test(upper)
    const isDigit = /^[0-9]$/.test(ch)
    if (isLetter && ch === upper && !(modifiers & 8) && (modifiers & (1 | 2 | 4)) === 0) {
      modifiers |= 8
    }
    const key = isLetter && (modifiers & (1 | 2 | 4)) && !(modifiers & 8) ? ch.toLowerCase() : ch
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : ''
    const vk = upper.charCodeAt(0)
    const text = (modifiers & (1 | 2 | 4)) === 0 ? key : undefined
    return {
      modifiers,
      key,
      code,
      windowsVirtualKeyCode: vk,
      ...(text !== undefined ? { text } : {}),
    }
  }
  return {
    modifiers,
    key: main,
    code: main,
    windowsVirtualKeyCode: 0,
  }
}

/** @param {AbortSignal | undefined} signal */
function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

/**
 * @param {import('electron').WebContents} wc
 * @param {{ tabId: number, signal?: AbortSignal, ocr?: import('../read/types.js').OcrEngine }} opts
 */
export function createTabPort(wc, opts) {
  let attachedHere = false
  let attached = false
  let cdpEventsEnabled = false
  let closed = false
  let epoch = 0
  let queue = Promise.resolve()

  /** @type {Array<{ level: string, text: string, source: string, line: number, ts: number }>} */
  const consoleLogs = []
  /** @type {Array<{ url: string, method: string, status: number, statusText?: string, mimeType?: string, type: string, errorText?: string, ok: boolean, failed: boolean, ts: number }>} */
  const networkLogs = []
  /** @type {Map<string, { url: string, method: string, type: string, ts: number }>} */
  const pendingRequests = new Map()

  /** @param {{ level: string, text: string, source: string, line: number, ts: number }} entry */
  const pushConsole = (entry) => {
    consoleLogs.push(entry)
    if (consoleLogs.length > MAX_LOG_ENTRIES) {
      consoleLogs.splice(0, consoleLogs.length - MAX_LOG_ENTRIES)
    }
  }

  /** @param {{ url: string, method: string, status: number, statusText?: string, mimeType?: string, type: string, errorText?: string, ok: boolean, failed: boolean, ts: number }} entry */
  const pushNetwork = (entry) => {
    networkLogs.push(entry)
    if (networkLogs.length > MAX_LOG_ENTRIES) {
      networkLogs.splice(0, networkLogs.length - MAX_LOG_ENTRIES)
    }
  }

  /**
   * @param {any} event
   * @param {number} [legacyLevel]
   * @param {string} [legacyMessage]
   * @param {number} [legacyLine]
   * @param {string} [legacySourceId]
   */
  const onConsoleMessage = (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
    const rawLevel = typeof legacyLevel === 'number' ? legacyLevel : event?.level
    const levelMap = ['verbose', 'log', 'warning', 'error']
    const normalized =
      typeof rawLevel === 'string'
        ? rawLevel === 'info'
          ? 'log'
          : rawLevel === 'warn'
            ? 'warning'
            : rawLevel
        : (levelMap[Number(rawLevel ?? 1)] ?? 'log')
    const text = String(typeof legacyMessage === 'string' ? legacyMessage : event?.message ?? '')
    const line = Number(typeof legacyLine === 'number' ? legacyLine : event?.lineNumber ?? 0)
    const source = String(typeof legacySourceId === 'string' ? legacySourceId : event?.sourceId ?? '')
    pushConsole({ level: normalized, text: text.slice(0, 1000), source, line, ts: Date.now() })
  }

  /**
   * @param {any} _event
   * @param {number} errorCode
   * @param {string} errorDescription
   * @param {string} validatedURL
   */
  const onDidFailLoad = (_event, errorCode, errorDescription, validatedURL) => {
    pushNetwork({
      url: String(validatedURL ?? ''),
      method: 'GET',
      status: 0,
      type: 'Document',
      errorText: `${errorDescription || 'load failed'} (${errorCode})`,
      ok: false,
      failed: true,
      ts: Date.now(),
    })
  }

  /**
   * @param {any} _event
   * @param {string} method
   * @param {Record<string, any>} params
   */
  const onDebuggerMessage = (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails ?? {}
      const text = String(details.exception?.description ?? details.text ?? 'uncaught exception')
      pushConsole({
        level: 'error',
        text: text.slice(0, 1000),
        source: String(details.url ?? ''),
        line: Number(details.lineNumber ?? 0),
        ts: Date.now(),
      })
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const requestId = String(params?.requestId ?? '')
      if (!requestId) return
      pendingRequests.set(requestId, {
        url: String(params?.request?.url ?? ''),
        method: String(params?.request?.method ?? 'GET'),
        type: String(params?.type ?? ''),
        ts: Date.now(),
      })
      if (pendingRequests.size > MAX_PENDING_REQUESTS) {
        const oldest = pendingRequests.keys().next().value
        if (oldest !== undefined) pendingRequests.delete(oldest)
      }
      return
    }
    if (method === 'Network.responseReceived') {
      const requestId = String(params?.requestId ?? '')
      const req = pendingRequests.get(requestId)
      pendingRequests.delete(requestId)
      const res = params?.response ?? {}
      const status = Number(res.status ?? 0)
      pushNetwork({
        url: String(res.url ?? req?.url ?? ''),
        method: req?.method ?? 'GET',
        status,
        statusText: String(res.statusText ?? ''),
        mimeType: String(res.mimeType ?? ''),
        type: String(params?.type ?? req?.type ?? ''),
        ok: status > 0 && status < 400,
        failed: status >= 400,
        ts: Date.now(),
      })
      return
    }
    if (method === 'Network.loadingFailed') {
      const requestId = String(params?.requestId ?? '')
      const req = pendingRequests.get(requestId)
      pendingRequests.delete(requestId)
      pushNetwork({
        url: String(req?.url ?? ''),
        method: req?.method ?? 'GET',
        status: 0,
        type: String(params?.type ?? req?.type ?? ''),
        errorText: String(params?.errorText ?? 'loading failed'),
        ok: false,
        failed: true,
        ts: Date.now(),
      })
    }
  }

  const assertUsable = () => {
    if (closed || wc.isDestroyed()) throw new Error('the tab is no longer available')
    if (opts.signal?.aborted) throw abortError(opts.signal)
  }

  const ensureAttached = () => {
    assertUsable()
    if (attached) return
    attachedHere = !wc.debugger.isAttached()
    if (attachedHere) wc.debugger.attach('1.3')
    attached = true
    if (!cdpEventsEnabled) {
      cdpEventsEnabled = true
      try {
        wc.debugger.on('message', onDebuggerMessage)
        void wc.debugger.sendCommand('Runtime.enable').catch(() => {})
        void wc.debugger.sendCommand('Network.enable').catch(() => {})
      } catch {
        // Best-effort event subscriptions for console/network telemetry.
      }
    }
  }

  /** @param {() => Promise<any>} operation */
  const serial = (operation) => {
    const next = queue.then(async () => {
      assertUsable()
      return operation()
    })
    queue = next.catch(() => undefined)
    return next
  }

  /** @param {string} expression */
  const evaluate = (expression) =>
    serial(async () => {
      ensureAttached()
      const { result, exceptionDetails } = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (exceptionDetails) throw new Error(String(exceptionDetails.text ?? result.description ?? 'evaluation failed'))
      if (result.type === 'error' || result.subtype === 'error') {
        throw new Error(String(result.description ?? 'evaluation failed'))
      }
      if (result.type === 'undefined') return 'undefined'
      return result.value
    })

  /**
   * Internal PNG buffer capture used by Troy's fused DOM+OCR visual reader.
   *
   * @param {import('../read/types.js').Box} [box]
   * @param {{ image?: Promise<import('electron').NativeImage>, cssWidth?: Promise<number> }} [cache]
   */
  const captureBox = async (box, cache = {}) => {
    assertUsable()
    cache.image ??= wc.capturePage()
    const image = await cache.image
    if (!box) return image.toPNG()
    cache.cssWidth ??= evaluate('window.innerWidth').then((value) => Number(value) || image.getSize().width)
    const cssWidth = await cache.cssWidth
    const scale = image.getSize().width / cssWidth
    return image
      .crop({
        x: Math.round(box.x * scale),
        y: Math.round(box.y * scale),
        width: Math.max(1, Math.round(box.w * scale)),
        height: Math.max(1, Math.round(box.h * scale)),
      })
      .toPNG()
  }

  /**
   * Capture a PNG screenshot (viewport, full scrollable page, or element clip)
   * returned as base64 data + pixel dimensions.
   *
   * @param {{ fullPage?: boolean, clip?: { x: number, y: number, width: number, height: number } }} [options]
   * @returns {Promise<{ mimeType: 'image/png', data: string, width: number, height: number }>}
   */
  const screenshot = async (options = {}) => {
    const fullPage = Boolean(options?.fullPage)
    const clip = options?.clip
    return serial(async () => {
      ensureAttached()
      /** @type {Record<string, any>} */
      const params = { format: 'png' }
      let width = 0
      let height = 0
      if (clip) {
        width = Math.max(1, Math.round(clip.width))
        height = Math.max(1, Math.round(clip.height))
        params.clip = {
          x: Math.max(0, Math.round(clip.x)),
          y: Math.max(0, Math.round(clip.y)),
          width,
          height,
          scale: 1,
        }
        params.captureBeyondViewport = true
      } else if (fullPage) {
        try {
          const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics')
          const content = metrics?.cssContentSize ?? metrics?.contentSize
          if (content && content.width > 0 && content.height > 0) {
            width = Math.max(1, Math.round(content.width))
            height = Math.min(MAX_FULLPAGE_HEIGHT, Math.max(1, Math.round(content.height)))
            params.clip = { x: 0, y: 0, width, height, scale: 1 }
          }
        } catch {
          // Fall back to captureBeyondViewport without explicit clip.
        }
        params.captureBeyondViewport = true
      }
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let shotTimer
      try {
        /** @type {any} */
        const res = await Promise.race([
          wc.debugger.sendCommand('Page.captureScreenshot', params),
          new Promise((_, reject) => {
            shotTimer = setTimeout(() => reject(new Error('Page.captureScreenshot timed out')), 4000)
          }),
        ])
        if (res && typeof res.data === 'string' && res.data.length > 0) {
          if (!width || !height) {
            try {
              const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics')
              const vp = metrics?.cssVisualViewport ?? metrics?.visualViewport
              width = Math.round(Number(vp?.clientWidth ?? 0))
              height = Math.round(Number(vp?.clientHeight ?? 0))
            } catch {
              // Dimensions stay 0 if layout metrics are unavailable.
            }
          }
          return { mimeType: /** @type {const} */ ('image/png'), data: res.data, width, height }
        }
      } catch (err) {
        if (fullPage) throw err
      } finally {
        if (shotTimer !== undefined) clearTimeout(shotTimer)
      }
      const image = await wc.capturePage(
        clip
          ? {
              x: Math.max(0, Math.round(clip.x)),
              y: Math.max(0, Math.round(clip.y)),
              width: Math.max(1, Math.round(clip.width)),
              height: Math.max(1, Math.round(clip.height)),
            }
          : undefined,
      )
      const size = image.getSize()
      return {
        mimeType: /** @type {const} */ ('image/png'),
        data: image.toPNG().toString('base64'),
        width: size.width,
        height: size.height,
      }
    })
  }

  /**
   * Dispatch a trusted keyboard press via CDP Input.dispatchKeyEvent.
   *
   * @param {string} combo
   */
  const pressKey = (combo) => {
    const spec = parseKeyCombo(combo)
    return serial(async () => {
      ensureAttached()
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        modifiers: spec.modifiers,
        key: spec.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
        ...(spec.text !== undefined ? { text: spec.text, unmodifiedText: spec.text } : {}),
      })
      if (spec.text !== undefined) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'char',
          modifiers: spec.modifiers,
          text: spec.text,
          unmodifiedText: spec.text,
          key: spec.key,
          code: spec.code,
          windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        })
      }
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: spec.modifiers,
        key: spec.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
        nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      })
    })
  }

  /**
   * Dispatch a trusted mouse movement via CDP Input.dispatchMouseEvent.
   *
   * @param {number} x
   * @param {number} y
   */
  const hoverPoint = (x, y) =>
    serial(async () => {
      ensureAttached()
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x),
        y: Math.round(y),
        button: 'none',
        buttons: 0,
      })
    })

  /**
   * Wait briefly for a navigation/reload event to complete on wc.
   *
   * @param {() => void} trigger
   */
  const runNavigationAction = async (trigger) => {
    assertUsable()
    await new Promise((resolve) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', done)
        wc.removeListener('did-navigate-in-page', done)
        wc.removeListener('did-fail-load', done)
        resolve(undefined)
      }
      const timer = setTimeout(done, 5000)
      wc.once('did-stop-loading', done)
      wc.once('did-navigate-in-page', done)
      wc.once('did-fail-load', done)
      try {
        trigger()
      } catch {
        done()
      }
    })
  }

  /**
   * Navigate back, forward, or reload the tab, invalidating the document epoch
   * and waiting for the page to settle.
   *
   * @param {'back' | 'forward' | 'reload'} direction
   */
  const history = async (direction) => {
    assertUsable()
    const nav = /** @type {any} */ (wc).navigationHistory
    if (direction === 'back') {
      const canGoBack = nav ? nav.canGoBack() : Boolean(/** @type {any} */ (wc).canGoBack?.())
      if (!canGoBack) return { ok: false, error: 'cannot go back: no previous history entry', url: wc.getURL() }
      await runNavigationAction(() => {
        if (nav) nav.goBack()
        else /** @type {any} */ (wc).goBack()
      })
    } else if (direction === 'forward') {
      const canGoForward = nav ? nav.canGoForward() : Boolean(/** @type {any} */ (wc).canGoForward?.())
      if (!canGoForward) return { ok: false, error: 'cannot go forward: no forward history entry', url: wc.getURL() }
      await runNavigationAction(() => {
        if (nav) nav.goForward()
        else /** @type {any} */ (wc).goForward()
      })
    } else if (direction === 'reload') {
      await runNavigationAction(() => {
        wc.reload()
      })
    } else {
      return { ok: false, error: `unknown history direction "${String(direction)}"` }
    }
    epoch += 1
    await settle(async (expression) => String(await evaluate(expression)), { timeoutMs: 10_000 }).catch(() => undefined)
    return { ok: true, direction, url: wc.getURL(), title: wc.getTitle() }
  }

  /**
   * @param {{ clear?: boolean, level?: string, limit?: number }} [options]
   */
  const getConsoleLogs = (options = {}) => {
    const level = String(options?.level ?? 'all').toLowerCase()
    const limit = Math.min(Math.max(Number(options?.limit ?? 50) || 50, 1), MAX_LOG_ENTRIES)
    const filtered = level === 'all' ? [...consoleLogs] : consoleLogs.filter((entry) => entry.level === level)
    const entries = filtered.slice(-limit)
    if (options?.clear) consoleLogs.length = 0
    return { count: entries.length, entries }
  }

  /**
   * @param {{ clear?: boolean, failedOnly?: boolean, limit?: number }} [options]
   */
  const getNetworkLogs = (options = {}) => {
    const failedOnly = Boolean(options?.failedOnly)
    const limit = Math.min(Math.max(Number(options?.limit ?? 50) || 50, 1), MAX_LOG_ENTRIES)
    const filtered = failedOnly
      ? networkLogs.filter((entry) => entry.failed || entry.status >= 400)
      : [...networkLogs]
    const entries = filtered.slice(-limit)
    if (options?.clear) networkLogs.length = 0
    return { count: entries.length, entries }
  }

  const onNavigation = () => {
    epoch += 1
  }
  const wcAny = /** @type {any} */ (wc)
  wc.on('did-navigate', onNavigation)
  // A history/SPA navigation replaces the document under the same URL load:
  // refs captured before it must go stale too, or they act on a new page.
  wc.on('did-navigate-in-page', onNavigation)
  wc.on('render-process-gone', onNavigation)
  wcAny.on('console-message', onConsoleMessage)
  wc.on('did-fail-load', onDidFailLoad)

  return {
    tabId: opts.tabId,
    get epoch() {
      return epoch
    },
    context() {
      return { tabId: opts.tabId, url: wc.getURL(), epoch }
    },
    evaluate,
    screenshot,
    pressKey,
    hoverPoint,
    history,
    getConsoleLogs,
    getNetworkLogs,
    async read() {
      const raw = await evaluate(READ_PAGE_EXPRESSION)
      return normaliseReadResult(String(raw), { url: wc.getURL(), title: wc.getTitle() })
    },
    async readVisual() {
      /** @type {{ image?: Promise<import('electron').NativeImage>, cssWidth?: Promise<number> }} */
      const captureCache = {}
      const doc = await readPage({
        evaluate: async (expression) => String(await evaluate(expression)),
        screenshot: (box) => captureBox(box, captureCache),
      }, { ocr: opts.ocr })
      return {
        url: doc.url,
        title: doc.title,
        content: toMarkdown(doc),
        blockCount: doc.blocks.length,
        regionCount: doc.regions.length,
        ocrEngine: doc.stats.ocrEngine,
        degraded: !doc.stats.settled,
      }
    },
    async load(/** @type {string} */ url) {
      assertUsable()
      const onAbort = () => {
        try {
          wc.stop()
        } catch {
          // The renderer may already be gone.
        }
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await wc.loadURL(url)
        assertUsable()
        return { url: wc.getURL() }
      } finally {
        opts.signal?.removeEventListener('abort', onAbort)
      }
    },
    async settle() {
      return settle(async (expression) => String(await evaluate(expression)), { timeoutMs: 10_000 })
    },
    invalidate() {
      epoch += 1
    },
    async close() {
      if (closed) return
      closed = true
      wc.removeListener('did-navigate', onNavigation)
      wc.removeListener('did-navigate-in-page', onNavigation)
      wc.removeListener('render-process-gone', onNavigation)
      wcAny.removeListener('console-message', onConsoleMessage)
      wc.removeListener('did-fail-load', onDidFailLoad)
      if (cdpEventsEnabled) {
        try {
          wc.debugger.removeListener('message', onDebuggerMessage)
        } catch {
          // Already torn down.
        }
      }
      await queue.catch(() => undefined)
      if (attachedHere && !wc.isDestroyed() && wc.debugger.isAttached()) {
        try {
          wc.debugger.detach()
        } catch {
          // Renderer teardown already released it.
        }
      }
    },
  }
}
