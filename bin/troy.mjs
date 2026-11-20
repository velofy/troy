#!/usr/bin/env node
// troy — drive a running Troy browser from any shell or agent.
//
// Discovers a live Troy through agent-endpoint.json (written when Troy is
// launched with --cdp-port or --agent) and talks to the agent socket, the
// same tool contract the in-app agent uses. Commands are single-digit ms of
// process overhead plus whatever the page itself costs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pidAlive } from '../src/browser/endpoint.js'

const USAGE = `troy — drive the running Troy browser

Usage: troy <command> [args] [--json] [--tab <id>] [--endpoint <file>]

  status                             is a bridge up, and what is it remembering
  tabs                               list tabs (id, url, title, active)
  open <url|words>                   open a background tab; prints its id
  focus <id>                         bring a tab to the front
  close <id>                         close a tab this session opened
  navigate <url|words>               move a tab to an address or search
  back | forward | reload            navigate tab history or reload
  read [--visual] [--since]          read the tab; --visual runs the OCR-fused pipeline
  find <query>                       matching interactive elements, as refs
  text [ref]                         exact text of one element, or full page text
  click <ref> [--allow-submit]       click an element ref from read/find
  fill <ref> <text> [--clear]        fill or clear a text field ref
  select <ref> <value>               choose a dropdown option by label or value
  press <key> [--ref <ref>]          send a keyboard key or shortcut chord
  hover <ref>                        move pointer over an element ref
  scroll [dir] [amount] [--ref <r>]  scroll page or container (up|down|left|right|top|bottom)
  wait [ms] [--text|--selector|--url|--state|--timeout]
                                     wait for a page condition or duration
  screenshot [--full-page] [--annotate] [--ref <ref>] [--out <file>]
                                     capture PNG screenshot (optional Set-of-Marks overlay)
  console [--clear] [--level <lvl>] [--limit <n>]
                                     read buffered tab console messages
  network [--clear] [--failed] [--limit <n>]
                                     read buffered tab network requests
  eval <expression>                  evaluate origin-gated JavaScript in the tab
  act <json> [--allow-submit]        batch: '[{"op":"click","ref":"e3"}, ...]'
  recall <query>                     search the page-memory graph
  forget [origin]                    drop memory for one origin, or all of it
  grant <origin>                     extend the session's origin scope

Refs (e3, e17) come from read/find output and stay valid until the page
navigates. Everything goes through the same refusals as the in-app agent.
`

function endpointCandidates() {
  const list = []
  if (process.env.TROY_ENDPOINT_FILE) list.push(process.env.TROY_ENDPOINT_FILE)
  const home = os.homedir()
  if (process.platform === 'darwin') {
    list.push(path.join(home, 'Library', 'Application Support', 'Troy', 'agent-endpoint.json'))
  } else if (process.platform === 'win32') {
    list.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Troy', 'agent-endpoint.json'))
  } else {
    list.push(path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Troy', 'agent-endpoint.json'))
  }
  return list
}

function readEndpoint(explicit) {
  /** @type {Array<{ file: string, pid: unknown }>} */
  const stale = []
  for (const file of explicit ? [explicit] : endpointCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && parsed.agentPort) {
        if (typeof parsed.pid === 'number' && !pidAlive(parsed.pid)) {
          stale.push({ file, pid: parsed.pid })
          continue
        }
        return { endpoint: { ...parsed, file }, stale }
      }
    } catch {
      // not there, or not troy's
    }
  }
  return { endpoint: null, stale }
}

function fail(message, extra) {
  const out = { ok: false, error: message, ...extra }
  console.error(JSON.stringify(out, null, 2))
  process.exit(1)
}

