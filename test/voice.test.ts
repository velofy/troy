import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_VOICE_BYTES, transcribeLocalWav, validateVoiceWav } from '../src/voice/transcribe.js'
import { runWhisper, transcribeWithWhisper, whisperAssets } from '../src/voice/whisper.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

function wav(seconds = 0.1, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const bytes = Math.max(2, Math.floor(seconds * sampleRate * channels * bits / 8))
  const output = Buffer.alloc(44 + bytes)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + bytes, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(channels, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * channels * bits / 8, 28)
  output.writeUInt16LE(channels * bits / 8, 32)
  output.writeUInt16LE(bits, 34)
  output.write('data', 36)
  output.writeUInt32LE(bytes, 40)
  return output
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'troy-voice-test-'))
  cleanups.push(() => void rm(directory, { recursive: true, force: true }))
  return directory
}

describe('voice WAV validation', () => {
  it('accepts bounded 16kHz mono 16-bit PCM', () => {
    expect(validateVoiceWav(wav(1))).toMatchObject({ ok: true, durationSeconds: 1 })
  })

  it('rejects malformed, stereo, wrong-rate and oversized audio', () => {
    expect(validateVoiceWav(Buffer.from('not wav'))).toHaveProperty('error')
    expect(validateVoiceWav(wav(0.1, 48000))).toHaveProperty('error')
    expect(validateVoiceWav(wav(0.1, 16000, 2))).toHaveProperty('error')
    expect(validateVoiceWav(Buffer.alloc(MAX_VOICE_BYTES + 1))).toHaveProperty('error')
  })
})

describe('local transcription', () => {
  it('uses a private temporary WAV and removes it after success', async () => {
    let wavPath = ''
    const result = await transcribeLocalWav(
      wav(0.2),
      { available: true, binary: '/fixed/whisper-cli', model: '/fixed/model.bin' },
      {
        transcribeImpl: async (input) => {
          wavPath = input.wavFile
          expect(existsSync(wavPath)).toBe(true)
          return 'open the project page'
        },
      },
    )
    expect(result).toMatchObject({ ok: true, text: 'open the project page' })
    expect(existsSync(wavPath)).toBe(false)
  })

  it('keeps typing available when packaged assets are absent', async () => {
    expect(await transcribeLocalWav(wav(), { available: false, binary: '', model: '' })).toMatchObject({
      error: expect.stringMatching(/not installed|typing/i),
    })
  })
})

describe('whisper.cpp adapter', () => {
  it('finds only a directory containing both the fixed binary and model', async () => {
    const root = await tempDir()
    const resources = path.join(root, 'resources')
    const voice = path.join(resources, 'voice')
    await writeFile(path.join(root, 'placeholder'), '')
    await (await import('node:fs/promises')).mkdir(voice, { recursive: true })
    await writeFile(path.join(voice, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'), '')
    expect(whisperAssets({ resourcesPath: resources, repoRoot: root, platform: process.platform }).available).toBe(false)
    await writeFile(path.join(voice, 'ggml-tiny.bin'), '')
    await writeFile(path.join(voice, 'manifest.json'), JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      staticLink: true,
    }))
    expect(whisperAssets({ resourcesPath: resources, repoRoot: root, platform: process.platform, arch: process.arch })).toMatchObject({
      available: true,
      directory: voice,
    })
    expect(whisperAssets({ resourcesPath: resources, repoRoot: root, platform: process.platform, arch: 'wrong-arch' }).available).toBe(false)
  })

  it('invokes one fixed executable without a shell', async () => {
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = []
    const execFileImpl = ((file: string, args: string[], options: { shell?: boolean }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ file, args, shell: options.shell })
      queueMicrotask(() => callback(null, '', ''))
      return { kill: () => true }
    }) as never
    await runWhisper('/fixed/whisper-cli', ['-m', '/fixed/model', '-f', '/tmp/audio.wav'], { execFileImpl })
    expect(calls).toEqual([{
      file: '/fixed/whisper-cli',
      args: ['-m', '/fixed/model', '-f', '/tmp/audio.wav'],
      shell: undefined,
    }])
  })

  it('reads the explicit output file produced by whisper-cli', async () => {
    const directory = await tempDir()
    const outputBase = path.join(directory, 'transcript')
    const execFileImpl = ((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const at = args.indexOf('-of')
      void writeFile(`${args[at + 1]}.txt`, 'hello locally\n').then(() => callback(null, '', ''))
      return { kill: () => true }
    }) as never
    expect(await transcribeWithWhisper({
      binary: '/fixed/whisper-cli',
      model: '/fixed/model',
      wavFile: '/tmp/audio.wav',
      outputBase,
      execFileImpl,
    })).toBe('hello locally')
  })
})
