import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMemory } from '../src/agent/memory.js'

/**
 * The memory store is pure persistence and ranking, so these run entirely
 * against temp files. What matters to pin down: reads build the graph,
 * actions deepen it, recall ranks by field weight and history, and forget
 * actually forgets.
 */

let dir: string | undefined
let memory: ReturnType<typeof createMemory> | undefined

async function freshMemory() {
  dir = await mkdtemp(path.join(tmpdir(), 'troy-memory-'))
  memory = createMemory(path.join(dir, 'agent-memory.json'))
  return memory
}

afterEach(async () => {
  memory?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const read = {
  url: 'https://shop.example/products',
  title: 'Products',
  result: {
    textPreview: 'Buy widgets here. Search the catalogue.',
    interactive: [
      { selector: '#q', tag: 'input', type: 'search', role: 'searchbox', text: '', label: 'Search', ariaLabel: 'Search the catalogue', name: 'q', placeholder: 'Search products', signature: 's1' },
      { selector: 'form > button', tag: 'button', type: 'submit', role: '', text: 'Search', label: '', ariaLabel: '', name: '', placeholder: '', signature: 's2' },
      { selector: 'a.cart', tag: 'a', type: '', role: '', text: 'Your cart', label: '', ariaLabel: '', name: '', placeholder: '', signature: 's3' },
    ],
  },
}

describe('the memory store', () => {
  it('records a read and recalls elements by what they say', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)

    const found = m.recall('search')
    expect(found.elements.length).toBeGreaterThan(0)
    expect(found.elements[0]?.selector).toBe('#q')
    expect(found.pages[0]?.url).toBe(read.url)
  })

  it('scopes recall to one origin when asked', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.recordRead(
      { url: 'https://other.example/login', title: 'Login' },
      { textPreview: 'sign in', interactive: [{ selector: '#user', tag: 'input', type: 'text', text: '', label: 'Username', signature: 'o1' }] },
    )

    const scoped = m.recall('username', { origin: 'https://other.example' })
    expect(scoped.elements).toHaveLength(1)
    expect(scoped.elements[0]?.selector).toBe('#user')

    const excluded = m.recall('username', { origin: 'https://shop.example' })
    expect(excluded.elements).toHaveLength(0)
  })

  it('learns paths: acting on an element records where it led', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.recordAction({
      kind: 'click',
      item: { selector: 'a.cart', text: 'Your cart' },
      fromUrl: read.url,
      toUrl: 'https://shop.example/cart',
      ok: true,
    })

    const found = m.recall('cart')
    expect(found.paths.length).toBe(1)
    expect(found.paths[0]?.toUrl).toBe('https://shop.example/cart')
    expect(found.elements.find((e) => e.selector === 'a.cart')?.verified).toBe(1)
  })

  it('marks failures so flaky selectors sink', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.recordAction({ kind: 'click', item: { selector: 'a.cart', text: 'Your cart' }, fromUrl: read.url, toUrl: read.url, ok: false })
    expect(m.recall('cart').elements[0]?.failed).toBe(1)
  })

  it('persists across instances through the file', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.flush()
    m.close()

    const revived = createMemory(path.join(dir!, 'agent-memory.json'))
    memory = revived
    expect(revived.recall('search').elements[0]?.selector).toBe('#q')
    revived.close()
  })

  it('forgets one origin and forgets everything', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.recordRead(
      { url: 'https://other.example/x', title: 'x' },
      { textPreview: 'other', interactive: [{ selector: '#b', tag: 'button', text: 'Go', signature: 'o2' }] },
    )

    m.forget('https://shop.example')
    expect(m.recall('search').pages).toHaveLength(0)
    expect(m.recall('go').elements.length).toBeGreaterThan(0)

    m.forget()
    expect(m.recall('go').elements).toHaveLength(0)
    expect(m.stats().elements).toBe(0)
  })

  it('refuses file: and javascript: pages entirely', async () => {
    const m = await freshMemory()
    m.recordRead(
      { url: 'file:///etc/passwd', title: 'nope' },
      { textPreview: 'root:x', interactive: [{ selector: '#x', tag: 'input', text: 'x', signature: 'f1' }] },
    )
    expect(m.stats().pages).toBe(0)
    expect(m.recall('root').elements).toHaveLength(0)
  })

  it('erase() removes the store file', async () => {
    const m = await freshMemory()
    m.recordRead({ url: read.url, title: read.title }, read.result)
    m.flush()
    expect(existsSync(path.join(dir!, 'agent-memory.json'))).toBe(true)
    m.erase()
    expect(existsSync(path.join(dir!, 'agent-memory.json'))).toBe(false)
  })
})
