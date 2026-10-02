// One scoped debugger lease for an autonomous run. Structural reads, visual
// reads and actions share this port, serialize CDP calls, and release whatever
// Troy attached when the run ends.

import { READ_PAGE_EXPRESSION, normaliseReadResult } from '../agent/read.js'
import { readPage } from '../read/pipeline.js'
import { toMarkdown } from '../read/render.js'
import { settle } from '../read/settle.js'

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
  let closed = false
  let epoch = 0
  let queue = Promise.resolve()

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
   * @param {import('../read/types.js').Box} [box]
   * @param {{ image?: Promise<import('electron').NativeImage>, cssWidth?: Promise<number> }} [cache]
   */
  const screenshot = async (box, cache = {}) => {
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

  const onNavigation = () => {
    epoch += 1
  }
  wc.on('did-navigate', onNavigation)
  wc.on('render-process-gone', onNavigation)

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
    async read() {
      const raw = await evaluate(READ_PAGE_EXPRESSION)
      return normaliseReadResult(String(raw), { url: wc.getURL(), title: wc.getTitle() })
    },
    async readVisual() {
      /** @type {{ image?: Promise<import('electron').NativeImage>, cssWidth?: Promise<number> }} */
      const captureCache = {}
      const doc = await readPage({
        evaluate: async (expression) => String(await evaluate(expression)),
        screenshot: (box) => screenshot(box, captureCache),
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
      wc.removeListener('render-process-gone', onNavigation)
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