async function call(endpoint, route, body) {
  const url = `http://127.0.0.1:${endpoint.agentPort}${route}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-troy-agent': endpoint.agentToken },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    fail(`troy is not answering on ${endpoint.agentPort}; restart it with --agent or --cdp-port`)
  }
  const payload = await res.json().catch(() => null)
  if (payload === null) fail(`bad reply from troy (${res.status})`)
  return payload
}

const VALUE_FLAGS = new Set([
  '--tab',
  '--endpoint',
  '--origin',
  '--limit',
  '--ref',
  '--text',
  '--selector',
  '--state',
  '--url',
  '--ms',
  '--timeout',
  '--level',
  '--out',
  '--amount',
  '--direction',
])

const TOOL_COMMANDS = {
  read: (_args, flags) => [
    flags.visual ? 'page_read_visual' : 'page_read',
    { since: Boolean(flags.since) },
  ],
  find: (args) => ['page_find', { query: args.join(' ') }],
  text: (args) => ['page_text', args[0] ? { ref: args[0] } : {}],
  click: (args, flags) => [
    'page_click',
    { ref: args[0], ...(flags['allow-submit'] ? { allowSubmit: true } : {}) },
  ],
  fill: (args, flags) => [
    'page_fill',
    {
      ref: args[0],
      ...(args.length > 1 ? { text: args.slice(1).join(' ') } : {}),
      ...(flags.clear ? { clear: true } : {}),
    },
  ],
  select: (args) => ['page_select', { ref: args[0], value: args.slice(1).join(' ') }],
  press: (args, flags) => [
    'page_press',
    { key: args[0] ?? '', ...(flags.ref ? { ref: String(flags.ref) } : {}) },
  ],
  hover: (args) => ['page_hover', { ref: args[0] }],
  scroll: (args, flags) => [
    'page_scroll',
    {
      ...(flags.direction ? { direction: String(flags.direction) } : args[0] ? { direction: args[0] } : {}),
      ...(flags.amount !== undefined
        ? { amount: Number(flags.amount) }
        : args[1] !== undefined
          ? { amount: Number(args[1]) }
          : {}),
      ...(flags.ref ? { ref: String(flags.ref) } : {}),
    },
  ],
  wait: (args, flags) => [
    'page_wait',
    {
      ...(flags.text !== undefined ? { text: String(flags.text) } : {}),
      ...(flags.selector !== undefined ? { selector: String(flags.selector) } : {}),
      ...(flags.state !== undefined ? { state: String(flags.state) } : {}),
      ...(flags.url !== undefined ? { url: String(flags.url) } : {}),
      ...(flags.ms !== undefined ? { ms: Number(flags.ms) } : args[0] !== undefined ? { ms: Number(args[0]) } : {}),
      ...(flags.timeout !== undefined ? { timeoutMs: Number(flags.timeout) } : {}),
    },
  ],
  screenshot: (_args, flags) => [
    'page_screenshot',
    {
      fullPage: Boolean(flags['full-page'] || flags.fullPage),
      annotate: Boolean(flags.annotate),
      ...(flags.ref ? { ref: String(flags.ref) } : {}),
    },
  ],
  back: () => ['page_history', { direction: 'back' }],
  forward: () => ['page_history', { direction: 'forward' }],
  reload: () => ['page_history', { direction: 'reload' }],
  console: (_args, flags) => [
    'page_console',
    {
      clear: Boolean(flags.clear),
      ...(flags.level ? { level: String(flags.level) } : {}),
      ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
    },
  ],
  network: (_args, flags) => [
    'page_network',
    {
      clear: Boolean(flags.clear),
      failedOnly: Boolean(flags.failed || flags['failed-only']),
      ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
    },
  ],
  eval: (args) => ['page_eval', { expression: args.join(' ') }],
  act: (args, flags) => [
    'page_act',
    {
      ops: JSON.parse(args.join(' ')),
      ...(flags['allow-submit'] ? { allowSubmit: true } : {}),
    },
  ],
  navigate: (args) => ['page_navigate', { url: args.join(' ') }],
  recall: (args, flags) => ['page_recall', { query: args.join(' '), origin: flags.origin, limit: flags.limit && Number(flags.limit) }],
}

async function main() {
  const argv = process.argv.slice(2)
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') flags.json = true
    else if (VALUE_FLAGS.has(a)) flags[a.slice(2)] = argv[++i]
    else if (a.startsWith('--')) flags[a.slice(2)] = true
    else positional.push(a)
  }
  const [command, ...args] = positional

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  const { endpoint, stale } = readEndpoint(flags.endpoint ? String(flags.endpoint) : undefined)
  if (!endpoint) {
    if (stale.length > 0) {
      fail(`found stale agent-endpoint.json (pid ${stale[0].pid} is no longer running); restart troy with --agent or --cdp-port`, {
        stale,
      })
    }
    fail('no running troy found; launch it with --agent or --cdp-port', {
      lookedIn: endpointCandidates(),
      hint: 'point --endpoint or TROY_ENDPOINT_FILE at agent-endpoint.json for a custom profile',
    })
  }

  const tabId = flags.tab !== undefined ? Number(flags.tab) : undefined
  const routeFor = { status: '/memory', tabs: '/tabs', open: '/open', focus: '/activate', close: '/close', grant: '/grant-origin', forget: '/forget', recall: '/recall' }

  let result
  if (command === 'status') {
    const health = await call(endpoint, '/health')
    const memory = await call(endpoint, '/memory')
    result = { ...health, memory }
  } else if (command === 'recall') {
    result = await call(endpoint, '/recall', { query: args.join(' '), origin: flags.origin, limit: flags.limit && Number(flags.limit) })
  } else if (routeFor[command]) {
    const body =
      command === 'open' ? { url: args.join(' ') } :
      command === 'focus' || command === 'close' ? { tabId: Number(args[0]) } :
      command === 'grant' ? { origin: args.join(' ') } :
      command === 'forget' ? { origin: args.join(' ') || undefined } : {}
    result = await call(endpoint, routeFor[command], body)
  } else if (TOOL_COMMANDS[command]) {
    const [name, toolArgs] = TOOL_COMMANDS[command](args, flags)
    result = await call(endpoint, '/tool', { name, args: toolArgs, tabId })
    if (command === 'screenshot' && flags.out && result?.ok && typeof result.data === 'string') {
      const outFile = String(flags.out)
      fs.writeFileSync(outFile, Buffer.from(result.data, 'base64'))
      const { data: _omitted, ...meta } = result
      result = { ...meta, file: outFile, bytes: Buffer.byteLength(result.data, 'base64') }
    }
  } else {
    fail(`unknown command ${command}`, { hint: 'troy help lists what this knows' })
  }

  const ok = result?.ok !== false && !result?.error
  const out = flags.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)
  process.stdout.write(`${out}\n`)
  if (!ok) process.exit(1)
}

main().catch((error) => fail(String(error?.message ?? error)))
