export type Box = { x: number; y: number; w: number; h: number }

export interface Cdp {
  /**
   * Sends a raw CDP command and resolves with its result.
   *
   * Special case: when `method` is "Page.navigate", the returned promise
   * also waits for the navigation to settle, either a new document
   * ("Page.loadEventFired") or a same-document navigation
   * ("Page.navigatedWithinDocument"), before resolving, so callers never
   * race a document that has not appeared yet. If neither fires within the
   * timeout (default 30000ms; override by passing a `timeoutMs` field on
   * `params`) the promise resolves anyway rather than rejecting: a page
   * that never finishes loading is still readable, which is the point of
   * Troy. The resolved value does not say which case happened; a caller
   * that needs certainty should check page state itself afterward, for
   * example with evaluate("document.readyState").
   */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, handler: (params: unknown) => void): () => void
  screenshot(clip?: Box): Promise<Buffer>
  evaluate<T>(fn: string): Promise<T>
  url(): Promise<string>
  close(): Promise<void>
}
