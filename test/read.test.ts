import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { launchHeadless } from '../src/cdp/playwright.js'
import { readPage } from '../src/read/pipeline.js'
import { fuse } from '../src/read/fuse.js'
import { cover } from '../src/read/cover.js'
import { extract } from '../src/read/extract.js'
import { toMarkdown } from '../src/read/render.js'
import type { DomBlock, CoverCandidate } from '../src/read/types.js'

const cdp = await launchHeadless()
afterAll(() => cdp.close())

// Serves the fixture pages the PRD acceptance criteria were written against.
const fixtures = path.join(import.meta.dirname, 'fixtures')
const server = http.createServer((req, res) => {
  const name = (req.url ?? '/').slice(1)
  const file = path.join(fixtures, path.basename(name))
  try {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(fs.readFileSync(file))
  } catch {
    res.writeHead(404)
    res.end('no such fixture')
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as AddressInfo).port
afterAll(() => server.close())

/** Navigate the shared headless tab and run the whole pipeline on a fixture. */
async function readFixture(name: string) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/${name}` })
  return readPage(cdp)
}

function expectations(name: string): { mustContain: string[]; mustNotContain: string[] } {
  return JSON.parse(
    fs.readFileSync(path.join(fixtures, 'expected', `${name}.json`), 'utf8'),
  )
}

describe('read pipeline', () => {
  it('reads the plain article with every fact present and zero OCR regions', async () => {
    const doc = await readFixture('article.html')
    const text = doc.blocks.map((b) => b.text).join('\n')
    for (const wanted of expectations('article').mustContain) {
      expect(text).toContain(wanted)
    }
    // A plain article costs nothing at the pixel stage: that is the deal
    // that makes OCR affordable everywhere else.
    expect(doc.stats.regionCount).toBe(0)
    expect(doc.stats.settled).toBe(true)
  })

  it('never publishes the hidden-text traps but keeps the visible line', async () => {
    const doc = await readFixture('hidden-text.html')
    const text = doc.blocks.map((b) => b.text).join('\n')
    const rules = expectations('hidden-text')
    for (const wanted of rules.mustContain) expect(text).toContain(wanted)
    for (const banned of rules.mustNotContain) expect(text).not.toContain(banned)
    // The verdicts say why each trap died, so a dropped block is auditable:
    // extraction-level blocks carry the reason, fuse then refuses to publish
    // them, which is what the mustNotContain assertions above proved.
    const extraction = await extract(cdp.evaluate)
    const condemned = extraction.blocks.filter((b) => !b.visible)
    expect(condemned.length).toBe(3)
    for (const block of condemned) {
      expect(block.hiddenReason ?? '').not.toBe('')
    }
  })

  it('nominates the canvas dashboard as a cover region', async () => {
    const doc = await readFixture('canvas-dashboard.html')
    expect(doc.regions.length).toBeGreaterThanOrEqual(1)
    expect(doc.regions.some((r) => r.kinds.includes('canvas'))).toBe(true)
    // The dom side still explains the heading; only the canvas is dark.
    expect(doc.blocks.some((b) => b.text.includes('Operations Dashboard'))).toBe(true)
  })

  it('renders markdown in reading order for the article', async () => {
    const doc = await readFixture('article.html')
    const markdown = toMarkdown(doc)
    for (const wanted of expectations('article').mustContain) {
      expect(markdown).toContain(wanted)
    }
  })
})

describe('fuse ordering', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

  function dom(text: string, x: number, y: number, w = 100, h = 20): DomBlock {
    return { text, role: 'paragraph', tag: 'p', box: box(x, y, w, h), selector: '#x', visible: true }
  }

  it('orders two clean columns column-by-column, not row-by-row', () => {
    const leftTop = dom('left top', 0, 0)
    const leftBottom = dom('left bottom', 0, 40)
    const rightTop = dom('right top', 300, 0)
    const rightBottom = dom('right bottom', 300, 40)
    const out = fuse([rightBottom, rightTop, leftBottom, leftTop], [])
    expect(out.map((b) => b.text)).toEqual(['left top', 'left bottom', 'right top', 'right bottom'])
  })

  it('drops invisible blocks even when they carry text', () => {
    const hidden: DomBlock = {
      ...dom('poison', 0, 0),
      visible: false,
      hiddenReason: 'display-none',
    }
    const out = fuse([hidden, dom('clean', 0, 50)], [])
    expect(out.map((b) => b.text)).toEqual(['clean'])
  })

  it('keeps ocr blocks beside dom blocks with no selector invented', () => {
    const ocr = [{ text: 'Throughput: 8842 units', box: box(20, 20, 300, 30), source: 'ocr' as const }]
    const out = fuse([dom('heading', 0, 0)], ocr)
    const fromOcr = out.find((b) => b.source === 'ocr')
    expect(fromOcr?.text).toBe('Throughput: 8842 units')
    expect(fromOcr && 'selector' in fromOcr).toBe(false)
  })
})

describe('cover decisions', () => {
  const viewport = { w: 1200, h: 800 }

  it('accepts a canvas candidate as a region', () => {
    const candidate: CoverCandidate = { kind: 'canvas', box: { x: 40, y: 40, w: 480, h: 220 }, selector: '#dashboard' }
    const regions = cover([candidate], [], viewport)
    expect(regions).toHaveLength(1)
    expect(regions[0].kinds).toContain('canvas')
  })

  it('refuses candidates outside the viewport rather than screenshotting darkness', () => {
    const candidate: CoverCandidate = { kind: 'img', box: { x: 0, y: 5000, w: 300, h: 200 }, selector: '#far', hasAlt: false }
    expect(cover([candidate], [], viewport)).toHaveLength(0)
  })
})
