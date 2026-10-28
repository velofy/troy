#!/usr/bin/env node
// Agent-loop latency benchmark for Troy's Agent Socket.
//
// Measures what an agent actually pays per operation against a running Troy:
//   health  loopback RTT (probe cost)
//   tabs    tab list
//   read    page_read (DOM pipeline) on the active/agent tab
//   find    page_find (no extra read)
//   since   page_read?since=1 (delta read — bytes vs full read)
//
// Usage: node scripts/bench.mjs [--file <agent-endpoint.json>] [--rounds 5] [--json]
//        node scripts/bench.mjs --url https://example.com   (bench a real loaded page)
// Troy must be running (hidden is fine):  Troy --agent --hidden
// Defaults to the standard endpoint file for the platform.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const rounds = Math.max(1, Number(opt('--rounds', '5')) || 5)
const asJson = args.includes('--json')

function defaultEndpointFile() {
  if (process.env.TROY_ENDPOINT_FILE) return process.env.TROY_ENDPOINT_FILE
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Troy', 'agent-endpoint.json')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Troy', 'agent-endpoint.json')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Troy', 'agent-endpoint.json')
}

const file = opt('--file', defaultEndpointFile())
let endpoint
try {
  endpoint = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  console.error(`No Troy endpoint at ${file}. Launch Troy first: Troy --agent --hidden`)
  process.exit(2)
}
const { agentPort, agentToken } = endpoint
if (!agentPort || !agentToken) {
  console.error(`Endpoint ${file} has no agentPort/agentToken — Troy was not launched with the agent socket.`)
  process.exit(2)
}

async function call(route, body = {}) {
  const started = performance.now()
  const res = await fetch(`http://127.0.0.1:${agentPort}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-troy-agent': agentToken },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const ms = performance.now() - started
  let parsed = {}
  try { parsed = JSON.parse(text) } catch {}
  return { ms, bytes: Buffer.byteLength(text), ok: res.ok && parsed.ok !== false, parsed }
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function bench(name, fn) {
  const times = []
  let bytes = 0
  let ok = true
  for (let i = 0; i < rounds; i++) {
    const r = await fn()
    times.push(r.ms)
    bytes = r.bytes
    ok = ok && r.ok
    if (r.parsed !== undefined) bench.last = r.parsed
  }
  return { name, medianMs: Math.round(median(times) * 10) / 10, minMs: Math.round(Math.min(...times) * 10) / 10, bytes, ok }
}

const results = []
results.push(await bench('health', () => call('/health')))
results.push(await bench('tabs', () => call('/tabs')))

const benchUrl = opt('--url', '')
let tab
let openedTab = false
if (benchUrl) {
  // Bench a real, fully loaded page: open hidden, wait until the read
  // returns content (open returns before navigation settles).
  const opened = await call('/open', { url: benchUrl })
  tab = { id: opened.parsed.id }
  openedTab = true
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await call('/tool', { name: 'page_read', args: {}, tabId: tab.id })
    if (r.parsed.characterCount > 0 || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
} else {
  const tabs = bench.last?.tabs || []
  tab = tabs.find((t) => t.owned) || tabs.find((t) => t.active) || tabs[0]
}
if (tab) {
  const read = await bench('read', () => call('/tool', { name: 'page_read', args: {}, tabId: tab.id }))
  results.push(read)
  const findQuery = String(bench.last?.interactive?.[0]?.name || 'a').split(/\s+/)[0]
  results.push(await bench('find', () => call('/tool', { name: 'page_find', args: { query: findQuery }, tabId: tab.id })))
  results.push(await bench('read?since=1', () => call('/tool', { name: 'page_read', args: { since: true }, tabId: tab.id })))
  if (openedTab) await call('/close', { tabId: tab.id })
}

if (asJson) {
  console.log(JSON.stringify({ file, rounds, results }, null, 2))
} else {
  console.log(`Troy agent-loop bench — ${file} (${rounds} rounds, median)`)
  for (const r of results) {
    console.log(`${r.name.padEnd(14)} ${String(r.medianMs).padStart(7)} ms  (min ${r.minMs} ms)  ${String(r.bytes).padStart(7)} bytes  ${r.ok ? 'ok' : 'FAILED'}`)
  }
}
if (results.some((r) => !r.ok)) process.exit(1)
