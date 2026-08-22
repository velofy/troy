import { describe, it, expect } from 'vitest'
import { resolveOmnibox } from '../src/browser/omnibox.js'
import { createTools, MAX_TOOL_RESULT_CHARS } from '../src/agent/tools.js'

/**
 * The tool layer, driven through a scripted host so every refusal can be
 * exercised without a browser. The contract these tests pin down:
 *
 * - Inspection happens before action, and every refusal fires on the
 *   inspection result, before any script that could change the page runs.
 * - Ambiguity is refused, never resolved by guessing.
 * - Refused omnibox schemes are refused here too, from the same resolver.
 * - Results are size-capped with an explicit truncation marker.
 *
 * The real-DOM behaviour of the same tools (did the click verify, does
 * maxlength hold against a live input) is covered in agent-cdp.test.ts.
 */

type ExecResult =
  | { code: number; stdout: string; stderr: string }
  | { missing: string }

type HostOptions = {
  evalResults?: unknown[]
  exec?: (cmd: string, args: string[]) => Promise<ExecResult>
}

function makeHost(options: HostOptions = {}) {
  const evalQueue = [...(options.evalResults ?? [])]
  const calls: Array<{ kind: string; detail: unknown }> = []
  const host = {
    read: async () => ({
      url: 'https://a.example/',
      title: 'fixture',
      readyState: 'complete',
      characterCount: 5,
      linkCount: 1,
      imageCount: 0,
      headingCount: 1,
      textPreview: 'hello',
      degraded: false,
      interactive: [],
    }),
    evaluate: async (expression: string) => {
      calls.push({ kind: 'evaluate', detail: expression })
      if (evalQueue.length === 0) throw new Error('the test scripted no more evaluate results')
      return evalQueue.shift()
    },
    resolve: (input: string) => resolveOmnibox(input),
    load: async (url: string) => {
      calls.push({ kind: 'load', detail: url })
      return { url }
    },
    exec: async (cmd: string, args: string[]): Promise<ExecResult> => {
      calls.push({ kind: 'exec', detail: [cmd, ...args] })
      if (options.exec) return options.exec(cmd, args)
      return { missing: 'no exec scripted' }
    },
    settle: async () => {},
  }
  return { host, calls, evaluates: () => calls.filter((c) => c.kind === 'evaluate').length }
}

/** A clickable element the guards have no reason to refuse. */
const plainButton = {
  tag: 'button',
  type: 'button',
  name: '',
  text: 'More details',
  value: '',
  disabled: false,
  defaultSubmit: false,
  editable: false,
  maxLength: null,
  readOnly: false,
  before: '',
}

/** A fillable input the guards have no reason to refuse. */
const plainInput = {
  tag: 'input',
  type: 'text',
  name: 'city',
  text: '',
  value: '',
  disabled: false,
  defaultSubmit: false,
  editable: false,
  maxLength: null,
  readOnly: false,
  before: '',
}

/** Two snapshots that differ, so a diff between them reports a change. */
const snapshotA = {
  url: 'https://a.example/',
  title: 't',
  visibleFields: 1,
  fieldCount: 1,
  fields: [{ k: 'city', v: '' }],
  marked: [],
  textLen: 100,
}
const snapshotB = { ...snapshotA, fields: [{ k: 'city', v: 'Pune' }], visibleFields: 2 }

describe('the tool specs', () => {
  it('declare read and scrape free, and navigate, click and fill gated', () => {
    const { host } = makeHost()
    const { specs } = createTools(host)
    const gated = Object.fromEntries(specs.map((s) => [s.name, s.gated]))
    expect(gated).toEqual({
      page_read: false,
      page_scrape: false,
      page_navigate: true,
      page_click: true,
      page_fill: true,
    })
  })

  it('give every tool a description and an input schema for the provider', () => {
    const { specs } = createTools(makeHost().host)
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(10)
      expect(spec.input.type).toBe('object')
    }
  })
})

