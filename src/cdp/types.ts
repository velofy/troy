export type Box = { x: number; y: number; w: number; h: number }

export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, handler: (params: unknown) => void): () => void
  screenshot(clip?: Box): Promise<Buffer>
  evaluate<T>(fn: string): Promise<T>
  url(): Promise<string>
  close(): Promise<void>
}
