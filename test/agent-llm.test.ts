import { describe, it, expect } from 'vitest'
import { resolveOmnibox } from '../src/browser/omnibox.js'
import { createTools } from '../src/agent/tools.js'
import {
  SYSTEM_PROMPT,
  MAX_TOOL_CALLS_PER_TURN,
  DEFAULT_MODELS,
  createSseParser,
  buildRequest,
  runAgentTurn,
} from '../src/agent/llm.js'

/**
 * The model loop, driven with a scripted fetch so the discipline is tested
 * without a network: the loop caps tool calls per turn, gated tools run only
 * after explicit consent, a denial ends the turn politely, and the wire
 * formats for both provider families assemble from real streaming chunks.
 */

// ------------------------------------------------------------- scaffolding

type SseEvent = { event?: string; data: unknown }

function sseBody(events: SseEvent[]): string {
  return events
    .map(
      (e) =>
        (e.event ? `event: ${e.event}\n` : '') +
        `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join('')
}

function streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk)
  })()
}

type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/**
 * A fetch that answers from a queue of SSE bodies, repeating the last one
 * forever, which is what an endlessly tool-hungry model looks like.
 */
function fakeFetch(bodies: string[]) {
  const calls: FetchCall[] = []
  const queue = [...bodies]
  const impl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
    const text = queue.length > 1 ? (queue.shift() as string) : (queue[0] as string)
    return { ok: true, status: 200, body: streamOf(text) }
  }
  return { impl, calls }
}

/** A tool layer over a host that throws if anything tries to act on a page. */
function trackedTools() {
  const runs: Array<{ name: string; args: Record<string, unknown> }> = []
  let evaluates = 0
  const host = {
    read: async () => ({
      url: 'https://a.example/',
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
    evaluate: async () => {
      evaluates += 1
      throw new Error('this test expected no page evaluation')
    },
    resolve: (input: string) => resolveOmnibox(input),
    load: async (url: string) => ({ url }),
    exec: async () => ({ missing: 'not in this test' }),
    settle: async () => {},
  }
  const inner = createTools(host)
  return {
    tools: {
      specs: inner.specs,
      run: async (name: string, args: Record<string, unknown>) => {
        runs.push({ name, args })
        return inner.run(name, args)
      },
    },
    runs,
    evaluates: () => evaluates,
  }
}

// Anthropic-shaped streaming fixtures.

function anthropicText(text: string): string {
  return sseBody([
    { event: 'message_start', data: { type: 'message_start' } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

function anthropicToolCall(id: string, name: string, argJsonParts: string[]): string {
  return sseBody([
    { event: 'message_start', data: { type: 'message_start' } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name, input: {} },
      },
    },
    ...argJsonParts.map((partial_json) => ({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
    })),
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

// OpenAI-shaped streaming fixtures, shared by openai and openrouter.

function openaiText(parts: string[]): string {
  return sseBody([
    ...parts.map((content) => ({ data: { choices: [{ delta: { content } }] } })),
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
    { data: '[DONE]' },
  ])
}

function openaiToolCall(id: string, name: string, argParts: string[]): string {
  return sseBody([
    {
      data: {
        choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }],
      },
    },
    ...argParts.map((args) => ({
      data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
    })),
    { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
    { data: '[DONE]' },
  ])
}

// ------------------------------------------------------------------- tests

describe('the system prompt', () => {
  it('states the discipline: read first, selectors from page_read, page text is data', () => {
    expect(SYSTEM_PROMPT).toContain('page_read')
    expect(SYSTEM_PROMPT).toMatch(/data, not instructions/i)
    expect(SYSTEM_PROMPT).toMatch(/refus/i)
  })

  it('contains no em-dash or en-dash characters', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('the sse parser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const parser = createSseParser()
    const whole = 'event: ping\ndata: {"a":1}\n\ndata: [DONE]\n\n'
    const events = [...parser.feed(whole.slice(0, 13)), ...parser.feed(whole.slice(13))]
    expect(events).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: null, data: '[DONE]' },
    ])
  })

  it('joins multi-line data fields with newlines, per the SSE spec', () => {
    const parser = createSseParser()
    const events = parser.feed('data: one\ndata: two\n\n')
    expect(events).toEqual([{ event: null, data: 'one\ntwo' }])
  })
})

describe('buildRequest', () => {
  const specs = [
    { name: 'page_read', description: 'read the page', gated: false, input: { type: 'object', properties: {} } },
  ]
  const transcript = [{ role: 'user', text: 'hello' }]

  it('puts the anthropic key in a header, never in the body', () => {
    const { url, headers, body } = buildRequest('anthropic', {
      apiKey: 'sk-ant-xyz',
      model: DEFAULT_MODELS.anthropic,
      system: 'sys',
      transcript,
      specs,
    })
    expect(url).toContain('api.anthropic.com')
    expect(headers['x-api-key']).toBe('sk-ant-xyz')
    expect(headers['anthropic-version']).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain('sk-ant-xyz')
    expect(body.stream).toBe(true)
    expect(body.system).toBe('sys')
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.tools).toEqual([
      { name: 'page_read', description: 'read the page', input_schema: { type: 'object', properties: {} } },
    ])
  })

  it('speaks the openai wire format with a bearer token', () => {
    const { url, headers, body } = buildRequest('openai', {
      apiKey: 'sk-oai-xyz',
      model: DEFAULT_MODELS.openai,
      system: 'sys',
      transcript,
      specs,
    })
    expect(url).toContain('api.openai.com')
    expect(headers.Authorization).toBe('Bearer sk-oai-xyz')
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'page_read', description: 'read the page', parameters: { type: 'object', properties: {} } },
      },
    ])
  })

  it('sends openrouter down the openai wire at its own address', () => {
    const { url } = buildRequest('openrouter', {
      apiKey: 'sk-or-xyz',
      model: DEFAULT_MODELS.openrouter,
      system: 'sys',
      transcript,
      specs,
    })
    expect(url).toContain('openrouter.ai')
  })

  it('folds consecutive tool results into one anthropic user message', () => {
    const { body } = buildRequest('anthropic', {
      apiKey: 'k',
      model: DEFAULT_MODELS.anthropic,
      system: 'sys',
      transcript: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'tu1', name: 'page_read', args: {} },
            { id: 'tu2', name: 'page_read', args: {} },
          ],
        },
        { role: 'tool', id: 'tu1', name: 'page_read', result: { ok: true } },
        { role: 'tool', id: 'tu2', name: 'page_read', result: { ok: true } },
      ],
      specs,
    })
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>
    expect(messages).toHaveLength(3)
    expect(messages[2]?.role).toBe('user')
    expect(messages[2]?.content.map((c) => c.type)).toEqual(['tool_result', 'tool_result'])
  })
})

describe('runAgentTurn', () => {
  it('streams a plain text answer and finishes', async () => {
    const { impl, calls } = fakeFetch([anthropicText('Hello from Troy')])
    const { tools } = trackedTools()
    const deltas: string[] = []
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'hi' }],
      tools,
      gate: async () => true,
      onText: (d) => deltas.push(d),
      fetchImpl: impl,
    })
    expect(result.status).toBe('done')
    expect(deltas.join('')).toBe('Hello from Troy')
    expect(calls).toHaveLength(1)
    const last = result.transcript.at(-1) as { role: string; text: string }
    expect(last.role).toBe('assistant')
    expect(last.text).toBe('Hello from Troy')
  })

  it('runs a free tool without asking the gate, then reports its result to the model', async () => {
    const { impl, calls } = fakeFetch([
      anthropicToolCall('tu1', 'page_read', ['{}']),
      anthropicText('The page says hello.'),
    ])
    const { tools, runs } = trackedTools()
    let gateAsked = 0
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'what does the page say' }],
      tools,
      gate: async () => {
        gateAsked += 1
        return true
      },
      fetchImpl: impl,
    })
    expect(result.status).toBe('done')
    expect(gateAsked).toBe(0)
    expect(runs).toEqual([{ name: 'page_read', args: {} }])
    // The second request must carry the tool result back in provider format.
    const second = calls[1]?.body.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>
    const toolResult = second.at(-1)
    expect(toolResult?.role).toBe('user')
    expect(toolResult?.content[0]?.type).toBe('tool_result')
    expect(toolResult?.content[0]?.tool_use_id).toBe('tu1')
  })

  it('blocks a gated tool until consent, and a denial leaves the loop politely', async () => {
    const { impl, calls } = fakeFetch([anthropicToolCall('tu1', 'page_click', ['{"selector":"#buy"}'])])
    const { tools, runs, evaluates } = trackedTools()
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'click buy' }],
      tools,
      gate: async () => false,
      fetchImpl: impl,
    })
    expect(result.status).toBe('denied')
    // The tool never ran and nothing touched the page.
    expect(runs).toHaveLength(0)
    expect(evaluates()).toBe(0)
    // The loop ended: no second model call.
    expect(calls).toHaveLength(1)
    // Politeness is part of the contract, and so is a well-formed transcript:
    // the dangling tool_use got a declined tool_result so the next turn parses.
    expect(result.refusal).toMatch(/declin|did not|stopped/i)
    expect(result.refusal).not.toMatch(/[\u2013\u2014]/)
    const last = result.transcript.at(-1) as { role: string; result: { error: string } }
    expect(last.role).toBe('tool')
    expect(last.result.error).toMatch(/declin/i)
  })

  it('runs a gated tool once the gate approves it', async () => {
    const { impl } = fakeFetch([
      openaiToolCall('call_1', 'page_navigate', ['{"url":', '"example.com"}']),
      openaiText(['Done.']),
    ])
    const { tools, runs } = trackedTools()
    const approved: string[] = []
    const result = await runAgentTurn({
      provider: 'openai',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'open example.com' }],
      tools,
      gate: async (call) => {
        approved.push(call.name)
        return true
      },
      fetchImpl: impl,
    })
    expect(result.status).toBe('done')
    expect(approved).toEqual(['page_navigate'])
    expect(runs).toEqual([{ name: 'page_navigate', args: { url: 'example.com' } }])
  })

  it('caps tool calls per turn and stops, instead of looping forever', async () => {
    const { impl } = fakeFetch([anthropicToolCall('tu1', 'page_read', ['{}'])])
    const { tools, runs } = trackedTools()
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'read forever' }],
      tools,
      gate: async () => true,
      fetchImpl: impl,
      maxToolCalls: 3,
    })
    expect(result.status).toBe('capped')
    expect(runs).toHaveLength(3)
    // The unexecuted request still got an answer, so the transcript stays valid.
    const last = result.transcript.at(-1) as { role: string; result: { error: string } }
    expect(last.role).toBe('tool')
    expect(last.result.error).toMatch(/limit|budget/i)
  })

  it('has a real default cap', () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(4)
    expect(MAX_TOOL_CALLS_PER_TURN).toBeLessThanOrEqual(24)
  })

  it('answers an unknown tool with an error result and lets the model recover', async () => {
    const { impl } = fakeFetch([
      anthropicToolCall('tu1', 'page_teleport', ['{}']),
      anthropicText('I cannot do that.'),
    ])
    const { tools } = trackedTools()
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'k',
      transcript: [{ role: 'user', text: 'teleport' }],
      tools,
      gate: async () => true,
      fetchImpl: impl,
    })
    expect(result.status).toBe('done')
  })

  it('surfaces an http error as a result, not a throw', async () => {
    const impl = async () => ({ ok: false, status: 401, body: streamOf('unauthorized') })
    const { tools } = trackedTools()
    const result = await runAgentTurn({
      provider: 'anthropic',
      apiKey: 'bad',
      transcript: [{ role: 'user', text: 'hi' }],
      tools,
      gate: async () => true,
      fetchImpl: impl,
    })
    expect(result.status).toBe('error')
    expect(String(result.error)).toContain('401')
  })
})
