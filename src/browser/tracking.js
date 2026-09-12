// Blocking the things that follow you around.
//
// Two separate jobs, deliberately kept apart because they fail differently.
//
// Stripping parameters is safe: `utm_source` carries no meaning the site
// needs, so removing it before navigating loses nothing and stops the click
// being attributed to you. It happens once, before the request is made.
//
// Blocking requests is not safe by default, because a list that is too eager
// breaks pages, and a broken page is worse than a tracked one: people turn
// the whole feature off. So the list here is third-party analytics and ad
// beacons only, matched on the exact host or a subdomain of it, and never
// applied to a request the page made to its own origin.
//
// An honest limit, stated here because it should also be stated in the UI:
// this does nothing about first-party tracking. If you search on Google,
// Google sees the search. Blocking `google-analytics.com` on other people's
// sites is a different thing from not using Google.

/**
 * Query parameters that exist only to identify who clicked. Removing them
 * cannot change which page you land on.
 */
export const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_social',
  'utm_brand',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  'igshid',
  'twclid',
  'ttclid',
  'yclid',
  'li_fat_id',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'ref_src',
  'ref_url',
  'spm',
  'scm',
])

/**
 * Hosts whose entire purpose is measurement or ad delivery. Matched on the
 * host itself or any subdomain, never as a substring, so "notdoubleclick.net"
 * and "mygoogle-analytics.com.example.org" do not match.
 */
export const TRACKER_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googletagservices.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'adservice.google.com',
  'connect.facebook.net',
  'graph.facebook.com',
  'analytics.tiktok.com',
  'ads.linkedin.com',
  'px.ads.linkedin.com',
  'analytics.twitter.com',
  'ads-twitter.com',
  'static.ads-twitter.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'mixpanel.com',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'bat.bing.com',
  'clarity.ms',
  'matomo.cloud',
  'chartbeat.com',
  'newrelic.com',
  'nr-data.net',
  'optimizely.com',
  'crazyegg.com',
  'yandex.ru',
  'mc.yandex.ru',
]

/**
 * Remove the parameters that only identify the click, keeping everything the
 * page actually needs. A search URL keeps its `q`.
 *
 * @param {string} url
 * @returns {string} the url without tracking parameters, or the input
 *   unchanged when it is not a URL we can parse
 */
export function stripTrackingParams(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url

  let removed = false
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key)
      removed = true
    }
  }
  if (!removed) return url

  // Drop the "?" entirely when nothing is left, rather than leaving a bare
  // question mark on the end of every cleaned link.
  if ([...parsed.searchParams.keys()].length === 0) parsed.search = ''
  return parsed.toString()
}

/**
 * Is this host a tracker, or a subdomain of one.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isTrackerHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  if (!host) return false
  return TRACKER_HOSTS.some((tracker) => host === tracker || host.endsWith(`.${tracker}`))
}

/**
 * The registrable-ish suffix used to decide "same site". Not a full public
 * suffix list, which would be a dependency and a data file to keep current;
 * the last two labels are enough to avoid blocking a site's own analytics
 * subdomain, which is the only case this needs to get right.
 *
 * @param {string} hostname
 * @returns {string}
 */
function siteOf(hostname) {
  const parts = String(hostname ?? '').toLowerCase().split('.').filter(Boolean)
  return parts.slice(-2).join('.')
}

/**
 * Should this request be cancelled.
 *
 * Only third-party requests are considered. A site loading something from
 * its own domain is the site working, whatever the subdomain is called.
 *
 * @param {string} url the request
 * @param {string} [initiator] the page that made it
 * @returns {boolean}
 */
export function shouldBlockRequest(url, initiator) {
  let target
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  if (!isTrackerHost(target.hostname)) return false

  if (initiator) {
    try {
      const from = new URL(initiator)
      if (siteOf(from.hostname) === siteOf(target.hostname)) return false
    } catch {
      // An unparseable initiator is treated as third party, which is the
      // safer of the two readings.
    }
  }
  return true
}

/**
 * @typedef {object} RequestDetails
 * @property {string} url
 * @property {string} [initiator]
 * @property {string} [resourceType]
 */

/**
 * @typedef {(details: RequestDetails, callback: (response: { cancel: boolean }) => void) => void} BeforeRequest
 */

/**
 * Cancel tracker requests in a session.
 *
 * @param {{ webRequest: { onBeforeRequest(filter: object, listener: BeforeRequest): void } }} session
 * @param {{ onBlocked?: (url: string) => void, enabled?: () => boolean }} [options]
 */
export function installBlocker(session, { onBlocked, enabled } = {}) {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (enabled && !enabled()) {
        callback({ cancel: false })
        return
      }
      // A top-level navigation is never cancelled. If you typed it, or
      // clicked it, you get to go there; blocking that would look like the
      // browser being broken rather than the browser protecting you.
      if (details.resourceType === 'mainFrame') {
        callback({ cancel: false })
        return
      }
      const blocked = shouldBlockRequest(details.url, details.initiator)
      if (blocked) onBlocked?.(details.url)
      callback({ cancel: blocked })
    },
  )
}
