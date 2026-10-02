import http from 'node:http'
import { _electron as electron } from 'playwright'
import path from 'node:path'

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>mic test</title><h1>hi</h1>')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const app = await electron.launch({
  args: [path.join(process.cwd(), 'src/browser/main.js'), '--user-data-dir=/tmp/troy-micdbg', '--hidden'],
  env: { ...process.env, TROY_TEST: '1' },
})
const chrome = await app.firstWindow()
await chrome.waitForSelector('.tab', { timeout: 20000 })
await chrome.fill('#omni', `http://127.0.0.1:${port}/x.html`)
await chrome.press('#omni', 'Enter')
await new Promise(r => setTimeout(r, 1500))

const hooks = await app.evaluate(({ session }) => {
  const s = session.defaultSession
  const log = []
  s.setPermissionCheckHandler((wc, perm, origin, details) => { log.push(['check', perm, JSON.stringify(details && details.mediaTypes ? details.mediaTypes : details.mediaType)]); return false })
  s.setPermissionRequestHandler((wc, perm, cb, details) => { log.push(['request', perm]); cb(false) })
  if (s.setDevicePermissionHandler) s.setDevicePermissionHandler((d) => { log.push(['device', d.deviceType || JSON.stringify(d)]); return false })
  globalThis.__permLog = log
  return 'hooked'
})
console.log('hooks:', hooks)

const outcome = await Promise.race([
  app.evaluate(({ webContents }, target) => {
    const page = webContents.getAllWebContents().find((w) => w.getURL() === target)
    return page.executeJavaScript(
      `navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({audio:true}).then(() => 'granted', (e) => 'denied:' + e.name + ':' + e.message) : 'no-mediaDevices'`,
      true,
    )
  }, `http://127.0.0.1:${port}/x.html`).then(v => ({ done: v })).catch(e => ({ err: String(e) })),
  new Promise(r => setTimeout(() => r({ timeout: true }), 8000)),
])
console.log('outcome:', JSON.stringify(outcome))
const log = await app.evaluate(() => globalThis.__permLog || [])
console.log('perm log:', JSON.stringify(log))
await app.close()
server.close()
process.exit(0)
