import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createOcrEngine } from '../src/read/ocr-factory.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

async function tempResources(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'troy-ocr-factory-'))
  cleanups.push(() => void rm(directory, { recursive: true, force: true }))
  return directory
}

describe('OCR engine selection', () => {
  it('uses the honest stub on Windows and Linux without touching macOS tooling', async () => {
    for (const platform of ['win32', 'linux']) {
      const engine = createOcrEngine({ platform, packaged: true, resourcesPath: '/missing' })
      expect(engine.name).toBe('none')
      expect(await engine.available()).toBe(false)
    }
  })

  it('uses a packaged Apple Vision helper when one is present', async () => {
    const resources = await tempResources()
    const directory = path.join(resources, 'ocr')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'troy-vision'), 'fixture')
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ platform: 'darwin', arch: process.arch }))
    const engine = createOcrEngine({ platform: 'darwin', arch: process.arch, packaged: true, resourcesPath: resources })
    expect(engine.name).toBe('apple-vision')
    expect(await engine.available()).toBe(true)
    const wrongArch = createOcrEngine({ platform: 'darwin', arch: 'wrong-arch', packaged: true, resourcesPath: resources })
    expect(await wrongArch.available()).toBe(false)
  })

  it('degrades to unavailable when a packaged helper is missing', async () => {
    const resources = await tempResources()
    const engine = createOcrEngine({ platform: 'darwin', packaged: true, resourcesPath: resources })
    expect(engine.name).toBe('apple-vision')
    expect(await engine.available()).toBe(false)
  })
})
