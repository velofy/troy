import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

/**
 * Serves `test/fixtures/` over plain HTTP on an ephemeral port, so fixture
 * pages load like any other web page (real navigation, real network
 * requests) rather than via `data:` URLs or `file:` paths, either of which
 * behaves differently from a real page in ways the read pipeline cares
 * about (canvas tainting, relative URLs, cross-origin checks).
 *
 * Tracks every socket it accepts so `close()` can force them shut, the same
 * teardown discipline as the inline fixture server in `test/cdp.test.ts`. A
 * server that leaks a socket handle keeps vitest's process alive and hangs
 * the whole suite, and this one is imported by every later test file.
 */
export function serveFixtures(): Promise<{ url: string; close: () => Promise<void> }> {
  const openSockets = new Set<Socket>()

  const server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const socket of openSockets) socket.destroy()
            server.close(() => resolveClose())
          }),
      })
    })
  })
}

/** How long `/slow-fail` waits before dropping the connection. */
export const SLOW_FAIL_MS = 400

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestUrl = req.url ?? '/'
  const pathname = decodeURIComponent(requestUrl.split('?')[0] ?? '/')

  // Accepts the connection, then drops it without a response. A refused
  // connection fails too fast to race against anything; this one fails late
  // enough that a second navigation can be issued in between, which is the
  // ordering that used to let a stale error page overwrite a good page.
  if (pathname === '/slow-fail') {
    setTimeout(() => res.socket?.destroy(), SLOW_FAIL_MS)
    return
  }
  const relative = pathname === '/' ? '/article.html' : pathname
  const filePath = path.join(FIXTURES_DIR, relative)

  if (filePath !== FIXTURES_DIR && !filePath.startsWith(FIXTURES_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('forbidden')
    return
  }

  try {
    const body = await readFile(filePath)
    const contentType = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }
}
