import { chromium } from 'playwright'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import type { Box, Cdp } from './types.js'

type RawSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type RawOn = (event: string, handler: (params: unknown) => void) => void

/**
 * Builds the Cdp port around a live CDPSession. Kept private: only the
 * launch/connect functions below are exported, and they return Cdp only, so
 * Playwright's Page/Browser/BrowserContext types never leak out.
 */
async function buildCdp(page: Page, session: CDPSession, onClose: () => Promise<void>): Promise<Cdp> {
  const rawSend = session.send.bind(session) as unknown as RawSend
  const rawOn = session.on.bind(session) as unknown as RawOn
  const rawOff = session.off.bind(session) as unknown as RawOn

  // The Page domain must be enabled to observe loadEventFired below, which
  // send() needs to make Page.navigate wait for the new document instead of
  // racing it (the raw command resolves once navigation starts, not once it
  // finishes).
  await rawSend('Page.enable')

  return {
    async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === 'Page.navigate') {
        const loaded = new Promise<void>((resolve) => {
          const handler = (): void => {
            rawOff('Page.loadEventFired', handler)
            resolve()
          }
          rawOn('Page.loadEventFired', handler)
        })
        const result = await rawSend(method, params)
        await loaded
        return result as T
      }
      return (await rawSend(method, params)) as T
    },

    on(event: string, handler: (params: unknown) => void): () => void {
      rawOn(event, handler)
      return () => rawOff(event, handler)
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
        throw new Error(exceptionDetails.text)
      }
      return result.value as T
    },

    async url(): Promise<string> {
      return page.url()
    },

    async close(): Promise<void> {
      await onClose()
    },
  }
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
