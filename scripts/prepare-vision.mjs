// Build Troy's own Apple Vision OCR helper for one macOS release target.
// Generated binaries live outside the asar under build/ocr.

import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SWIFT_SOURCE } from '../src/read/apple-vision.js'

const run = promisify(execFile)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const requestedArch = valueAfter('--arch') || process.env.npm_config_arch || process.arch
const work = path.join(root, '.vision-build', `${requestedArch}-${process.pid}-${Date.now()}`)
const staging = path.join(work, 'ocr')
const output = path.join(root, 'build', 'ocr')

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? '' : String(process.argv[index + 1] ?? '')
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('ocr: Apple Vision helper is macOS-only; nothing to build')
    return
  }
  if (await exists(output)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
      if (manifest.platform === 'darwin' && manifest.arch === requestedArch && await exists(path.join(output, 'troy-vision'))) {
        console.log(`ocr: reusing ${path.relative(root, output)}`)
        return
      }
    } catch {
      // Fall through to the explicit refusal below.
    }
    const existing = await readdir(output)
    throw new Error(`${path.relative(root, output)} already exists with ${existing.length} item(s); refusing to overwrite it`)
  }

  await mkdir(staging, { recursive: true })
  const source = path.join(work, 'main.swift')
  const binary = path.join(staging, 'troy-vision')
  await writeFile(source, SWIFT_SOURCE)
  const target = requestedArch === 'x64' ? 'x86_64-apple-macosx12.0' : 'arm64-apple-macosx12.0'
  console.log(`ocr: compiling Apple Vision helper for ${requestedArch}`)
  await run('xcrun', ['swiftc', '-O', '-target', target, '-o', binary, source], { maxBuffer: 8 * 1024 * 1024 })
  await chmod(binary, 0o755)
  await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify({
    helper: 'troy-vision',
    framework: 'Apple Vision',
    platform: 'darwin',
    arch: requestedArch,
    target,
  }, null, 2)}\n`)
  await mkdir(path.dirname(output), { recursive: true })
  await rename(staging, output)
  console.log(`ocr: prepared ${path.relative(root, output)}`)
}

await main()
