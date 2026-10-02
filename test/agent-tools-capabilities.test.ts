import { describe, expect, it } from 'vitest'
import { createTools, MAX_INTERACTIVE_ELEMENTS, MAX_TOOL_RESULT_CHARS } from '../src/agent/tools.js'
import { ElementRegistry } from '../src/agent/elements.js'
import { authorizeAction } from '../src/agent/policy.js'
import { resolveOmnibox } from '../src/browser/omnibox.js'

const snapshotA = {
  url: 'https://example.com/',
  title: 'fixture',
  visibleFields: 0,
  fieldCount: 0,
  fields: [],
  marked: 0,
  textLen: 10,
}
const snapshotB = { ...snapshotA, marked: 1, textLen: 20 }

function makeTools(text = 'More details') {
  const elements = new ElementRegistry()
  const evalQueue: unknown[] = []
  const calls: string[] = []
  let epoch = 0
  const host = {
    read: async () => ({
      url: 'https://example.com/',
      title: 'fixture',
      textPreview: 'hello',
      interactive: [{
        selector: '#action',
        tag: 'button',
        type: 'button',
        text,
        name: '',
        disabled: false,
        defaultSubmit: false,
        editable: false,
        maxLength: null,
        readOnly: false,
        signature: text,
      }],
    }),
    evaluate: async (expression: string) => {
      calls.push(expression)
      if (evalQueue.length === 0) throw new Error('no scripted evaluation result')
      return evalQueue.shift()
    },
    resolve: resolveOmnibox,
    load: async () => ({}),
    exec: async () => ({ missing: 'disabled' }),
    settle: async () => {},
    context: () => ({ tabId: 1, url: 'https://example.com/', epoch }),
    invalidate: () => {
      epoch += 1
    },
  }
  const tools = createTools(host, {
    elements,
    includeScrape: false,
    authorize: (request) => authorizeAction({ ...request, allowedOrigins: new Set(['https://example.com']) }),
  })
  return { tools, evalQueue, calls }
}

describe('in-app element capability tools', () => {
  it('exposes refs, not selectors, and removes subprocess scrape', async () => {
    const { tools } = makeTools()
    const read = await tools.run('page_read', {})
    expect(read.interactive).toEqual([expect.objectContaining({ ref: 'e1', text: 'More details' })])
    expect(JSON.stringify(read)).not.toContain('#action')
    expect(tools.specs.find((spec) => spec.name === 'page_click')?.input.required).toEqual(['ref'])
    expect(tools.specs.some((spec) => spec.name === 'page_scrape')).toBe(false)
  })

  it('bounds huge interactive maps before registering or returning them', async () => {
    const elements = new ElementRegistry()
    const tools = createTools({
      read: async () => ({
        url: 'https://example.com/',
        title: 'many controls',
        textPreview: 'x'.repeat(4000),
        interactive: Array.from({ length: 5000 }, (_, index) => ({
          selector: `#control-${index}`,
          tag: 'button',
          text: `Control ${index} ${'x'.repeat(80)}`,
          signature: `control-${index}`,
        })),
      }),
      evaluate: async () => '',
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://example.com/', epoch: 0 }),
      invalidate: () => {},
    }, { elements, includeScrape: false })
    const result = await tools.run('page_read', {})
    expect((result.interactive as unknown[]).length).toBeLessThanOrEqual(MAX_INTERACTIVE_ELEMENTS)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
    expect(result.interactiveTruncated).toBe(true)
  })

  it('rejects a forged ref before evaluating page code', async () => {
    const { tools, calls } = makeTools()
    await tools.run('page_read', {})
    const result = await tools.run('page_click', { ref: 'e999' })
    expect(result.error).toMatch(/stale|unknown/i)
    expect(calls).toHaveLength(0)
  })

  it('executes one reversible ref, verifies it, then expires the ref', async () => {
    const { tools, evalQueue } = makeTools()
    await tools.run('page_read', {})
    evalQueue.push(
      { count: 1, items: [{ tag: 'button', type: 'button', text: 'More details', name: '', disabled: false, defaultSubmit: false, signature: 'More details' }] },
      snapshotA,
      { acted: true },
      snapshotB,
    )
    const clicked = await tools.run('page_click', { ref: 'e1' })
    expect(clicked.ok).toBe(true)
    expect((await tools.run('page_click', { ref: 'e1' })).error).toMatch(/stale|unknown/i)
  })

  it('rejects a ref when the live control descriptor changed after page_read', async () => {
    const { tools, evalQueue, calls } = makeTools()
    await tools.run('page_read', {})
    evalQueue.push({
      count: 1,
      items: [{ tag: 'input', type: 'text', text: '', label: 'Card number', signature: 'changed' }],
    })
    const result = await tools.run('page_fill', { ref: 'e1', text: '4111111111111111' })
    expect(result.error).toMatch(/different control|read the page again/i)
    expect(calls).toHaveLength(1)
  })

  it('blocks an irreversible control before the click expression runs', async () => {
    const { tools, evalQueue, calls } = makeTools('Place order')
    await tools.run('page_read', {})
    evalQueue.push({ count: 1, items: [{ tag: 'button', type: 'button', text: 'Place order', name: '', disabled: false, defaultSubmit: false, signature: 'Place order' }] })
    const result = await tools.run('page_click', { ref: 'e1' })
    expect(result).toMatchObject({ blocked: true, code: 'commerce' })
    expect(calls).toHaveLength(1)
  })
})
