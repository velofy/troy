/**
 * The surface `preload.cjs` puts on `window.troy`, written down once.
 *
 * The chrome page, the battle tests and the preload itself all have to agree
 * on this shape, and nothing else in the app is allowed to reach across the
 * process boundary, so it is worth stating rather than inferring.
 */

export type TabView = {
  id: number
  title: string
  /** What the omnibox should show: empty on the new tab page, and the
      address that failed rather than Troy's error page. */
  url: string
  favicon: string | null
  failed: boolean
  loading: boolean
  active: boolean
}

export type ChromeState = {
  tabs: TabView[]
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  panelOpen: boolean
}

export type NavResult = {
  kind: 'url' | 'search' | 'external' | 'refused' | 'empty'
  reason?: string
}

export type ReadResult =
  | { url: string; text: string; degraded: boolean }
  | { error: string }

export interface TroyBridge {
  newTab(url?: string): Promise<void>
  selectTab(id: number): Promise<void>
  closeTab(id: number): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  go(input: string): Promise<NavResult>
  togglePanel(): Promise<boolean>
  read(): Promise<ReadResult>
  onTabs(handler: (state: ChromeState) => void): () => void
  onNotice(handler: (reason: string) => void): () => void
  onFocusOmnibox(handler: () => void): () => void
}