describe('page_read', () => {
  it('returns the host read result unchanged when it fits', async () => {
    const { host } = makeHost()
    const result = await createTools(host).run('page_read', {})
    expect(result.url).toBe('https://a.example/')
    expect(result.textPreview).toBe('hello')
  })
})

describe('page_navigate', () => {
  it('refuses a javascript: URL through the omnibox resolver, and never loads it', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_navigate', { url: 'javascript:alert(1)' })
    expect(String(result.error)).toMatch(/javascript/i)
    expect(calls.filter((c) => c.kind === 'load')).toHaveLength(0)
  })

  it('refuses a data: URL the same way', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_navigate', { url: 'data:text/html,<h1>x' })
    expect(result.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('refuses to hand an external scheme to the OS', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_navigate', { url: 'mailto:a@b.example' })
    expect(String(result.error)).toMatch(/another application/i)
    expect(calls).toHaveLength(0)
  })

  it('loads a plain address through the same resolver the omnibox uses', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_navigate', { url: 'example.com' })
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('url')
    expect(calls[0]).toEqual({ kind: 'load', detail: 'https://example.com' })
  })

  it('turns a phrase into a search rather than refusing it', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_navigate', { url: 'tallest mountain' })
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('search')
    expect(String(calls[0]?.detail)).toContain('google.com/search')
  })
})

describe('page_click refusals', () => {
  it('refuses when the selector matches more than one element, and lists them', async () => {
    const { host, evaluates } = makeHost({
      evalResults: [{ count: 2, items: [plainButton, { ...plainButton, text: 'Other' }] }],
    })
    const result = await createTools(host).run('page_click', { selector: '.btn' })
    expect(String(result.error)).toMatch(/2 elements|refusing/i)
    // Inspection only. Nothing that could act may have run.
    expect(evaluates()).toBe(1)
  })

  it('refuses when nothing matches', async () => {
    const { host } = makeHost({ evalResults: [{ count: 0, items: [] }] })
    const result = await createTools(host).run('page_click', { selector: '#missing' })
    expect(String(result.error)).toMatch(/nothing matched/i)
  })

  it('refuses when the scope container is missing', async () => {
    const { host } = makeHost({ evalResults: [{ scopeMissing: '#form-3' }] })
    const result = await createTools(host).run('page_click', { selector: 'button', within: '#form-3' })
    expect(String(result.error)).toMatch(/scope/i)
  })

  it('refuses a control whose text reads like a commit action', async () => {
    const { host, evaluates } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainButton, text: 'Submit application' }] }],
    })
    const result = await createTools(host).run('page_click', { selector: '#go' })
    expect(String(result.error)).toMatch(/submit|commit/i)
    expect(evaluates()).toBe(1)
  })

  it('refuses a button that would submit its form even when its text looks harmless', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainButton, text: 'Continue', defaultSubmit: true }] }],
    })
    const result = await createTools(host).run('page_click', { selector: '#continue' })
    expect(String(result.error)).toMatch(/submit/i)
  })

  it('refuses to click a password field', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainButton, tag: 'input', type: 'password' }] }],
    })
    const result = await createTools(host).run('page_click', { selector: '#pw' })
    expect(String(result.error)).toMatch(/password/i)
  })
})

describe('page_click verification', () => {
  it('reports NOT VERIFIED when the page did not observably change', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [plainButton] }, snapshotA, { acted: true }, snapshotA],
    })
    const result = await createTools(host).run('page_click', { selector: '#quiet' })
    expect(result.ok).toBe(false)
    expect(String(result.note)).toMatch(/NOT VERIFIED/)
  })

  it('reports the change it verified when the page moved', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [plainButton] }, snapshotA, { acted: true }, snapshotB],
    })
    const result = await createTools(host).run('page_click', { selector: '#reveals' })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(Array.isArray(result.reasons)).toBe(true)
  })
})

