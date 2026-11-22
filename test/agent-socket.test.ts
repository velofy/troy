import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The agent socket end to end: a real Electron process, the real endpoint
 * file, real POSTs to it. This is the surface a CLI agent lives on, so the
 * assertions are about what arrives over the wire — refs that work, tabs
 * that stay in the background, a token that gates everything.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const PAGE = `<!doctype html><title>socket fixture</title>
<style>body { min-height: 2000px; }</style>
<h1>Catalogue</h1>
<input id="q" type="search" name="q" placeholder="Search products" aria-label="Search the catalogue">
<button id="go" type="button">Search</button>
<a href="/cart" id="cart">Your cart</a>
<div id="hover-status">cold</div>
<script>
console.warn('fixture-boot-warning')
document.getElementById('go').addEventListener('click', () => {
  document.title = 'Searched: ' + document.getElementById('q').value
})
document.getElementById('go').addEventListener('mouseover', () => {
  document.getElementById('hover-status').textContent = 'hovered'
})
</script>`

const CART = `<!doctype html><title>cart</title><h1>Your cart</h1>`

const V3_FRAME = `<!doctype html><title>inner frame</title>
<style>body { margin: 0; padding: 12px; }</style>
<input id="fin" placeholder="Frame query">
<button id="fbtn" type="button" onclick="document.getElementById('fout').textContent='frame:' + document.getElementById('fin').value">Frame Submit</button>
<p id="fout">frame-idle</p>`

const V3_PAGE = `<!doctype html><title>v3 fixture</title>
<style>
  body { margin: 0; padding: 16px; }
  #f1 { width: 320px; height: 120px; border: 3px solid #222; display: block; margin-bottom: 12px; }
  #ctx-btn, #dbl-btn, #drag-src, #drag-dst { display: inline-block; width: 90px; height: 36px; margin-right: 12px; border: 1px solid #333; }
</style>
<iframe id="f1" src="/frame"></iframe>
<button id="ctx-btn" type="button">RightTarget</button>
<button id="dbl-btn" type="button">DoubleTarget</button>
<div id="drag-src" role="button" tabindex="0">DragSrc</div>
<div id="drag-dst" role="button" tabindex="0">DragDst</div>
<input id="file-up" type="file">
<div id="v3-log">ready</div>
<div id="upload-log">none</div>
<script>
const log = document.getElementById('v3-log');
document.getElementById('ctx-btn').addEventListener('contextmenu', (e) => { e.preventDefault(); log.textContent = 'ctx-ok'; });
document.getElementById('dbl-btn').addEventListener('dblclick', () => { log.textContent = 'dbl-ok'; });
let dragging = false;
document.getElementById('drag-src').addEventListener('mousedown', () => { dragging = true; });
window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const r = document.getElementById('drag-dst').getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
    log.textContent = 'drag-ok';
  }
});
document.getElementById('file-up').addEventListener('change', (e) => {
  const names = Array.from(e.target.files || []).map((f) => f.name).join(',');
  document.getElementById('upload-log').textContent = 'uploaded:' + names;
});
</script>`

let app: ElectronApplication
let dir: string
let server: Server
let base: string
let endpoint: { agentPort: number; agentToken: string; port: number }

interface SocketTab { id: number; url: string; active?: boolean }
interface InteractiveItem { ref?: string; placeholder?: string; ariaLabel?: string; text?: string }
interface ToolReply {
  ok?: boolean
  id?: number
  url?: string
  text?: string
  error?: unknown
  enabled?: boolean
  tabs?: SocketTab[]
  interactive?: InteractiveItem[]
  items?: InteractiveItem[]
  elements?: Array<{ selector?: string }>
  pages?: unknown[]
  mimeType?: string
  data?: string
  annotatedCount?: number
  value?: unknown
  scrollY?: number
  count?: number
  entries?: Array<{ text?: string; level?: string; url?: string; status?: number }>
  delta?: boolean
  added?: InteractiveItem[]
  changed?: InteractiveItem[]
  matched?: boolean
  blocked?: boolean
  code?: string
  files?: string[]
  resumedBy?: string
  waiting?: boolean
  armed?: { accept?: boolean; promptText?: string } | null
  history?: Array<{ type?: string; message?: string; handled?: string; promptText?: string }>
}

