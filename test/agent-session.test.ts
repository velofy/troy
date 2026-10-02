import { describe, expect, it } from 'vitest'
import { createAgentController } from '../src/browser/agentController.js'
import { resolveOmnibox } from '../src/browser/omnibox.js'

function streamOf(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(text)
  })()
}

function anthropicText(text: string): string {
  return [
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
}

function anthropicTool(id: string, name: string, args: Record<string, unknown>): string {
  return [
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

type FakeFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

type TestEvent = { type?: string; [key: string]: unknown }

function harness(fetchImpl: (url: string, init: FakeFetchInit) => Promise<unknown>, withKey = true) {
  const events: TestEvent[] = []
  let url = 'https://example.com/start'
  let closed = 0
  const webContents = {
    isDestroyed: () => false,
    getURL: () => url,
  }
  const controller = createAgentController({
    getActiveTab: () => ({ id: 7, webContents: webContents as never }),
    getKey: () => (withKey ? 'test-key' : null),
    resolve: resolveOmnibox,
    emit: (event) => events.push(event),
    fetchImpl,
    createPort: (() => ({
      read: async () => ({
        url,
        title: 'fixture',
        readyState: 'complete',
        characterCount: 5,
        linkCount: 0,
        imageCount: 0,
        headingCount: 0,
        textPreview: 'hello',
        degraded: false,
        interactive: [],
      }),
      readVisual: async () => ({ url, title: 'fixture', content: 'hello' }),
      evaluate: async () => '',
      load: async (next: string) => {
        url = next
        return { url }
      },
      settle: async () => ({ settled: true, elapsedMs: 1 }),
      context: () => ({ tabId: 7, url, epoch: 0 }),
      invalidate: () => {},
      close: async () => {
        closed += 1
      },
    })) as never,
  })
  return { controller, events, closed: () => closed }
}

describe('agent controller', () => {
  it('keeps a per-tab transcript, batches streamed text, and closes its tab port', async () => {
    const { controller, events, closed } = harness(async () => ({
      ok: true,
      status: 200,
      body: streamOf(anthropicText('Hello from Troy')),
    }))

    expect(controller.submit({ text: 'read this', provider: 'anthropic', model: 'test-model' })).toMatchObject({ ok: true })
    await until(() => events.some((event) => event.type === 'completed'), 'completion')

    const state = controller.state(7)
    expect(state.messages).toEqual([
      { role: 'user', text: 'read this' },
      { role: 'assistant', text: 'Hello from Troy' },
    ])
    expect(state.origins).toEqual(['https://example.com'])
    expect(events.filter((event) => event.type === 'assistant-delta').map((event) => event.delta).join('')).toBe('Hello from Troy')
    expect(closed()).toBe(1)
  })

  it('stops at an exact-origin boundary before loading the destination', async () => {
    const { controller, events } = harness(async () => ({
      ok: true,
      status: 200,
      body: streamOf(anthropicTool('tool-1', 'page_navigate', { url: 'https://other.example/path' })),
    }))

    controller.submit({ text: 'go elsewhere', provider: 'anthropic', model: 'test-model' })
    await until(() => events.some((event) => event.type === 'boundary'), 'origin boundary')
    const boundary = events.find((event) => event.type === 'boundary')
    expect(boundary?.origin).toBe('https://other.example')
    expect(controller.state(7).pendingBoundary).toBe('https://other.example')
  })

  it('grants a requested origin for the tab session and resumes the paused run', async () => {
    let call = 0
    const { controller, events } = harness(async () => {
      call += 1
      return {
        ok: true,
        status: 200,
        body: streamOf(call === 1
          ? anthropicTool('tool-1', 'page_navigate', { url: 'https://other.example/path' })
          : anthropicText('Scope granted; continuing.')),
      }
    })

    controller.submit({ text: 'go elsewhere', provider: 'anthropic', model: 'test-model' })
    await until(() => controller.state(7).pendingBoundary === 'https://other.example' && !controller.running, 'paused boundary')
    expect(controller.grantOrigin(7, 'https://other.example/path')).toMatchObject({ ok: true })
    await until(() => events.filter((event) => event.type === 'completed').length === 1, 'resumed completion')
    expect(controller.state(7).origins).toEqual(['https://example.com', 'https://other.example'])
    expect(controller.state(7).messages.at(-1)).toEqual({ role: 'assistant', text: 'Scope granted; continuing.' })
  })

  it('cancels a pending provider request and emits one terminal cancellation', async () => {
    const { controller, events } = harness((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal
        if (!signal) throw new Error('the controller did not pass its abort signal')
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    )
    controller.submit({ text: 'wait', provider: 'anthropic', model: 'test-model' })
    expect(controller.stop('test stop')).toBe(true)
    await until(() => events.some((event) => event.type === 'cancelled'), 'cancellation')
    expect(events.find((event) => event.type === 'cancelled')?.reason).toBe('test stop')
  })

  it('refuses to start without a stored provider key', () => {
    const { controller } = harness(async () => {
      throw new Error('fetch should not run')
    }, false)
    expect(controller.submit({ text: 'read', provider: 'anthropic', model: 'test-model' })).toEqual({
      error: 'no anthropic key is stored',
    })
  })
})
