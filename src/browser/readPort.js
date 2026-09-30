// Adapter from a live tab to the read pipeline.
//
// The pipeline (src/read/pipeline.js) asks for exactly two capabilities:
// evaluate an expression, optionally screenshot a clip. This file is the
// ten-line promise that comment makes good on, plus the fiddly parts those
// two capabilities hide: attaching the debugger only for the duration of
// the read so DevTools are never locked out, unwrapping CDP's by-value
// results into what extract() expects, and turning webContents.capturePage
// output into the PNG clip the OCR stage wants.

import { readPage } from '../read/pipeline.js'
import { toMarkdown } from '../read/render.js'

/**
 * @param {import('electron').WebContents} wc
 * @returns {{ evaluate: (expression: string) => Promise<string>, attachedHere: boolean }}
 */
function attach(wc) {
  const attachedHere = !wc.debugger.isAttached()
  if (attachedHere) wc.debugger.attach('1.3')
  return {
    attachedHere,
    async evaluate(expression) {
      const { result } = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      // Exception details mean the page fought back (a CSP-blocked probe, a
      // crashed frame); surface the text rather than an empty string, since
      // "undefined" would send every caller hunting a phantom bug.
      if (result.type === 'error' || result.subtype === 'error') {
        throw new Error(String(result.description ?? 'evaluation failed'))
      }
      if (result.type === 'undefined') return 'undefined'
      return String(result.value ?? '')
    },
  }
}

/**
 * Capture one clip of the live tab as PNG pixels.
 *
 * capturePage hands back the whole visible view in device pixels; the
 * pipeline speaks css pixels, so the image is cropped through NativeImage
 * after scaling the box by the device scale factor. A failed capture
 * rejects, and the caller degrades that region to untranscribed rather
 * than failing the read, which is why no heroic recovery lives here.
 *
 * @param {import('electron').WebContents} wc
 * @param {import('../read/types.js').Box} [box]
 * @returns {Promise<Buffer>}
 */
async function captureClip(wc, box) {
  const image = await wc.capturePage()
  if (!box) return image.toPNG()
  // Device pixels per css pixel, derived rather than assumed: display
  // scaling and zoom both live in this ratio, and the page itself is the
  // only authority on its css width.
  const { evaluate } = attach(wc)
  const cssWidth = Number(await evaluate('window.innerWidth')) || image.getSize().width
  const dpr = image.getSize().width / cssWidth
  const cropped = image.crop({
    x: Math.round(box.x * dpr),
    y: Math.round(box.y * dpr),
    width: Math.max(Math.round(box.w * dpr), 1),
    height: Math.max(Math.round(box.h * dpr), 1),
  })
  return cropped.toPNG()
}

/**
 * Read the page in this tab: settle, extract, cover, transcribe, fuse.
 *
 * @param {import('electron').WebContents} wc
 * @param {{ settleTimeoutMs?: number }} [opts]
 */
export async function readTab(wc, opts = {}) {
  const { evaluate, attachedHere } = attach(wc)
  try {
    const doc = await readPage(
      {
        evaluate,
        screenshot: (box) => captureClip(wc, box),
      },
      opts,
    )
    return doc
  } finally {
    // Leaving the debugger attached locks DevTools out of the tab for good,
    // so detach whatever this read attached, even when the read threw.
    if (attachedHere && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // Already gone with the renderer; nothing to release.
      }
    }
  }
}

/**
 * The panel-facing shape: fused document plus the scalar summary the agent
 * panel has rendered since the first cut, so old callers keep working.
 *
 * @param {Awaited<ReturnType<typeof readTab>>} doc
 */
export function summariseDocument(doc) {
  const visible = doc.blocks.filter((b) => b.source === 'dom')
  const characters = doc.blocks.reduce((n, b) => n + b.text.length, 0)
  return {
    url: doc.url,
    title: doc.title,
    blockCount: doc.blocks.length,
    domBlockCount: visible.length,
    ocrBlockCount: doc.blocks.length - visible.length,
    regionCount: doc.regions.length,
    settled: doc.stats.settled,
    elapsedMs: doc.stats.elapsedMs,
    ocrEngine: doc.stats.ocrEngine,
    characterCount: characters,
    markdown: toMarkdown(doc),
    degraded: doc.stats.settled === false,
  }
}
