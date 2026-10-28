// Prepare and package exactly one native platform/architecture. A single host
// asset bundle must never be reused while electron-builder targets another.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mode = args.find((arg) => ['--dir', '--mac', '--win'].includes(arg)) ?? '--dir'
const arch = args.includes('--x64') ? 'x64' : args.includes('--arm64') ? 'arm64' : process.arch
const targetPlatform = mode === '--mac' ? 'darwin' : mode === '--win' ? 'win32' : process.platform

if (targetPlatform !== process.platform) {
  throw new Error(`native Troy packages must be built on their target OS: requested ${targetPlatform}, running ${process.platform}`)
}
if (!['x64', 'arm64'].includes(arch)) throw new Error(`unsupported package architecture ${arch}`)

const passthrough = args.filter((arg) => !['--dir', '--mac', '--win', '--x64', '--arm64'].includes(arg))
const whisper = path.join(root, 'scripts', 'prepare-whisper.mjs')
const vision = path.join(root, 'scripts', 'prepare-vision.mjs')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

console.log(`package: preparing ${targetPlatform}-${arch}`)
await run(process.execPath, [whisper, '--arch', arch], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
if (targetPlatform === 'darwin') {
  await run(process.execPath, [vision, '--arch', arch], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
}
await run(npm, ['run', 'clean'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
const targetFlag = mode === '--dir' ? [] : [mode]
await run(npm, ['exec', '--', 'electron-builder', ...targetFlag, `--${arch}`, ...(mode === '--dir' ? ['--dir'] : []), ...passthrough], {
  cwd: root,
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, TROY_TARGET_ARCH: arch },
})
