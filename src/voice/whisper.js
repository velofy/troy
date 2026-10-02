// Fixed local whisper.cpp invocation. No shell, no provider credential, no
// network path: one packaged binary, one packaged model, one bounded WAV.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {{ resourcesPath: string, repoRoot: string, platform?: string, arch?: string }} opts
 */
export function whisperAssets(opts) {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const executable = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  const candidates = [
    path.join(opts.resourcesPath, 'voice'),
    path.join(opts.repoRoot, 'build', 'voice'),
  ]
  for (const directory of candidates) {
    const binary = path.join(directory, executable)
    const model = path.join(directory, 'ggml-tiny.bin')
    const manifestFile = path.join(directory, 'manifest.json')
    if (!fs.existsSync(binary) || !fs.existsSync(model) || !fs.existsSync(manifestFile)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (manifest.platform === platform && manifest.arch === arch && manifest.staticLink === true) {
        return { available: true, binary, model, directory, manifest }
      }
    } catch {
      // A partial or foreign native bundle is unavailable, never guessed at.
    }
  }
  return {
    available: false,
    binary: path.join(candidates[0], executable),
    model: path.join(candidates[0], 'ggml-tiny.bin'),
    directory: candidates[0],
  }
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ signal?: AbortSignal, timeoutMs?: number, execFileImpl?: typeof execFile }} [opts]
 */
export function runWhisper(file, args, opts = {}) {
  const run = opts.execFileImpl ?? execFile
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('cancelled', 'AbortError'))
      return
    }
    const child = run(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (error) reject(new Error(`local transcription failed: ${String(stderr || error.message).trim().slice(0, 500)}`))
        else resolve(String(stdout ?? ''))
      },
    )
    const onAbort = () => {
      child.kill()
      const error = opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('transcription cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param {{ binary: string, model: string, wavFile: string, outputBase: string, signal?: AbortSignal, execFileImpl?: typeof execFile }} opts
 */
export async function transcribeWithWhisper(opts) {
  await runWhisper(
    opts.binary,
    ['-m', opts.model, '-f', opts.wavFile, '-otxt', '-nt', '-l', 'auto', '-of', opts.outputBase],
    { signal: opts.signal, execFileImpl: opts.execFileImpl },
  )
  const output = `${opts.outputBase}.txt`
  try {
    return fs.readFileSync(output, 'utf8').trim()
  } catch {
    return ''
  }
}
