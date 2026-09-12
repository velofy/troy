import { describe, it, expect } from 'vitest'
import {
  stripTrackingParams,
  isTrackerHost,
  shouldBlockRequest,
  installBlocker,
} from '../src/browser/tracking.js'

describe('stripTrackingParams', () => {
  it('removes the parameters that only identify the click', () => {
    expect(stripTrackingParams('https://example.com/post?utm_source=x&utm_medium=email')).toBe(
      'https://example.com/post',
    )
    expect(stripTrackingParams('https://shop.example.com/item?gclid=abc123')).toBe(
      'https://shop.example.com/item',
    )
    expect(stripTrackingParams('https://example.com/a?fbclid=zz')).toBe('https://example.com/a')
  })

  it('keeps every parameter the page actually needs', () => {
    expect(stripTrackingParams('https://example.com/search?q=troy&utm_source=news')).toBe(
      'https://example.com/search?q=troy',
    )
    expect(stripTrackingParams('https://example.com/item?id=42&page=2')).toBe(
      'https://example.com/item?id=42&page=2',
    )
  })

  // A search that lost its query would look like the browser being broken.
  it('never touches a google search query', () => {
    const url = 'https://www.google.com/search?q=how+tall+is+everest'
    expect(stripTrackingParams(url)).toBe(url)
  })

  it('drops the question mark entirely when nothing is left', () => {
    expect(stripTrackingParams('https://example.com/post?utm_source=x')).toBe(
      'https://example.com/post',
    )
  })

  it('leaves the fragment and path alone', () => {
    expect(stripTrackingParams('https://example.com/docs/a?utm_id=9#section-3')).toBe(
      'https://example.com/docs/a#section-3',
    )
  })

  it('returns anything it cannot parse unchanged, rather than throwing', () => {
    expect(stripTrackingParams('not a url at all')).toBe('not a url at all')
    expect(stripTrackingParams('')).toBe('')
    expect(stripTrackingParams('about:blank')).toBe('about:blank')
  })

  it('matches parameter names case insensitively', () => {
    expect(stripTrackingParams('https://example.com/a?UTM_Source=x')).toBe('https://example.com/a')
  })
})

describe('isTrackerHost', () => {
  it('recognises a tracker and its subdomains', () => {
    expect(isTrackerHost('google-analytics.com')).toBe(true)
    expect(isTrackerHost('www.google-analytics.com')).toBe(true)
    expect(isTrackerHost('stats.g.doubleclick.net')).toBe(true)
  })

  it('does not match a host that merely contains the name', () => {
    expect(isTrackerHost('notdoubleclick.net')).toBe(false)
    expect(isTrackerHost('google-analytics.com.evil.example')).toBe(false)
    expect(isTrackerHost('mygoogletagmanager.com')).toBe(false)
  })

  it('leaves ordinary hosts alone', () => {
    expect(isTrackerHost('example.com')).toBe(false)
    expect(isTrackerHost('www.google.com')).toBe(false)
    expect(isTrackerHost('')).toBe(false)
  })
})

describe('shouldBlockRequest', () => {
  it('blocks a third-party tracker beacon', () => {
    expect(shouldBlockRequest('https://www.google-analytics.com/collect', 'https://news.example')).toBe(true)
  })

  // A page loading from its own site is the page working.
  it('does not block a request a site makes to itself', () => {
    expect(shouldBlockRequest('https://analytics.example.com/x', 'https://www.example.com')).toBe(false)
  })

  it('leaves ordinary requests alone', () => {
    expect(shouldBlockRequest('https://cdn.example.com/app.js', 'https://example.com')).toBe(false)
  })

  it('ignores schemes that are not http', () => {
    expect(shouldBlockRequest('data:text/plain,hello', 'https://example.com')).toBe(false)
    expect(shouldBlockRequest('nonsense', 'https://example.com')).toBe(false)
  })

  it('treats an unknown initiator as third party, the safer reading', () => {
    expect(shouldBlockRequest('https://www.google-analytics.com/collect', undefined)).toBe(true)
  })
})

describe('installBlocker', () => {
  type Details = { url: string; initiator?: string; resourceType?: string }
  type Listener = (details: Details, callback: (response: { cancel: boolean }) => void) => void

  /** A session that captures the listener and lets a test drive it. */
  function fakeSession() {
    let listener: Listener | null = null
    return {
      webRequest: {
        onBeforeRequest: (_filter: object, fn: Listener) => {
          listener = fn
        },
      },
      request: (details: Details) =>
        new Promise<boolean>((resolve) => {
          listener?.(details, (r) => resolve(r.cancel))
        }),
    }
  }

  it('cancels a tracker subresource', async () => {
    const session = fakeSession()
    installBlocker(session)
    expect(
      await session.request({
        url: 'https://www.google-analytics.com/collect',
        initiator: 'https://news.example',
        resourceType: 'xhr',
      }),
    ).toBe(true)
  })

  // Blocking what you asked for would read as the browser being broken.
  it('never cancels a top-level navigation, even to a tracker domain', async () => {
    const session = fakeSession()
    installBlocker(session)
    expect(
      await session.request({
        url: 'https://www.google-analytics.com/',
        initiator: undefined,
        resourceType: 'mainFrame',
      }),
    ).toBe(false)
  })

  it('reports what it blocked, so the count is not invented', async () => {
    const seen: string[] = []
    const session = fakeSession()
    installBlocker(session, { onBlocked: (url) => seen.push(url) })
    await session.request({
      url: 'https://connect.facebook.net/en_US/fbevents.js',
      initiator: 'https://shop.example',
      resourceType: 'script',
    })
    expect(seen).toEqual(['https://connect.facebook.net/en_US/fbevents.js'])
  })

  it('does nothing at all when blocking is turned off', async () => {
    const session = fakeSession()
    installBlocker(session, { enabled: () => false })
    expect(
      await session.request({
        url: 'https://www.google-analytics.com/collect',
        initiator: 'https://news.example',
        resourceType: 'xhr',
      }),
    ).toBe(false)
  })
})
