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
import { fileURLToPath } from 'node:url'

const USAGE = `troy — drive the running Troy browser

Usage: troy <command> [args] [--json] [--tab <id>] [--endpoint <file>]

  status                     is a bridge up, and what is it remembering
  tabs                       list tabs (id, url, title, active)
  open <url|words>           open a background tab; prints its id
  focus <id>                 bring a tab to the front
  close <id>                 close a tab this session opened
  navigate <url|words>       move a tab to an address or search
  read [--visual] [--since]  read the tab; --visual runs the OCR-fused pipeline
  find <query>               matching interactive elements, as refs
  text <ref>                 exact text of one element
  click <ref>                click an element ref from read/find
  fill <ref> <text>          fill a text field ref
  select <ref> <value>       choose a dropdown option by label or value
  act <json>                 batch: '[{"op":"click","ref":"e3"}, ...]'
  recall <query>             search the page-memory graph
  forget [origin]            drop memory for one origin, or all of it
  grant <origin>             extend the session's origin scope

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
  for (const file of explicit ? [explicit] : endpointCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && parsed.agentPort) return { ...parsed, file }
    } catch {
      // not there, or not troy's
    }
  }
  return null
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

const TOOL_COMMANDS = {
  read: (args, flags) => [
    flags.visual ? 'page_read_visual' : 'page_read',
    { since: Boolean(flags.since) },
  ],
  find: (args) => ['page_find', { query: args.join(' ') }],
  text: (args) => ['page_text', { ref: args[0] }],
  click: (args) => ['page_click', { ref: args[0] }],
  fill: (args) => ['page_fill', { ref: args[0], text: args.slice(1).join(' ') }],
  select: (args) => ['page_select', { ref: args[0], value: args.slice(1).join(' ') }],
  act: (args) => ['page_act', { ops: JSON.parse(args.join(' ')) }],
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
    else if (a === '--tab' || a === '--endpoint' || a === '--origin' || a === '--limit') flags[a.slice(2)] = argv[++i]
    else if (a.startsWith('--')) flags[a.slice(2)] = true
    else positional.push(a)
  }
  const [command, ...args] = positional

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  const endpoint = readEndpoint(flags.endpoint ? String(flags.endpoint) : undefined)
  if (!endpoint) {
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
  } else {
    fail(`unknown command ${command}`, { hint: 'troy help lists what this knows' })
  }

  const ok = result?.ok !== false && !result?.error
  const out = flags.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)
  process.stdout.write(`${out}\n`)
  if (!ok) process.exit(1)
}

main().catch((error) => fail(String(error?.message ?? error)))
