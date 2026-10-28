import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// v0.1.6's packaged builds died at import time: main.js imports
// ../voice/whisper.js but electron-builder.yml never packaged src/voice.
// Source runs never noticed. This test pins the invariant instead.
describe('packaging', () => {
  it('electron-builder packages every src directory the code imports from', () => {
    const root = process.cwd()
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    const packaged = new Set([...yml.matchAll(/src\/([a-z0-9-]+)\/\*\*/gi)].map((m) => m[1]))

    const imported = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|mjs)$/.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8')
          for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
            const resolved = path.resolve(path.dirname(full), match[1])
            const rel = path.relative(path.join(root, 'src'), resolved)
            if (!rel.startsWith('..')) imported.add(rel.split(path.sep)[0])
          }
        }
      }
    }
    walk(path.join(root, 'src'))
    expect([...imported].filter((dir) => !packaged.has(dir))).toEqual([])
  })
})
