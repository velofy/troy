// Read a page the way the browser does: settle, extract, cover, transcribe,
// fuse. Prints markdown by default, the full fused document with --json.
//
//   node scripts/read.mjs                        # active tab of a running Troy
//   node scripts/read.mjs --url https://example.com
//   node scripts/read.mjs --json --out page.json
//   node scripts/read.mjs --fetch-mode=reap --url https://example.com
//
// Attaches over CDP through agent-endpoint.json and detaches when done; it
// never closes the browser it found.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { readPage } from '../src/read/pipeline.js'
import { toMarkdown } from '../src/read/render.js'

function endpointFile() {
  if (process.env.TROY_ENDPOINT_FILE) return process.env.TROY_ENDPOINT_FILE
  const base = process.platform === 'win32' ? 'AppData/Roaming' : 'Library/Application Support'
  return path.join(os.homedir(), base, 'Troy', 'agent-endpoint.json')
}

async function attach() {
  const file = endpointFile()
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `no agent-endpoint.json at ${file}. Start Troy with --cdp-port=9333 so agents can attach.`,
    )
  }
  const endpoint = JSON.parse(raw)
  return chromium.connectOverCDP(endpoint.httpEndpoint)
}

/** Run the pipeline against an existing Playwright Page. */
async function readOverCdp(page) {
  const session = await page.context().newCDPSession(page)
  const evaluate = async (expression) => {
    const { result } = await session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (result.type === 'error' || result.subtype === 'error') {
      throw new Error(String(result.description ?? 'evaluation failed'))
    }
    if (result.type === 'undefined') return 'undefined'
    return String(result.value ?? '')
  }
  const screenshot = async (box) => {
    // CDP Page.captureScreenshot clips in css pixels with captureBeyondView
    // off; the viewport is what we get, which is all the OCR stage needs.
    const clip = box ?? undefined
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })
    return Buffer.from(data, 'base64')
  }
  return readPage({ evaluate, screenshot })
}

/**
 * Fetch over plain HTTP through the curl_reap CLI, for pages that block
 * headless clients at the TLS layer before a renderer is ever involved.
 * Availability is reported honestly: no reap, no pretending.
 */
async function readViaReap(url) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    const child = spawn('python3', ['-m', 'curl_reap.cli', 'get', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', () => {
      resolve({
        ok: false,
        error: 'curl_reap is not installed or python3 is missing; install it with pip install curl-reap',
      })
    })
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve({ ok: true, markdown: out })
      else resolve({ ok: false, error: err.trim() || `curl_reap exited ${code}` })
    })
  })
}

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const fetchMode = args.find((a) => a.startsWith('--fetch-mode='))?.split('=')[1]
const urlArg = args[args.indexOf('--url') + 1]
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null

try {
  if (fetchMode === 'reap') {
    if (!urlArg || urlArg.startsWith('-')) {
      console.error('read: --fetch-mode=reap needs --url <address>')
      process.exit(2)
    }
    const result = await readViaReap(urlArg)
    if (!result.ok) {
      console.error(`read: ${result.error}`)
      process.exit(1)
    }
    const text = wantsJson ? JSON.stringify({ url: urlArg, source: 'reap', markdown: result.markdown }, null, 2) : result.markdown
    if (outFile) fs.writeFileSync(outFile, text)
    else console.log(text)
    process.exit(0)
  }

  const browser = await attach()
  try {
    const [context] = browser.contexts()
    const pages = context.pages().filter((p) => p.url().startsWith('http'))
    const page = urlArg
      ? pages.find((p) => p.url() === urlArg)
      : pages[pages.length - 1]
    if (!page) {
      console.error(urlArg
        ? `read: no open tab matches ${urlArg}`
        : 'read: no http tab is open in Troy')
      process.exit(2)
    }
    const doc = await readOverCdp(page)
    const text = wantsJson ? JSON.stringify(doc, null, 2) : toMarkdown(doc)
    if (outFile) fs.writeFileSync(outFile, text)
    else console.log(text)
  } finally {
    // Detach only. This is the user's live browser with their sessions in it.
    await browser.close().catch(() => {})
  }
} catch (err) {
  console.error(`read: ${err.message}`)
  process.exit(1)
}