describe('page_fill refusals', () => {
  it('refuses an empty answer before touching the page', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_fill', { selector: '#q', text: '   ' })
    expect(result.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('refuses text containing an em-dash or en-dash', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_fill', { selector: '#q', text: 'a \u2014 b' })
    expect(String(result.error)).toMatch(/dash/i)
    expect(calls).toHaveLength(0)
  })

  it('refuses a password field', async () => {
    const { host, evaluates } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainInput, type: 'password' }] }],
    })
    const result = await createTools(host).run('page_fill', { selector: '#pw', text: 'hunter2' })
    expect(String(result.error)).toMatch(/password/i)
    expect(evaluates()).toBe(1)
  })

  it('refuses text longer than the field maxlength instead of truncating silently', async () => {
    const { host, evaluates } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainInput, maxLength: 5 }] }],
    })
    const result = await createTools(host).run('page_fill', { selector: '#zip', text: 'toolong' })
    expect(String(result.error)).toMatch(/5/)
    expect(evaluates()).toBe(1)
  })

  it('refuses an ambiguous selector', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 3, items: [plainInput, plainInput, plainInput] }],
    })
    const result = await createTools(host).run('page_fill', { selector: 'input', text: 'x' })
    expect(String(result.error)).toMatch(/3 elements|refusing/i)
  })

  it('refuses a control that is not a text input', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [{ ...plainInput, tag: 'div', editable: false }] }],
    })
    const result = await createTools(host).run('page_fill', { selector: '#d', text: 'x' })
    expect(String(result.error)).toMatch(/not a text input/i)
  })
})

describe('page_fill verification', () => {
  it('verifies the value landed by reading it back', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [plainInput] }, { acted: true }, 'Pune'],
    })
    const result = await createTools(host).run('page_fill', { selector: '#city', text: 'Pune' })
    expect(result.ok).toBe(true)
  })

  it('reports a mismatch honestly when the page rewrote the value', async () => {
    const { host } = makeHost({
      evalResults: [{ count: 1, items: [plainInput] }, { acted: true }, 'PUNE'],
    })
    const result = await createTools(host).run('page_fill', { selector: '#city', text: 'Pune' })
    expect(result.ok).toBe(false)
    expect(String(result.note)).toMatch(/MISMATCH/)
  })
})

describe('page_scrape', () => {
  it('refuses anything that is not http or https', async () => {
    const { host, calls } = makeHost()
    const result = await createTools(host).run('page_scrape', { url: 'file:///etc/passwd' })
    expect(result.error).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('says honestly when curl_reap is not installed', async () => {
    const { host } = makeHost({ exec: async () => ({ missing: 'python3 reported no curl_reap module' }) })
    const result = await createTools(host).run('page_scrape', { url: 'https://example.com/' })
    expect(String(result.error)).toMatch(/curl.?reap/i)
  })

  it('reports a failed fetch with its stderr rather than pretending', async () => {
    const { host } = makeHost({ exec: async () => ({ code: 2, stdout: '', stderr: 'boom: 403' }) })
    const result = await createTools(host).run('page_scrape', { url: 'https://example.com/' })
    expect(String(result.error)).toContain('boom: 403')
  })

  it('returns the fetched content and the command it ran through', async () => {
    const { host, calls } = makeHost({ exec: async () => ({ code: 0, stdout: 'page body', stderr: '' }) })
    const result = await createTools(host).run('page_scrape', { url: 'https://example.com/' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('page body')
    expect(calls[0]?.detail).toEqual(['python3', '-m', 'curl_reap.cli', 'get', 'https://example.com/'])
  })

  it('caps an oversized result and says so, instead of shipping megabytes to the model', async () => {
    const { host } = makeHost({
      exec: async () => ({ code: 0, stdout: 'x'.repeat(MAX_TOOL_RESULT_CHARS * 4), stderr: '' }),
    })
    const result = await createTools(host).run('page_scrape', { url: 'https://example.com/' })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
    expect(result.truncated).toBe(true)
    expect(String(result.note)).toMatch(/truncat/i)
  })
})

describe('unknown tools', () => {
  it('are an error result, not a throw', async () => {
    const { host } = makeHost()
    const result = await createTools(host).run('page_teleport', {})
    expect(String(result.error)).toMatch(/unknown tool/i)
  })
})