async function post(route: string, body: unknown = {}, token?: string): Promise<ToolReply> {
  const res = await fetch(`http://127.0.0.1:${endpoint.agentPort}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-troy-agent': token ?? endpoint.agentToken,
    },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<ToolReply>
}

/** The first tab only exists once the chrome page has finished loading, so
 *  callers that arrive the instant the endpoint file lands must poll. */
async function tabList(predicate: (tabs: SocketTab[]) => boolean, what: string): Promise<SocketTab[]> {
  const deadline = Date.now() + 15_000
  let tabs: SocketTab[] = []
  while (Date.now() < deadline) {
    const res = await post('/tabs')
    tabs = res.tabs ?? []
    if (predicate(tabs)) return tabs
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`timed out waiting for ${what}; last tabs: ${JSON.stringify(tabs)}`)
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'troy-socket-'))
  // Memory on, so the recall path is exercised against a real store.
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ agentMemory: true }))

  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/cart') res.end(CART)
    else if (req.url === '/v3') res.end(V3_PAGE)
    else if (req.url === '/frame') res.end(V3_FRAME)
    else res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  app = await electron.launch({
    args: [path.join(root, 'src', 'browser', 'main.js'), `--user-data-dir=${dir}`, '--agent'],
    env: { ...process.env, TROY_TEST: '1' },
  })
  // Prevent Playwright's test harness from auto-dismissing JS dialogs on tabs
  // so Troy's own CDP Page.javascriptDialogOpening handler owns them cleanly.
  app.context().on('page', (page) => {
    page.on('dialog', () => {})
  })
  for (const page of app.windows()) {
    page.on('dialog', () => {})
  }

  const file = path.join(dir, 'agent-endpoint.json')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !existsSync(file)) {
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  expect(existsSync(file)).toBe(true)
  endpoint = JSON.parse(readFileSync(file, 'utf8'))
}, 60_000)

afterAll(async () => {
  await app?.close()
  server?.close()
  await rm(dir, { recursive: true, force: true })
})

describe('the agent socket', () => {
  it('refuses callers without the per-launch token', async () => {
    const denied = await post('/tabs', {}, 'wrong-token')
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/token/)
  })

  it('lists tabs and opens one in the background', async () => {
    const before = await tabList((t) => t.length >= 1, 'the first tab')
    expect(before.length).toBe(1)

    const opened = await post('/open', { url: `${base}/` })
    expect(opened.ok).toBe(true)
    expect(opened.id).toBeGreaterThan(0)

    // The new tab must not be what the person was looking at.
    const tabs = await tabList((t) => t.some((x) => x.id === opened.id), 'the opened tab')
    const mine = tabs.find((t: { id: number }) => t.id === opened.id)
    expect(mine).toBeTruthy()
    expect(mine!.active).toBe(false)
  })

  it('reads a tab and hands out refs that actions can use', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)), 'the fixture tab')
    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    expect(mine).toBeTruthy()

    const deadline = Date.now() + 15_000
    let read: ToolReply = {}
    while (Date.now() < deadline) {
      read = await post('/tool', { tabId: mine!.id, name: 'page_read' })
      if (read.ok && read.interactive?.length) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(read.ok).toBe(true)
    expect(read.url).toContain(base)
    const search = read.interactive?.find((i) => /search/i.test(i.placeholder || i.ariaLabel || i.text || ''))
    expect(search?.ref).toMatch(/^e\d+$/)

    const filled = await post('/tool', { tabId: mine!.id, name: 'page_fill', args: { ref: search!.ref, text: 'wireless mouse' } })
    expect(filled.error).toBeUndefined()
    expect(filled.ok).toBe(true)

    // Refs survive the action: the same ref resolves again without a re-read.
    const text = await post('/tool', { tabId: mine!.id, name: 'page_text', args: { ref: search!.ref } })
    expect(text.ok).toBe(true)
    expect(text.text).toBe('wireless mouse')
  })

  it('finds elements by name without a full read', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)), 'the fixture tab')
    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    const found = await post('/tool', { tabId: mine!.id, name: 'page_find', args: { query: 'cart' } })
    expect(found.ok).toBe(true)
    expect(found.items!.length).toBeGreaterThan(0)
    expect(found.items![0].ref).toMatch(/^e\d+$/)
    expect(found.items![0].text).toMatch(/cart/i)
  })

  it('remembers what it read and recalls it', async () => {
    const mem = await post('/memory')
    expect(mem.enabled).toBe(true)

    const found = await post('/recall', { query: 'search' })
    expect(found.ok).toBe(true)
    expect(found.elements!.length).toBeGreaterThan(0)
    expect(found.elements![0].selector).toBe('#q')
    expect(found.pages!.length).toBeGreaterThan(0)
  })

  it('supports upgraded browser-user tools end-to-end and disables page_scrape', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)), 'the fixture tab')
    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))!

    // Dead page_scrape stub is not advertised on the bridge
    const scrape = await post('/tool', { tabId: mine.id, name: 'page_scrape', args: { url: 'https://example.com' } })
    expect(scrape.ok).toBe(false)
    expect(String(scrape.error)).toMatch(/unknown tool/i)

    // Full-page page_text without ref
    const fullText = await post('/tool', { tabId: mine.id, name: 'page_text', args: {} })
    expect(fullText.ok).toBe(true)
    expect(fullText.text).toContain('Catalogue')

    // page_eval, page_scroll, page_press, page_wait
    const evalRes = await post('/tool', { tabId: mine.id, name: 'page_eval', args: { expression: 'document.title' } })
    expect(evalRes.ok).toBe(true)
    expect(evalRes.value).toBe('socket fixture')

    const scrollRes = await post('/tool', { tabId: mine.id, name: 'page_scroll', args: { direction: 'down', amount: 300 } })
    expect(scrollRes.ok).toBe(true)
    expect(scrollRes.scrollY).toBeGreaterThanOrEqual(200)

    const pressRes = await post('/tool', { tabId: mine.id, name: 'page_press', args: { key: 'Home' } })
    expect(pressRes.ok).toBe(true)

    const waitRes = await post('/tool', { tabId: mine.id, name: 'page_wait', args: { text: 'Catalogue', timeoutMs: 2000 } })
    expect(waitRes.ok).toBe(true)
    expect(waitRes.matched).toBe(true)

    // page_hover via ref
    const readRes = await post('/tool', { tabId: mine.id, name: 'page_read', args: {} })
    const btn = readRes.interactive?.find((i) => i.text === 'Search')
    expect(btn?.ref).toMatch(/^e\d+$/)
    const hoverRes = await post('/tool', { tabId: mine.id, name: 'page_hover', args: { ref: btn!.ref } })
    expect(hoverRes.ok).toBe(true)

    // Set-of-Marks page_screenshot: valid PNG arrives intact and overlay is cleaned up
    const shot = await post('/tool', { tabId: mine.id, name: 'page_screenshot', args: { annotate: true } })
    expect(shot.ok).toBe(true)
    expect(shot.mimeType).toBe('image/png')
    expect(shot.data?.startsWith('iVBORw0KGgo')).toBe(true)
    expect((shot.annotatedCount ?? 0)).toBeGreaterThan(0)
    const overlayGone = await post('/tool', { tabId: mine.id, name: 'page_eval', args: { expression: 'document.getElementById("__troy_som_overlay") === null' } })
    expect(overlayGone.value).toBe(true)

    // page_console and page_network capture telemetry
    const consoleRes = await post('/tool', { tabId: mine.id, name: 'page_console', args: {} })
    expect(consoleRes.ok).toBe(true)
    expect(Array.isArray(consoleRes.entries)).toBe(true)
    const networkRes = await post('/tool', { tabId: mine.id, name: 'page_network', args: {} })
    expect(networkRes.ok).toBe(true)
    expect(Array.isArray(networkRes.entries)).toBe(true)

    // page_history reload
    const reloadRes = await post('/tool', { tabId: mine.id, name: 'page_history', args: { direction: 'reload' } })
    expect(reloadRes.ok).toBe(true)
    expect(reloadRes.url).toContain(base)
  })

  it('supports v3.0 superpowers end-to-end in real Electron: iframe piercing, trusted clickPoint/drag, safe page_upload, page_dialog, and page_handoff', async () => {
    const opened = await post('/open', { url: `${base}/v3` })
    expect(opened.ok).toBe(true)
    const tabId = opened.id!

    // Wait for both page and same-origin iframe to finish rendering
    const deadline = Date.now() + 15_000
    let read: ToolReply = {}
    while (Date.now() < deadline) {
      read = await post('/tool', { tabId, name: 'page_read' })
      if (read.ok && read.interactive?.some((i) => i.placeholder === 'Frame query')) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(read.ok).toBe(true)
    const frameInput = read.interactive?.find((i) => i.placeholder === 'Frame query')
    const frameBtn = read.interactive?.find((i) => i.text === 'Frame Submit')
    expect(frameInput?.ref).toMatch(/^e\d+$/)
    expect(frameBtn?.ref).toMatch(/^e\d+$/)

    // Fill & click inside same-origin iframe on a background tab
    const fFill = await post('/tool', { tabId, name: 'page_fill', args: { ref: frameInput!.ref, text: 'troy-v3' } })
    expect(fFill.ok).toBe(true)
    const fClick = await post('/tool', { tabId, name: 'page_click', args: { ref: frameBtn!.ref, allowSubmit: true } })
    expect(fClick.ok).toBe(true)
    const fOut = await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('f1').contentDocument.getElementById('fout').textContent` } })
    expect(fOut.value).toBe('frame:troy-v3')

    // Safe page_upload on a background tab: blocks .ssh/id_rsa and uploads a real temp file via CDP DOM.setFileInputFiles
    const fileInput = read.interactive?.find((i) => i.ref && (i as Record<string, unknown>).type === 'file')
    expect(fileInput?.ref).toMatch(/^e\d+$/)
    const blockedUpload = await post('/tool', { tabId, name: 'page_upload', args: { ref: fileInput!.ref, files: ['/home/user/.ssh/id_rsa'] } })
    expect(blockedUpload.ok).toBe(false)
    expect(blockedUpload.blocked).toBe(true)

    const sampleFile = path.join(dir, 'sample-upload.txt')
    await writeFile(sampleFile, 'troy v3 upload test')
    const uploaded = await post('/tool', { tabId, name: 'page_upload', args: { ref: fileInput!.ref, files: [sampleFile] } })
    expect(uploaded.ok).toBe(true)
    expect(uploaded.files).toEqual(['sample-upload.txt'])
    expect((await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('upload-log').textContent` } })).value).toBe('uploaded:sample-upload.txt')

    // page_handoff: non-blocking mode + wait mode resumed via window.__troyHandoffResumed
    // (also exercises focusTab showing the window & activating the tab)
    const handoffNonBlocking = await post('/tool', { tabId, name: 'page_handoff', args: { reason: 'Check status', wait: false } })
    expect(handoffNonBlocking.ok).toBe(true)
    expect(handoffNonBlocking.waiting).toBe(false)

    const handoffPromise = post('/tool', { tabId, name: 'page_handoff', args: { reason: 'Resume me', timeoutMs: 5000 } })
    await new Promise((r) => setTimeout(r, 250))
    await post('/tool', { tabId, name: 'page_eval', args: { expression: `window.__troyHandoffResumed = true` } })
    const handoffDone = await handoffPromise
    expect(handoffDone.ok).toBe(true)
    expect(handoffDone.resumedBy).toBe('user')
    const bannerCleaned = await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('troy-handoff-banner') === null` } })
    expect(bannerCleaned.value).toBe(true)

    // Trusted CDP right-click, double-click, and drag
    const ctxBtn = read.interactive?.find((i) => i.text === 'RightTarget')
    const dblBtn = read.interactive?.find((i) => i.text === 'DoubleTarget')
    const dragSrc = read.interactive?.find((i) => i.text === 'DragSrc')
    const dragDst = read.interactive?.find((i) => i.text === 'DragDst')
    expect(ctxBtn?.ref && dblBtn?.ref && dragSrc?.ref && dragDst?.ref).toBeTruthy()

    const rightClick = await post('/tool', { tabId, name: 'page_click', args: { ref: ctxBtn!.ref, button: 'right' } })
    expect(rightClick.ok).toBe(true)
    expect((await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('v3-log').textContent` } })).value).toBe('ctx-ok')

    const dblClick = await post('/tool', { tabId, name: 'page_click', args: { ref: dblBtn!.ref, clickCount: 2 } })
    expect(dblClick.ok).toBe(true)
    expect((await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('v3-log').textContent` } })).value).toBe('dbl-ok')

    const dragRes = await post('/tool', { tabId, name: 'page_drag', args: { fromRef: dragSrc!.ref, toRef: dragDst!.ref, steps: 6 } })
    expect(dragRes.ok).toBe(true)
    expect((await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('v3-log').textContent` } })).value).toBe('drag-ok')

    // Coordinate click via trusted CDP clickPoint
    const ctxCenter = await post('/tool', { tabId, name: 'page_eval', args: { expression: `(() => { const r = document.getElementById('ctx-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()` } })
    const pt = ctxCenter.value as { x: number; y: number }
    const coordClick = await post('/tool', { tabId, name: 'page_click', args: { x: pt.x, y: pt.y, button: 'right' } })
    expect(coordClick.ok).toBe(true)
    expect((await post('/tool', { tabId, name: 'page_eval', args: { expression: `document.getElementById('v3-log').textContent` } })).value).toBe('ctx-ok')

    // Set-of-Marks screenshot covers iframe elements cleanly and removes overlay
    const somShot = await post('/tool', { tabId, name: 'page_screenshot', args: { annotate: true } })
    expect(somShot.ok).toBe(true)
    expect((somShot.annotatedCount ?? 0)).toBeGreaterThanOrEqual(6)

    // page_dialog: alert & confirm auto-handled without freezing, plus armed accept
    const alertEval = await post('/tool', { tabId, name: 'page_eval', args: { expression: `(() => { alert('auto-alert'); return confirm('auto-confirm'); })()` } })
    expect(alertEval.ok).toBe(true)
    expect(alertEval.value).toBe(false)

    const arm = await post('/tool', { tabId, name: 'page_dialog', args: { action: 'accept', promptText: 'TroyV3Prompt' } })
    expect(arm.ok).toBe(true)
    expect(arm.armed).toMatchObject({ accept: true, promptText: 'TroyV3Prompt' })

    const confirmAccepted = await post('/tool', { tabId, name: 'page_eval', args: { expression: `confirm('proceed?')` } })
    expect(confirmAccepted.ok).toBe(true)
    expect(confirmAccepted.value).toBe(true)

    const dlgStatus = await post('/tool', { tabId, name: 'page_dialog', args: { action: 'status' } })
    expect(dlgStatus.ok).toBe(true)
    expect(dlgStatus.armed).toBeNull()
    expect((dlgStatus.history?.length ?? 0)).toBeGreaterThanOrEqual(3)
    expect(dlgStatus.history?.[0]).toMatchObject({ type: 'alert', handled: 'auto-accept' })
    expect(dlgStatus.history?.[1]).toMatchObject({ type: 'confirm', handled: 'auto-dismiss' })
    expect(dlgStatus.history?.[2]).toMatchObject({ type: 'confirm', handled: 'armed-accept' })

    const closedV3 = await post('/close', { tabId })
    expect(closedV3.ok).toBe(true)
  }, 30_000)

  it('troy CLI detects dead PID in agent-endpoint.json cleanly', async () => {
    const staleFile = path.join(dir, 'stale-endpoint.json')
    await writeFile(staleFile, JSON.stringify({ port: 0, pid: 99999999, agentPort: 19999, agentToken: 'dead' }))
    let stderr = ''
    try {
      execFileSync(process.execPath, [path.join(root, 'bin', 'troy.mjs'), 'status', '--endpoint', staleFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '')
    }
    expect(stderr).toMatch(/stale agent-endpoint\.json|no longer running/i)

    const helpOut = execFileSync(process.execPath, [path.join(root, 'bin', 'troy.mjs'), '--help'], {
      encoding: 'utf8',
    })
    expect(helpOut).toContain('drag')
    expect(helpOut).toContain('upload')
    expect(helpOut).toContain('dialog')
    expect(helpOut).toContain('handoff')
    expect(helpOut).toContain('--button')
    expect(helpOut).toContain('--double')
  })

  it('refuses to close a tab it did not open, and closes one it did', async () => {
    const tabs = await tabList((t) => t.some((x) => x.url.startsWith(base)) && t.some((x) => !x.url.startsWith(base)), 'both tabs')
    const foreign = tabs.find((t: { url: string }) => !t.url.startsWith(base))
    const refused = await post('/close', { tabId: foreign!.id })
    expect(refused.ok).toBe(false)

    const mine = tabs.find((t: { url: string }) => t.url.startsWith(base))
    const closed = await post('/close', { tabId: mine!.id })
    expect(closed.ok).toBe(true)
  })
})
