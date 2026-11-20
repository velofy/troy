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

  it('executes a ref, verifies it, and keeps it usable while the document lives', async () => {
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
    expect(clicked.pageChanged).toBe(true)

    // The ref survives the action — but re-inspection still runs, so a
    // control that changed underneath is refused rather than re-clicked.
    evalQueue.push({
      count: 1,
      items: [{ tag: 'input', type: 'text', text: '', label: 'Email', signature: 'changed' }],
    })
    const reclick = await tools.run('page_click', { ref: 'e1' })
    expect(reclick.error).toMatch(/changed|read the page again/i)
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
    expect(result).toMatchObject({ ok: false, blocked: true, code: 'commerce' })
    expect(calls).toHaveLength(1)
  })

  it('permits an irreversible click when allowSubmit: true is explicitly passed', async () => {
    const { tools, evalQueue } = makeTools('Place order')
    await tools.run('page_read', {})
    evalQueue.push(
      { count: 1, items: [{ tag: 'button', type: 'button', text: 'Place order', name: '', disabled: false, defaultSubmit: true, signature: 'Place order' }] },
      snapshotA,
      { acted: true },
      snapshotB,
    )
    const result = await tools.run('page_click', { ref: 'e1', allowSubmit: true })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
  })

  it('binds added and changed items in page_read({ since: true }) to actionable refs with no raw selectors', async () => {
    const elements = new ElementRegistry()
    let step = 0
    const evalQueue: unknown[] = []
    const tools = createTools({
      read: async () => {
        step += 1
        if (step === 1) {
          return {
            url: 'https://example.com/',
            title: 'delta',
            textPreview: 'one',
            interactive: [
              { selector: '#keep', tag: 'button', type: 'button', text: 'Keep', name: '', disabled: false, defaultSubmit: false, editable: false, maxLength: null, readOnly: false, signature: 'keep-1' },
            ],
          }
        }
        return {
          url: 'https://example.com/',
          title: 'delta',
          textPreview: 'two',
          interactive: [
            { selector: '#keep', tag: 'button', type: 'button', text: 'Keep (1)', name: '', disabled: false, defaultSubmit: false, editable: false, maxLength: null, readOnly: false, signature: 'keep-2' },
            { selector: '#added', tag: 'button', type: 'button', text: 'New item', name: '', disabled: false, defaultSubmit: false, editable: false, maxLength: null, readOnly: false, signature: 'added-1' },
          ],
        }
      },
      evaluate: async () => evalQueue.shift(),
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://example.com/', epoch: 0 }),
      invalidate: () => {},
    }, { elements, includeScrape: false })

    await tools.run('page_read', {})
    const delta = await tools.run('page_read', { since: true }) as {
      delta?: boolean
      added?: Array<{ ref?: string; selector?: string; text?: string }>
      changed?: Array<{ ref?: string; selector?: string; text?: string }>
    }
    expect(delta.delta).toBe(true)
    expect(delta.added).toHaveLength(1)
    expect(delta.changed).toHaveLength(1)
    expect(delta.added?.[0]?.ref).toMatch(/^e\d+$/)
    expect(delta.changed?.[0]?.ref).toMatch(/^e\d+$/)
    expect(JSON.stringify(delta)).not.toContain('#added')
    expect(JSON.stringify(delta)).not.toContain('#keep')

    // Actionable ref from delta resolves directly in page_click
    evalQueue.push(
      { count: 1, items: [{ tag: 'button', type: 'button', text: 'New item', name: '', disabled: false, defaultSubmit: false, signature: 'added-1' }] },
      snapshotA,
      { acted: true },
      snapshotB,
    )
    const clicked = await tools.run('page_click', { ref: delta.added?.[0]?.ref })
    expect(clicked.ok).toBe(true)
  })

  it('enriches page_recall with live refs when selectors exist on the current page', async () => {
    const elements = new ElementRegistry()
    const evalQueue: unknown[] = [
      {
        '#search': { selector: '#search', tag: 'input', type: 'search', text: '', label: 'Search', signature: 'sig-search' },
      },
    ]
    const tools = createTools({
      read: async () => ({ url: 'https://example.com/', title: 'x', interactive: [] }),
      evaluate: async () => evalQueue.shift(),
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://example.com/', epoch: 0 }),
      invalidate: () => {},
    }, {
      elements,
      includeScrape: false,
      memory: {
        recall: () => ({
          elements: [
            { selector: '#search', tag: 'input', text: '', label: 'Search', pageUrl: 'https://example.com/' },
            { selector: '#other-page', tag: 'button', text: 'Gone', pageUrl: 'https://example.com/other' },
          ],
          pages: [{ url: 'https://example.com/', title: 'x' }],
          paths: [],
        }),
      },
    })

    const recalled = await tools.run('page_recall', { query: 'search' }) as {
      elements: Array<{ selector: string; ref?: string }>
    }
    expect(recalled.elements[0].selector).toBe('#search')
    expect(recalled.elements[0].ref).toMatch(/^e\d+$/)
    expect(recalled.elements[1].ref).toBeUndefined()
    // Bound ref is registered in ElementRegistry
    expect(elements.resolve(recalled.elements[0].ref, { tabId: 1, url: 'https://example.com/', epoch: 0 })).toMatchObject({
      selector: '#search',
    })
  })

  it('recovers stale refs deterministically on 0-match by id/ariaLabel and on minor text drift', async () => {
    const elements = new ElementRegistry()
    const evalQueue: unknown[] = []
    const tools = createTools({
      read: async () => ({
        url: 'https://example.com/',
        title: 'spa',
        textPreview: 'spa',
        interactive: [{
          selector: 'div > button:nth-of-type(1)',
          tag: 'button',
          type: 'button',
          id: 'notif-btn',
          ariaLabel: 'Notifications',
          name: '',
          role: 'button',
          text: 'Notifications (2)',
          disabled: false,
          defaultSubmit: false,
          editable: false,
          maxLength: null,
          readOnly: false,
          signature: 'sig-v1',
        }],
      }),
      evaluate: async () => evalQueue.shift(),
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://example.com/', epoch: 0 }),
      invalidate: () => {},
    }, { elements, includeScrape: false })

    await tools.run('page_read', {})

    // Case 1: selector returns 0 matches -> deterministic unique recovery returns new selector
    evalQueue.push(
      { count: 0, items: [] },
      {
        found: true,
        selector: '#notif-btn',
        item: {
          tag: 'button',
          type: 'button',
          id: 'notif-btn',
          ariaLabel: 'Notifications',
          name: '',
          role: 'button',
          text: 'Notifications (3)',
          disabled: false,
          defaultSubmit: false,
          editable: false,
          signature: 'sig-v2',
        },
      },
      snapshotA,
      { acted: true },
      snapshotB,
    )
    const recoveredClick = await tools.run('page_click', { ref: 'e1' })
    expect(recoveredClick.ok).toBe(true)

    // Case 2: minor text drift on same control (id & tag match, text changed from (3) to (4))
    evalQueue.push(
      {
        count: 1,
        items: [{
          tag: 'button',
          type: 'button',
          id: 'notif-btn',
          ariaLabel: 'Notifications',
          name: '',
          role: 'button',
          text: 'Notifications (4)',
          disabled: false,
          defaultSubmit: false,
          editable: false,
          signature: 'sig-v3',
        }],
      },
      snapshotA,
      { acted: true },
      snapshotB,
    )
    const driftClick = await tools.run('page_click', { ref: 'e1' })
    expect(driftClick.ok).toBe(true)
  })

  it('page_screenshot({ annotate: true }) auto-reads empty registry and always removes overlay in finally', async () => {
    const elements = new ElementRegistry()
    let readCalls = 0
    const evaluated: string[] = []
    const tools = createTools({
      read: async () => {
        readCalls += 1
        return {
          url: 'https://example.com/',
          title: 'som',
          textPreview: 'som',
          interactive: [{ selector: '#btn', tag: 'button', text: 'Go', signature: 'go' }],
        }
      },
      evaluate: async (expr: string) => {
        evaluated.push(expr)
        if (expr.includes('__troy_som_overlay') && expr.includes('annotatedCount')) {
          return JSON.stringify({ annotatedCount: 1, url: 'https://example.com/', title: 'som' })
        }
        return 'ok'
      },
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://example.com/', epoch: 0 }),
      invalidate: () => {},
      screenshot: async () => {
        throw new Error('simulated capture failure')
      },
    }, { elements, includeScrape: false })

    const res = await tools.run('page_screenshot', { annotate: true })
    expect(readCalls).toBe(1)
    expect(String(res.error)).toMatch(/simulated capture failure/)
    // Overlay removal ran in finally even though screenshot threw
    expect(evaluated.some((e) => e.includes('el.remove()'))).toBe(true)
  })

  it('origin-gates page_eval through authorizeAction', async () => {
    const elements = new ElementRegistry()
    const tools = createTools({
      read: async () => ({ url: 'https://other.example/', title: 'x', interactive: [] }),
      evaluate: async () => { throw new Error('must not execute') },
      resolve: resolveOmnibox,
      load: async () => ({}),
      exec: async () => ({ missing: 'disabled' }),
      settle: async () => {},
      context: () => ({ tabId: 1, url: 'https://other.example/', epoch: 0 }),
      invalidate: () => {},
    }, {
      elements,
      includeScrape: false,
      authorize: (req) => authorizeAction({ ...req, allowedOrigins: new Set(['https://example.com']) }),
    })

    const denied = await tools.run('page_eval', { expression: '1 + 1' })
    expect(denied).toMatchObject({ ok: false, blocked: true, boundary: true, code: 'origin' })
  })
})
