// Apple Vision OCR, compiled on demand, allowed to fail at every step.
//
// On macOS the best OCR for small antialiased web text is the system's own
// Vision framework, and the cheapest honest way to reach it from Node is a
// tiny Swift helper. Shipping a prebuilt binary would mean signing and
// architecture juggling for what is a single-file program, so the helper
// is compiled on first use with whatever swiftc the machine has, cached in
// the temp directory keyed by a hash of its own source, and rebuilt only
// when the source changes.
//
// Every step of that story can fail: wrong platform, no swiftc, a compile
// error on some future SDK, a helper that crashes on one crop. All of them
// degrade to "engine unavailable" or "region untranscribed", never to a
// broken read, because OCR is an enhancement to the pipeline and must
// never be a dependency of it.

import { execFile } from 'node:child_process'
import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** @typedef {import('./types.js').OcrEngine} OcrEngine */
/** @typedef {import('./types.js').OcrLine} OcrLine */

// The whole helper. Boxes come out of Vision normalized with the origin at
// the bottom left; the helper flips and scales them into top-left image
// pixels so the JavaScript side never needs to know Vision's conventions.
const SWIFT_SOURCE = `import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1,
      let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("troy-vision: could not load image\\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("troy-vision: recognition failed\\n".data(using: .utf8)!)
    exit(3)
}
let width = CGFloat(cg.width)
let height = CGFloat(cg.height)
var lines: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append([
        "text": candidate.string,
        "x": box.origin.x * width,
        "y": (1 - box.origin.y - box.size.height) * height,
        "w": box.size.width * width,
        "h": box.size.height * height,
        "confidence": candidate.confidence,
    ])
}
let data = try! JSONSerialization.data(withJSONObject: lines)
FileHandle.standardOutput.write(data)
`

/**
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>} stdout
 */
function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Build (or find the cached) helper binary. Resolves to its path, or null
 * on any failure at all: this function is the honesty boundary, and a null
 * from here is what makes available() answer false instead of the
 * pipeline finding out the hard way later.
 *
 * @returns {Promise<string | null>}
 */
async function ensureHelper() {
  if (process.platform !== 'darwin') return null
  try {
    await run('swiftc', ['--version'], 15000)
  } catch {
    return null
  }
  const hash = createHash('sha256').update(SWIFT_SOURCE).digest('hex').slice(0, 12)
  const dir = path.join(tmpdir(), `troy-vision-${hash}`)
  const binary = path.join(dir, 'troy-vision')
  if (await exists(binary)) return binary
  try {
    await mkdir(dir, { recursive: true })
    const source = path.join(dir, 'main.swift')
    await writeFile(source, SWIFT_SOURCE)
    // The first compile takes several seconds; every later run finds the
    // cached binary and pays nothing. 120s is generous on purpose, first
    // use of the toolchain on a fresh machine can be slow.
    await run('swiftc', ['-O', '-o', binary, source], 120000)
    return (await exists(binary)) ? binary : null
  } catch {
    return null
  }
}

/**
 * The Apple Vision engine. One ensureHelper() promise is shared for the
 * process lifetime so concurrent reads do not race two compiles into the
 * same cache directory.
 *
 * @returns {OcrEngine}
 */
export function appleVisionEngine() {
  /** @type {Promise<string | null> | null} */
  let helper = null
  const helperPath = () => {
    if (!helper) helper = ensureHelper()
    return helper
  }
  return {
    name: 'apple-vision',
    available: async () => (await helperPath()) !== null,
    recognize: async (png) => {
      const binary = await helperPath()
      if (!binary) return []
      const crop = path.join(tmpdir(), `troy-crop-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`)
      try {
        await writeFile(crop, png)
        const stdout = await run(binary, [crop], 30000)
        const parsed = /** @type {unknown} */ (JSON.parse(stdout))
        if (!Array.isArray(parsed)) return []
        /** @type {OcrLine[]} */
        const lines = []
        for (const entry of parsed) {
          const line = /** @type {{ text?: unknown, x?: unknown, y?: unknown, w?: unknown, h?: unknown, confidence?: unknown }} */ (
            entry
          )
          const text = String(line.text ?? '').trim()
          if (!text) continue
          lines.push({
            text,
            box: {
              x: Number(line.x ?? 0),
              y: Number(line.y ?? 0),
              w: Number(line.w ?? 0),
              h: Number(line.h ?? 0),
            },
            confidence: Number(line.confidence ?? 0),
          })
        }
        return lines
      } finally {
        await rm(crop, { force: true }).catch(() => undefined)
      }
    },
  }
}
