// The read pipeline, assembled: settle, extract, cover, transcribe, fuse.
//
// Each stage is its own module and its own idea; this file only sequences
// them and keeps the clock. It takes the minimal ReadPort rather than the
// full Cdp interface, so the same call serves three hosts today: headless
// Chromium through the Playwright-backed port, the live Electron tab
// through a ten-line debugger adapter in main.js, and any future host that
// can evaluate a string and maybe take a screenshot.

import { settle } from './settle.js'
import { extract } from './extract.js'
import { cover } from './cover.js'
import { fuse } from './fuse.js'
import { stubEngine, transcribe } from './ocr.js'

/** @typedef {import('./types.js').ReadPort} ReadPort */
/** @typedef {import('./types.js').ReadDocument} ReadDocument */
/** @typedef {import('./types.js').OcrEngine} OcrEngine */

/**
 * Read the page the port is looking at and return one fused document.
 *
 * @param {ReadPort} port
 * @param {{ settleTimeoutMs?: number, ocr?: OcrEngine }} [opts]
 *   The OCR engine defaults to the stub, which reports regions as
 *   untranscribed. Callers opt into a real engine; the pipeline never
 *   goes looking for one on its own, because which engine is acceptable
 *   (cost, privacy, platform) is the caller's decision to make.
 * @returns {Promise<ReadDocument>}
 */
export async function readPage(port, opts = {}) {
  const startedAt = Date.now()
  const engine = opts.ocr ?? stubEngine()

  const settled = await settle(port.evaluate, { timeoutMs: opts.settleTimeoutMs ?? 10000 })
  const extraction = await extract(port.evaluate)
  const regions = cover(extraction.candidates, extraction.blocks, extraction.viewport)
  const ocr = await transcribe(port, regions, engine)
  const blocks = fuse(extraction.blocks, ocr.blocks)

  return {
    url: extraction.url,
    title: extraction.title,
    blocks,
    regions,
    stats: {
      settled: settled.settled,
      settleMs: settled.elapsedMs,
      elapsedMs: Date.now() - startedAt,
      regionCount: regions.length,
      ocrEngine: ocr.engine,
      transcribed: ocr.transcribed,
    },
  }
}
