// Settle: refuse to read a page that is still moving.
//
// A page read mid-render is the most common source of garbage output: half
// the article, a font that has not swapped in yet, a layout that shifts one
// more time after the text was measured. So the pipeline waits for three
// independent signals before extracting:
//
//   1. document.readyState === "complete", the document and its
//      subresources have loaded;
//   2. document.fonts.ready has resolved, so the boxes we are about to
//      measure are the boxes a person sees, not fallback-font boxes;
//   3. two consecutive animation frames in which a cheap layout signature
//      (scroll extent plus element count) did not change, which is the
//      closest observable to "the page stopped reflowing".
//
// And then it gives up. A page that never settles, an infinite spinner, a
// ticking ad, a clock, must still be readable, so the timeout returns
// normally with settled: false rather than throwing. Refusing to read an
// unsettled page would make the pipeline useless on exactly the pages that
// most need it.
//
// Why polling rather than one in-page promise: the narrow port's evaluate
// returns values, not awaited promises (Runtime.evaluate without
// awaitPromise), and widening the port for this one stage would leak a
// settle concern into every host. Polling a tiny synchronous probe costs a
// few round trips and works over any evaluate.

/**
 * The in-page probe. Installed once per document (it keys itself on a
 * window property), then every poll reads its current counters. The
 * requestAnimationFrame loop stops itself once it has seen enough quiet
 * frames, because a probe that spins forever would be Troy taxing the very
 * page it promised only to read. A later settle() call restarts the loop by
 * resetting the counters through the `reset` flag on its first poll.
 *
 * @param {boolean} reset
 * @returns {string} an expression evaluating to a JSON string
 */
export function settleProbeExpression(reset) {
  return `(() => {
    const w = window
    let probe = w.__troySettleProbe
    if (!probe) {
      probe = { fontsReady: false, quiet: 0, last: '', running: false }
      w.__troySettleProbe = probe
      const fonts = document.fonts
      if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
        fonts.ready.then(() => { probe.fontsReady = true }, () => { probe.fontsReady = true })
      } else {
        probe.fontsReady = true
      }
    }
    if (${reset ? 'true' : 'false'}) { probe.quiet = 0; probe.last = '' }
    if (!probe.running && probe.quiet < 2) {
      probe.running = true
      const signature = () => {
        const d = document.documentElement
        const w2 = d ? d.scrollWidth : 0
        const h2 = d ? d.scrollHeight : 0
        return w2 + 'x' + h2 + 'x' + document.getElementsByTagName('*').length
      }
      const tick = () => {
        const s = signature()
        if (s === probe.last) probe.quiet += 1
        else probe.quiet = 0
        probe.last = s
        if (probe.quiet >= 2) { probe.running = false; return }
        w.requestAnimationFrame(tick)
      }
      w.requestAnimationFrame(tick)
    }
    return JSON.stringify({
      readyState: document.readyState,
      fontsReady: probe.fontsReady,
      quiet: probe.quiet,
    })
  })()`
}

/**
 * @typedef {object} SettleResult
 * @property {boolean} settled every signal arrived before the deadline
 * @property {number} elapsedMs
 * @property {string} readyState what the document last reported
 * @property {boolean} fontsReady
 * @property {number} quietFrames consecutive layout-stable frames observed
 */

/**
 * Wait for the page to stop moving, or for the timeout, whichever is first.
 *
 * Takes a bare evaluate function rather than a port so the logic is
 * unit-testable with a scripted fake: the tests can serve a page that never
 * settles without needing a browser to render one.
 *
 * Evaluation errors during polling are swallowed and retried, not raised.
 * A poll can land mid-navigation, when the old document is gone and the new
 * one has not committed, and that transient is indistinguishable from any
 * other "not settled yet" state, so it is treated as one.
 *
 * @param {(expression: string) => Promise<unknown>} evaluate
 * @param {{ timeoutMs?: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [opts]
 *   `now` and `sleep` exist for the unit tests, which must not spend wall
 *   clock time proving that a deadline works.
 * @returns {Promise<SettleResult>}
 */
export async function settle(evaluate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const pollMs = opts.pollMs ?? 60
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const started = now()
  const deadline = started + timeoutMs
  let readyState = ''
  let fontsReady = false
  let quiet = 0
  let first = true

  for (;;) {
    try {
      const raw = await evaluate(settleProbeExpression(first))
      first = false
      const parsed = /** @type {{ readyState?: unknown, fontsReady?: unknown, quiet?: unknown }} */ (
        JSON.parse(String(raw))
      )
      readyState = String(parsed.readyState ?? '')
      fontsReady = Boolean(parsed.fontsReady)
      quiet = Number(parsed.quiet ?? 0)
      if (readyState === 'complete' && fontsReady && quiet >= 2) {
        return { settled: true, elapsedMs: now() - started, readyState, fontsReady, quietFrames: quiet }
      }
    } catch {
      // Mid-navigation, a crashed frame, a probe the page's CSP rejected:
      // all of them read as "not settled yet", and the deadline still ends
      // the wait either way.
    }
    if (now() >= deadline) {
      return { settled: false, elapsedMs: now() - started, readyState, fontsReady, quietFrames: quiet }
    }
    await sleep(pollMs)
  }
}
