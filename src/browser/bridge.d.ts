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
  | {
      url: string
      title: string
      /** Every fused block, dom and ocr together. */
      blockCount: number
      domBlockCount: number
      ocrBlockCount: number
      /** Page regions the DOM could not explain; each was OCR'd or left untranscribed. */
      regionCount: number
      characterCount: number
      elapsedMs: number
      settled: boolean
      ocrEngine: string
      markdown: string
      degraded: boolean
    }
  | { error: string }

export type AgentState = {
  provider: string
  model: string
  defaults: Record<string, string>
  keys: { encryptionAvailable: boolean; providers: Record<string, boolean> }
  session: {
    tabId: number
    running: boolean
    runId: string | null
    origins: string[]
    pendingBoundary: string | null
    messages: Array<{ role: string; text: string }>
  }
}

export type AgentEvent = {
  type: string
  runId?: string
  tabId?: number
  sequence?: number
  [key: string]: unknown
}

export interface TroyBridge {
  newTab(url?: string): Promise<NavResult>
  selectTab(id: number): Promise<void>
  closeTab(id: number): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  go(input: string): Promise<NavResult>
  togglePanel(): Promise<boolean>
  read(): Promise<ReadResult>
  agentState(): Promise<AgentState>
  setAgentSettings(settings: { provider?: string; model?: string }): Promise<AgentState | { error: string }>
  setAgentKey(provider: string, key: string): Promise<unknown>
  clearAgentKey(provider: string): Promise<unknown>
  submitAgent(text: string): Promise<{ ok?: boolean; runId?: string; error?: string }>
  stopAgent(): Promise<{ stopped: boolean }>
  clearAgent(): Promise<{ ok?: boolean; error?: string }>
  grantAgentOrigin(origin: string): Promise<{ ok?: boolean; error?: string }>
  voiceState(): Promise<{ available: boolean; engine: string; offline: boolean; reason: string }>
  beginVoiceCapture(): Promise<{ ok?: boolean; error?: string; expiresAt?: number }>
  endVoiceCapture(): Promise<{ ok?: boolean }>
  transcribeVoice(wav: ArrayBuffer): Promise<{ ok?: boolean; text?: string; error?: string; cancelled?: boolean }>
  onVoicePress(handler: () => void): () => void
  onVoiceRelease(handler: () => void): () => void
  onVoiceCancel(handler: () => void): () => void
  onAgentEvent(handler: (event: AgentEvent) => void): () => void
  onTabs(handler: (state: ChromeState) => void): () => void
  onNotice(handler: (reason: string) => void): () => void
  onFocusOmnibox(handler: () => void): () => void
  onReadRequested(handler: () => void): () => void
}
