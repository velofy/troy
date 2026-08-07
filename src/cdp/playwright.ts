import { chromium } from 'playwright'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { Box, Cdp } from './types.js'

type RawSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type RawOn = (event: string, handler: (params: unknown) => void) => void

const DEFAULT_NAVIGATE_TIMEOUT_MS = 30000

// A same-document navigation (hash change, history.pushState) never fires
// loadEventFired, so send() has to treat either as "settled".
const NAVIGATE_SETTLE_EVENTS = ['Page.loadEventFired', 'Page.navigatedWithinDocument']

/**
 * Test-only diagnostic, not part of the Cdp port. Reports how many raw CDP
 * listeners send()'s own Page.navigate wait machinery currently has
 * registered for `event` on the session backing `cdp`, so a regression test
 * can assert repeated failed navigations do not leak them. This is Troy's
 * own bookkeeping, not a Playwright internal, and this function's exported
 * signature is Cdp/string/number only, so Playwright types still never leak
 * through the port.
 */
const listenerCounters = new WeakMap<Cdp, Map<string, number>>()

export function listenerCountForTests(cdp: Cdp, event: string): number {
  return listenerCounters.get(cdp)?.get(event) ?? 0
}

/**
 * Builds the Cdp port around a live CDPSession. Kept private: only the
 * launch/connect functions below are exported, and they return Cdp only, so
 * Playwright's Page/Browser/BrowserContext types never leak out.
 */
async function buildCdp(page: Page, session: CDPSession, onClose: () => Promise<void>): Promise<Cdp> {
  const rawSend = session.send.bind(session) as unknown as RawSend
  const rawOn = session.on.bind(session) as unknown as RawOn
  const rawOff = session.off.bind(session) as unknown as RawOn

  const counts = new Map<string, number>()
  const countedOn: RawOn = (event, handler) => {
    counts.set(event, (counts.get(event) ?? 0) + 1)
    rawOn(event, handler)
  }
  const countedOff: RawOn = (event, handler) => {
    const next = (counts.get(event) ?? 0) - 1
    if (next > 0) counts.set(event, next)
    else counts.delete(event)
    rawOff(event, handler)
  }

  // The Page domain must be enabled to observe the events below, which
  // send() needs to make Page.navigate wait for the navigation to settle
  // instead of racing it (the raw command resolves once navigation starts,
  // not once it finishes).
  await rawSend('Page.enable')

  // Registers listeners for every "navigation settled" event plus a timeout,
  // and resolves (never rejects) on whichever comes first. cancel() always
  // tears every listener and the timer down, so it is safe, and necessary,
  // to call from a finally block regardless of which path settled first or
  // whether the navigate command itself rejected before anything settled.
  function waitForNavigation(timeoutMs: number): { settled: Promise<void>; cancel: () => void } {
    let resolveSettled: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const registrations = NAVIGATE_SETTLE_EVENTS.map((event) => ({ event, handler: () => finish() }))

    function finish(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      for (const { event, handler } of registrations) countedOff(event, handler)
      resolveSettled()
    }

    timer = setTimeout(finish, timeoutMs)
    for (const { event, handler } of registrations) countedOn(event, handler)
    return { settled, cancel: finish }
  }

  const cdp: Cdp = {
    async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === 'Page.navigate') {
        const { timeoutMs, ...navigateParams } = params ?? {}
        const timeout = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_NAVIGATE_TIMEOUT_MS
        const wait = waitForNavigation(timeout)
        try {
          const result = await rawSend(method, navigateParams)
          await wait.settled
          return result as T
        } finally {
          // Runs on every exit path, including the navigate command itself
          // rejecting (bad URL, CDP error), so a failed navigation never
          // leaves a dangling listener behind.
          wait.cancel()
        }
      }
      return (await rawSend(method, params)) as T
    },

    on(event: string, handler: (params: unknown) => void): () => void {
      countedOn(event, handler)
      return () => countedOff(event, handler)
    },

    async screenshot(clip?: Box): Promise<Buffer> {
      const { data } = await session.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } } : {}),
      })
      return Buffer.from(data, 'base64')
    },

    async evaluate<T>(fn: string): Promise<T> {
      const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
        expression: fn,
        returnByValue: true,
      })
      if (exceptionDetails) {
        // exceptionDetails.text is frequently just the literal string
        // "Uncaught" with no type, message, or stack. The real information
        // is on the thrown object itself, when CDP reports one.
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      }
      return result.value as T
    },

    async url(): Promise<string> {
      // Reads Playwright's cached URL for this page rather than querying
      // the CDP session directly. Fine while Playwright is the only
      // backend; worth revisiting once Electron's webContents.debugger is
      // the other implementation of this port.
      return page.url()
    },

    async close(): Promise<void> {
      await onClose()
    },
  }

  listenerCounters.set(cdp, counts)
  return cdp
}

async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage())
}

/** Launches a fresh, throwaway headless Chromium instance Troy fully owns. */
export async function launchHeadless(): Promise<Cdp> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await context.newCDPSession(page)
  return buildCdp(page, session, () => browser.close())
}

/**
 * Attaches to a browser that is already running (for example Helium started
 * with --remote-debugging-port). close() only detaches this CDP session; it
 * never calls browser.close(), because that browser is not ours to tear
 * down, it may be holding a real, logged-in session the user cares about.
 */
export async function connectOverWs(wsUrl: string): Promise<Cdp> {
  const browser = await chromium.connectOverCDP(wsUrl)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await firstPage(context)
  const session = await context.newCDPSession(page)
  return buildCdp(page, session, async () => {
    // Detaches Troy's own CDP session only. The underlying WebSocket
    // connection Playwright opened for `browser` is intentionally left
    // open (closing it is what risks touching the real browser, see
    // above), so a long-lived process that calls connectOverWs()/close()
    // repeatedly does accumulate connection handles. Left for Task 12 to
    // revisit once the real reconnect pattern is known.
    await session.detach().catch(() => undefined)
  })
}

/**
 * Launches Chromium against a persistent profile directory Troy owns
 * outright, so close() tears the whole browser down.
 */
export async function launchPersistent(profileDir: string): Promise<Cdp> {
  const context = await chromium.launchPersistentContext(profileDir, { headless: false })
  const page = await firstPage(context)
  const session = await context.newCDPSession(page)
  return buildCdp(page, session, () => context.close())
}
