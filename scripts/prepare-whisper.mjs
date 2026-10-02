// Build pinned whisper.cpp assets for the current release target.
// Generated binaries and model weights live under build/voice and are ignored.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, statSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tag = 'v1.9.3'
const repository = 'https://github.com/ggml-org/whisper.cpp.git'
const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const modelSha256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
const requestedArch = valueAfter('--arch') || process.env.npm_config_arch || process.arch
const work = path.join(root, '.voice-build', `${process.platform}-${requestedArch}-${process.pid}-${Date.now()}`)
const source = path.join(work, 'whisper.cpp')
const cmakeBuild = path.join(source, 'build')
const output = path.join(root, 'build', 'voice')
const staging = path.join(work, 'voice')

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

async function sha256(file) {
  const hash = createHash('sha256')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

async function downloadModel(file) {
  if (await exists(file) && (await sha256(file)) === modelSha256) return
  const response = await fetch(modelUrl, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`model download returned HTTP ${response.status}`)
  const temporary = `${file}.download-${process.pid}-${Date.now()}`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o644, flags: 'wx' }))
  const actual = await sha256(temporary)
  if (actual !== modelSha256) {
    await unlink(temporary)
    throw new Error(`model checksum mismatch: expected ${modelSha256}, received ${actual}`)
  }
  await rename(temporary, file)
}

async function main() {
  if (await exists(output)) {
    const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    try {
      const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
      const reusable = manifest.tag === tag && manifest.platform === process.platform && manifest.arch === requestedArch && manifest.staticLink === true &&
        await exists(path.join(output, executable)) && await exists(path.join(output, 'ggml-tiny.bin')) &&
        await sha256(path.join(output, 'ggml-tiny.bin')) === modelSha256
      if (reusable) {
        console.log(`voice: reusing verified ${path.relative(root, output)}`)
        return
      }
    } catch {
      // Fall through to the explicit refusal below.
    }
    const existing = await readdir(output)
    throw new Error(`${path.relative(root, output)} already exists with ${existing.length} item(s); refusing to overwrite it`)
  }
  try {
    await run('cmake', ['--version'])
  } catch {
    throw new Error('cmake is required to build offline voice assets; install it before running npm run voice:prepare')
  }
  await mkdir(staging, { recursive: true })

  console.log(`voice: cloning whisper.cpp ${tag}`)
  await run('git', ['clone', '--depth', '1', '--branch', tag, repository, source], { maxBuffer: 4 * 1024 * 1024 })

  const configure = [
    '-S', source,
    '-B', cmakeBuild,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DBUILD_SHARED_LIBS=OFF',
  ]
  if (process.platform === 'darwin') {
    configure.push(`-DCMAKE_OSX_ARCHITECTURES=${requestedArch === 'x64' ? 'x86_64' : 'arm64'}`)
  }
  console.log(`voice: building whisper-cli for ${process.platform}-${requestedArch}`)
  await run('cmake', configure, { maxBuffer: 8 * 1024 * 1024 })
  await run('cmake', ['--build', cmakeBuild, '--config', 'Release', '--parallel', '2'], { maxBuffer: 8 * 1024 * 1024 })

  const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  const candidates = [
    path.join(cmakeBuild, 'bin', executable),
    path.join(cmakeBuild, 'bin', 'Release', executable),
  ]
  const built = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  if (!built) throw new Error(`whisper-cli was not found under ${path.join(cmakeBuild, 'bin')}`)
  await copyFile(built, path.join(staging, executable))
  if (process.platform !== 'win32') await chmod(path.join(staging, executable), 0o755)

  console.log('voice: downloading and verifying the tiny multilingual model')
  const model = path.join(staging, 'ggml-tiny.bin')
  await downloadModel(model)
  await copyFile(path.join(source, 'LICENSE'), path.join(staging, 'WHISPER_LICENSE.txt'))
  await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify({
    project: 'ggml-org/whisper.cpp',
    tag,
    platform: process.platform,
    arch: requestedArch,
    model: 'ggml-tiny.bin',
    modelSha256,
    modelBytes: (await stat(model)).size,
    staticLink: true,
  }, null, 2)}\n`)
  await mkdir(path.dirname(output), { recursive: true })
  await rename(staging, output)
  console.log(`voice: prepared ${path.relative(root, output)}`)
}

await main()
