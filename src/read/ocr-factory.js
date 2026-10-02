// Select a process-wide OCR engine without making OCR a startup dependency.
// Packaged macOS builds use the shipped Vision helper; development may compile
// it on demand. Other platforms keep the honest no-engine fallback.

import fs from 'node:fs'
import path from 'node:path'
import { appleVisionEngine } from './apple-vision.js'
import { stubEngine } from './ocr.js'

/**
 * @param {{ platform?: string, arch?: string, resourcesPath?: string, packaged?: boolean }} [opts]
 */
export function createOcrEngine(opts = {}) {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  if (platform !== 'darwin') return stubEngine()
  let binaryPath
  if (opts.resourcesPath) {
    const directory = path.join(opts.resourcesPath, 'ocr')
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
      if (manifest.platform === 'darwin' && manifest.arch === arch) binaryPath = path.join(directory, 'troy-vision')
    } catch {
      // A partial or wrong-architecture helper is unavailable.
    }
  }
  return appleVisionEngine({
    binaryPath,
    allowCompile: !opts.packaged,
  })
}
