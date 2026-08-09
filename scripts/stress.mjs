// Does Troy stay at 60fps when you actually use it.
//
//   node scripts/stress.mjs [--tabs 12] [--seconds 6]
//
// Frame rate is measured in the chrome's own renderer, because that is the
// surface the user is touching: the tab strip, the omnibox, the loading bar.
// A web page janking is the page's problem, but the chrome stuttering while
// you switch tabs is Troy's.
//
// While the frames are being counted, the browser is put under the load that
// actually happens: many tabs open, each running an animation and a stream of
// network requests, tabs being switched, the omnibox being typed into and the
// loading bar running. Measuring an idle window would prove nothing.
//
// Exits non-zero if the 95th percentile frame takes longer than one 60fps
// frame plus a margin, or if any single frame stalls past the threshold.

import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : Number(args[at + 1])
}

const TABS = flag('tabs', 12)
const SECONDS = flag('seconds', 6)

/** One 60fps frame. */
const FRAME_MS = 1000 / 60
/** Scheduling noise on a shared machine is real; this is the budget, not the ideal. */
const P95_BUDGET_MS = FRAME_MS * 1.6
/** Anything past this is a visible hitch rather than a slow frame. */
const STALL_MS = 100

/**
 * A page that is deliberately hostile: constant animation, layout churn and
 * a steady drip of requests, so the browser is never idle.
 */
const BUSY_PAGE = `<!doctype html>
<title>Troy stress</title>
<style>
  body { margin: 0; background: #14161a; color: #ddd; font: 13px system-ui; overflow: hidden; }
  .box { position: absolute; width: 60px; height: 60px; border-radius: 8px; background: #d97757; }
</style>
<div id="stage"></div>
<script>
  const stage = document.getElementById('stage')
  const boxes = []
  for (let i = 0; i < 60; i++) {
    const el = document.createElement('div')
    el.className = 'box'
    stage.append(el)
    boxes.push({ el, x: Math.random() * 800, y: Math.random() * 500, dx: 1 + Math.random() * 3, dy: 1 + Math.random() * 3 })
  }
  function tick() {
    for (const b of boxes) {
      b.x += b.dx; b.y += b.dy
      if (b.x < 0 || b.x > innerWidth - 60) b.dx *= -1
      if (b.y < 0 || b.y > innerHeight - 60) b.dy *= -1
      b.el.style.transform = 'translate(' + b.x + 'px,' + b.y + 'px)'
    }
    requestAnimationFrame(tick)
  }
  tick()
  // A steady stream of subresource requests, so the tracker blocker and the
  // network stack are on the hot path throughout.
  setInterval(() => { fetch('/asset?' + Math.random()).catch(() => {}) }, 40)
</script>`

function serve() {
  return new Promise((resolve) => {
    const sockets = new Set()
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/asset')) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        res.end('x'.repeat(2048))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(BUSY_PAGE)
    })
    server.on('connection', (s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          for (const s of sockets) s.destroy()
          server.close()
        },
      })
    })
  })
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

const fixture = await serve()
const userDataDir = mkdtempSync(path.join(tmpdir(), 'troy-stress-'))
let app
let failed = false

try {
  app = await electron.launch({
    args: [path.join(root, 'src', 'browser', 'main.js'), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, TROY_TEST: '1' },
  })
  const chrome = await app.firstWindow()
  await chrome.waitForSelector('.tab', { timeout: 30_000 })

  console.log(`stress: opening ${TABS} busy tabs`)
  for (let i = 0; i < TABS; i++) {
    await chrome.evaluate((url) => window.troy.newTab(url), `${fixture.url}/page${i}`)
  }
  // Let them all get going, so the measurement covers steady-state load
  // rather than the quiet moment before it.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const tabIds = await app.evaluate(() => globalThis.__troy.snapshot().tabs.map((t) => t.id))
  console.log(`stress: ${tabIds.length} tabs live, measuring for ${SECONDS}s under interaction`)

  // Start counting frames in the chrome renderer.
  await chrome.evaluate(() => {
    globalThis.__frames = []
    let last = performance.now()
    const step = (now) => {
      globalThis.__frames.push(now - last)
      last = now
      globalThis.__raf = requestAnimationFrame(step)
    }
    globalThis.__raf = requestAnimationFrame(step)
  })

  // Hammer the chrome while it is being measured: switch tabs, type, reload.
  const until = Date.now() + SECONDS * 1000
  let round = 0
  while (Date.now() < until) {
    const id = tabIds[round % tabIds.length]
    await chrome.evaluate((tabId) => window.troy.selectTab(tabId), id)
    await chrome.fill('#omni', `stress round ${round}`)
    if (round % 5 === 0) await chrome.evaluate(() => window.troy.reload())
    round += 1
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  const frames = await chrome.evaluate(() => {
    cancelAnimationFrame(globalThis.__raf)
    return globalThis.__frames.slice(1)
  })

  const sorted = [...frames].sort((a, b) => a - b)
  const median = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)
  const worst = sorted[sorted.length - 1] ?? 0
  const fps = median > 0 ? 1000 / median : 0
  const stalls = frames.filter((f) => f > STALL_MS).length

  const memory = await app.evaluate(() => {
    const used = process.getProcessMemoryInfo ? null : null
    return { rssMb: Math.round(process.memoryUsage().rss / 1048576), used }
  })

  console.log('')
  console.log(`  frames measured   ${frames.length}`)
  console.log(`  median frame      ${median.toFixed(2)}ms  (${fps.toFixed(1)} fps)`)
  console.log(`  p95 frame         ${p95.toFixed(2)}ms  (budget ${P95_BUDGET_MS.toFixed(2)}ms)`)
  console.log(`  worst frame       ${worst.toFixed(2)}ms`)
  console.log(`  stalls over ${STALL_MS}ms  ${stalls}`)
  console.log(`  main process rss  ${memory.rssMb}MB`)
  console.log(`  interaction rounds ${round}`)
  console.log('')

  if (fps < 59) {
    console.error(`stress: FAIL median is ${fps.toFixed(1)} fps, below 60`)
    failed = true
  }
  if (p95 > P95_BUDGET_MS) {
    console.error(`stress: FAIL p95 frame ${p95.toFixed(2)}ms exceeds ${P95_BUDGET_MS.toFixed(2)}ms`)
    failed = true
  }
  if (stalls > 0) {
    console.error(`stress: FAIL ${stalls} frame(s) stalled past ${STALL_MS}ms`)
    failed = true
  }
  if (!failed) console.log('stress: PASS')
} catch (err) {
  console.error('stress: FAIL', err && err.message ? err.message : err)
  failed = true
} finally {
  await app?.close().catch(() => {})
  fixture.close()
  rmSync(userDataDir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
