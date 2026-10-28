// Validate and transcribe one local PCM WAV. Audio never leaves the machine;
// temporary files are private and removed after whisper.cpp exits.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { transcribeWithWhisper } from './whisper.js'

export const VOICE_SAMPLE_RATE = 16000
export const MAX_VOICE_SECONDS = 60
export const MAX_VOICE_BYTES = VOICE_SAMPLE_RATE * 2 * MAX_VOICE_SECONDS + 4096

/**
 * @param {Buffer} wav
 * @returns {{ ok: true, durationSeconds: number, dataBytes: number } | { error: string }}
 */
export function validateVoiceWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return { error: 'audio is not a complete WAV file' }
  if (wav.length > MAX_VOICE_BYTES) return { error: `audio exceeds the ${MAX_VOICE_SECONDS}-second limit` }
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: 'audio must be a RIFF/WAVE file' }
  }

  let offset = 12
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataBytes = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > wav.length) return { error: 'audio contains a truncated WAV chunk' }
    if (id === 'fmt ' && size >= 16) {
      format = wav.readUInt16LE(start)
      channels = wav.readUInt16LE(start + 2)
      sampleRate = wav.readUInt32LE(start + 4)
      bits = wav.readUInt16LE(start + 14)
    } else if (id === 'data') {
      dataBytes = size
    }
    offset = start + size + (size % 2)
  }

  if (format !== 1 || channels !== 1 || sampleRate !== VOICE_SAMPLE_RATE || bits !== 16) {
    return { error: 'audio must be 16kHz mono 16-bit PCM' }
  }
  if (dataBytes <= 0) return { error: 'audio contains no samples' }
  const durationSeconds = dataBytes / (sampleRate * channels * (bits / 8))
  if (durationSeconds > MAX_VOICE_SECONDS + 0.05) return { error: `audio exceeds the ${MAX_VOICE_SECONDS}-second limit` }
  return { ok: true, durationSeconds, dataBytes }
}

/**
 * @param {Buffer} wav
 * @param {{ available: boolean, binary: string, model: string }} assets
 * @param {{ signal?: AbortSignal, transcribeImpl?: typeof transcribeWithWhisper }} [opts]
 */
export async function transcribeLocalWav(wav, assets, opts = {}) {
  const valid = validateVoiceWav(wav)
  if ('error' in valid) return valid
  if (!assets.available) return { error: 'the local voice model is not installed; typing remains available' }
  if (opts.signal?.aborted) return { error: 'transcription cancelled', cancelled: true }

  const directory = await mkdtemp(path.join(tmpdir(), 'troy-voice-'))
  const wavFile = path.join(directory, 'speech.wav')
  const outputBase = path.join(directory, 'transcript')
  try {
    await writeFile(wavFile, wav, { mode: 0o600 })
    const transcribe = opts.transcribeImpl ?? transcribeWithWhisper
    const text = (await transcribe({
      binary: assets.binary,
      model: assets.model,
      wavFile,
      outputBase,
      signal: opts.signal,
    })).trim()
    return text ? { ok: true, text, durationSeconds: valid.durationSeconds } : { error: 'no speech was recognized' }
  } catch (error) {
    if (/** @type {Error} */ (error)?.name === 'AbortError' || opts.signal?.aborted) {
      return { error: 'transcription cancelled', cancelled: true }
    }
    return { error: String(/** @type {Error} */ (error)?.message ?? error) }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
