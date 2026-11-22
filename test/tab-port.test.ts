import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTabPort, parseKeyCombo } from '../src/browser/tabPort.js'

function makeFakeWebContents(initialUrl = 'https://example.com/') {
  const wc = new EventEmitter() as EventEmitter & {
    isDestroyed: () => boolean
    getURL: () => string
    getTitle: () => string
    loadURL: (u: string) => Promise<void>
    stop: () => void
    reload: () => void
    capturePage: () => Promise<{ toPNG: () => Buffer; getSize: () => { width: number; height: number } }>
    navigationHistory: {
      canGoBack: () => boolean
      goBack: () => void
      canGoForward: () => boolean
      goForward: () => void
    }
    debugger: EventEmitter & {
      isAttached: () => boolean
      attach: (version: string) => void
      detach: () => void
      sendCommand: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }

  let url = initialUrl
  let title = 'Start'
  let attached = false
  let canBack = true
  let canForward = false
  const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []

  const dbg = new EventEmitter() as typeof wc.debugger
  dbg.isAttached = () => attached
  dbg.attach = () => { attached = true }
  dbg.detach = () => { attached = false }
  dbg.sendCommand = async (method, params) => {
    cdpCalls.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expr = String(params?.expression ?? '')
      if (params?.returnByValue === false) {
        return { result: { type: 'object', subtype: 'node', objectId: 'obj-file-1' } }
      }
      if (expr.includes('document.readyState')) {
        return { result: { type: 'string', value: JSON.stringify({ readyState: 'complete', fontsReady: true, quiet: 2, sig: '1280x720x10' }) } }
      }
      return { result: { type: 'string', value: 'ok' } }
    }
    if (method === 'Page.getLayoutMetrics') {
      return {
        cssContentSize: { width: 1280, height: 2400 },
        cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
      }
    }
    if (method === 'Page.captureScreenshot') {
      return { data: Buffer.from('fake-png-bytes').toString('base64') }
    }
    return {}
  }

  wc.isDestroyed = () => false
  wc.getURL = () => url
  wc.getTitle = () => title
  wc.loadURL = async (u: string) => { url = u }
  wc.stop = () => {}
  wc.reload = () => {
    title = 'Reloaded'
    queueMicrotask(() => wc.emit('did-stop-loading'))
  }
  wc.capturePage = async () => ({
    toPNG: () => Buffer.from('fallback-png'),
    getSize: () => ({ width: 800, height: 600 }),
  })
  wc.navigationHistory = {
    canGoBack: () => canBack,
    goBack: () => {
      canBack = false
      canForward = true
      url = 'https://example.com/prev'
      title = 'Prev'
      queueMicrotask(() => wc.emit('did-stop-loading'))
    },
    canGoForward: () => canForward,
    goForward: () => {
      canBack = true
      canForward = false
      url = 'https://example.com/next'
      title = 'Next'
      queueMicrotask(() => wc.emit('did-stop-loading'))
    },
  }
  wc.debugger = dbg

  return { wc, cdpCalls }
}

describe('parseKeyCombo', () => {
  it('parses special keys and modifier chords into CDP bitmasks', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13, text: '\r' })
    expect(parseKeyCombo('Escape')).toMatchObject({ key: 'Escape', code: 'Escape', modifiers: 0, windowsVirtualKeyCode: 27 })
    expect(parseKeyCombo('Control+A')).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    expect(parseKeyCombo('Meta+Shift+K')).toMatchObject({ key: 'K', code: 'KeyK', modifiers: 12, windowsVirtualKeyCode: 75 })
    expect(parseKeyCombo('Alt+ArrowLeft')).toMatchObject({ key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 1, windowsVirtualKeyCode: 37 })
    expect(parseKeyCombo('Space')).toMatchObject({ key: ' ', code: 'Space', modifiers: 0, windowsVirtualKeyCode: 32, text: ' ' })
  })
})

describe('createTabPort browser-user primitives', () => {
  it('captures console-message, did-fail-load, and CDP runtime/network events in bounded ring buffers', async () => {
    const { wc } = makeFakeWebContents()
    const port = createTabPort(wc as never, { tabId: 1 })

    // Pre-attach Electron webContents events are captured immediately
    wc.emit('console-message', {}, 1, 'hello log', 10, 'app.js')
    wc.emit('console-message', {}, 2, 'careful warning', 11, 'app.js')
    wc.emit('console-message', {}, 3, 'boom error', 12, 'app.js')
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.example/')

    expect(port.getConsoleLogs({ level: 'error' }).entries).toHaveLength(1)
    expect(port.getConsoleLogs({ level: 'warning' }).entries[0]?.text).toBe('careful warning')
    expect(port.getNetworkLogs({ failedOnly: true }).entries[0]?.url).toBe('https://missing.example/')

    // Trigger CDP attach and emit CDP Runtime/Network events
    await port.evaluate('1')
    wc.debugger.emit('message', {}, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught ReferenceError', url: 'index.js', lineNumber: 42 },
    })
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://example.com/api/ok', method: 'GET' },
      type: 'Fetch',
    })
    wc.debugger.emit('message', {}, 'Network.responseReceived', {
      requestId: 'r1',
      response: { url: 'https://example.com/api/ok', status: 200, statusText: 'OK', mimeType: 'application/json' },
      type: 'Fetch',
    })
    wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'r2',
      request: { url: 'https://example.com/api/fail', method: 'POST' },
      type: 'Fetch',
    })
    wc.debugger.emit('message', {}, 'Network.loadingFailed', {
      requestId: 'r2',
      errorText: 'net::ERR_CONNECTION_REFUSED',
      type: 'Fetch',
    })

    const errors = port.getConsoleLogs({ level: 'error' })
    expect(errors.count).toBe(2)
    expect(errors.entries[1]?.text).toContain('Uncaught ReferenceError')

    const allNet = port.getNetworkLogs({})
    expect(allNet.count).toBe(3)
    const failedNet = port.getNetworkLogs({ failedOnly: true, clear: true })
    expect(failedNet.count).toBe(2)
    expect(port.getNetworkLogs({}).count).toBe(0)

    // Verify ring buffer cap at 100 entries
    for (let i = 0; i < 120; i++) {
      wc.emit('console-message', {}, 1, `msg-${i}`, i, 'loop.js')
    }
    const capped = port.getConsoleLogs({ limit: 100 })
    expect(capped.count).toBe(100)
    expect(capped.entries[0]?.text).toBe('msg-20')
    expect(capped.entries[99]?.text).toBe('msg-119')

    await port.close()
  })

  it('dispatches trusted CDP key presses, hover events, history navigation, and full-page screenshots', async () => {
    const { wc, cdpCalls } = makeFakeWebContents()
    const port = createTabPort(wc as never, { tabId: 2 })

    await port.pressKey('Enter')
    expect(cdpCalls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual([
      'rawKeyDown',
      'char',
      'keyUp',
    ])

    await port.hoverPoint(123.4, 456.6)
    expect(cdpCalls.find((c) => c.method === 'Input.dispatchMouseEvent')?.params).toMatchObject({
      type: 'mouseMoved',
      x: 123,
      y: 457,
    })

    const shot = await port.screenshot({ fullPage: true })
    expect(shot.mimeType).toBe('image/png')
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(2400)
    expect(Buffer.from(shot.data, 'base64').toString()).toBe('fake-png-bytes')

    const epochBefore = port.epoch
    const back = await port.history('back')
    expect(back).toMatchObject({ ok: true, direction: 'back', url: 'https://example.com/prev' })
    expect(port.epoch).toBeGreaterThan(epochBefore)

    const cantBack = await port.history('back')
    expect(cantBack.ok).toBe(false)

    const fwd = await port.history('forward')
    expect(fwd).toMatchObject({ ok: true, direction: 'forward', url: 'https://example.com/next' })

    const reloaded = await port.history('reload')
    expect(reloaded).toMatchObject({ ok: true, direction: 'reload', title: 'Reloaded' })

    await port.close()
  })

  it('dispatches clickPoint (left, right, double, middle), dragPoints, and setFileInputFiles via CDP', async () => {
    const { wc, cdpCalls } = makeFakeWebContents()
    const port = createTabPort(wc as never, { tabId: 3 })

    // Right-click
    await port.clickPoint(50.4, 80.6, { button: 'right', clickCount: 1 })
    const rightEvents = cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent')
    expect(rightEvents.map((e) => e.params)).toEqual([
      { type: 'mouseMoved', x: 50, y: 81, button: 'none', buttons: 0 },
      { type: 'mousePressed', x: 50, y: 81, button: 'right', buttons: 2, clickCount: 1 },
      { type: 'mouseReleased', x: 50, y: 81, button: 'right', buttons: 0, clickCount: 1 },
    ])

    // Double left click
    cdpCalls.length = 0
    await port.clickPoint(10, 20, { button: 'left', clickCount: 2 })
    expect(cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((e) => [e.params?.type, e.params?.clickCount])).toEqual([
      ['mouseMoved', undefined],
      ['mousePressed', 1],
      ['mouseReleased', 1],
      ['mousePressed', 2],
      ['mouseReleased', 2],
    ])

    // Drag in 4 interpolated steps
    cdpCalls.length = 0
    await port.dragPoints(0, 0, 100, 40, 4)
    const dragEvents = cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent')
    expect(dragEvents).toHaveLength(7) // move(start), down, 4 moves, up
    expect(dragEvents[0]?.params).toMatchObject({ type: 'mouseMoved', x: 0, y: 0 })
    expect(dragEvents[1]?.params).toMatchObject({ type: 'mousePressed', x: 0, y: 0, button: 'left', buttons: 1 })
    expect(dragEvents[3]?.params).toMatchObject({ type: 'mouseMoved', x: 50, y: 20, button: 'left', buttons: 1 })
    expect(dragEvents[6]?.params).toMatchObject({ type: 'mouseReleased', x: 100, y: 40, button: 'left', buttons: 0 })

    // setFileInputFiles via objectId + releaseObject
    cdpCalls.length = 0
    await port.setFileInputFiles('#upload', ['/tmp/sample.txt'])
    expect(cdpCalls.find((c) => c.method === 'DOM.setFileInputFiles')?.params).toEqual({
      objectId: 'obj-file-1',
      files: ['/tmp/sample.txt'],
    })
    expect(cdpCalls.find((c) => c.method === 'Runtime.releaseObject')?.params).toEqual({
      objectId: 'obj-file-1',
    })

    await port.close()
  })

  it('auto-handles JS dialogs to prevent deadlocks and respects armed accept/promptText', async () => {
    const { wc, cdpCalls } = makeFakeWebContents()
    const port = createTabPort(wc as never, { tabId: 4 })

    // Trigger attach and confirm Page.enable is called
    await port.evaluate('1')
    expect(cdpCalls.some((c) => c.method === 'Page.enable')).toBe(true)

    // Unarmed alert -> auto-accept
    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Saved!',
      defaultPrompt: '',
      url: 'https://example.com/',
    })
    // Unarmed confirm -> auto-dismiss
    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Delete item?',
      defaultPrompt: '',
      url: 'https://example.com/',
    })

    const dialogCalls = cdpCalls.filter((c) => c.method === 'Page.handleJavaScriptDialog')
    expect(dialogCalls.map((c) => c.params)).toEqual([
      { accept: true },
      { accept: false },
    ])

    // Arm accept with promptText
    const armedRes = await port.handleDialog({ action: 'accept', promptText: 'TroyUser' })
    expect(armedRes).toMatchObject({ ok: true, armed: { accept: true, promptText: 'TroyUser' } })

    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Your name?',
      defaultPrompt: 'Anon',
      url: 'https://example.com/',
    })

    const status = await port.handleDialog({ action: 'status' })
    expect(status.ok).toBe(true)
    expect(status.armed).toBeNull()
    expect(status.history).toHaveLength(3)
    expect(status.history?.[0]).toMatchObject({ type: 'alert', handled: 'auto-accept' })
    expect(status.history?.[1]).toMatchObject({ type: 'confirm', handled: 'auto-dismiss' })
    expect(status.history?.[2]).toMatchObject({ type: 'prompt', handled: 'armed-accept', promptText: 'TroyUser' })

    const lastHandle = cdpCalls.filter((c) => c.method === 'Page.handleJavaScriptDialog').at(-1)
    expect(lastHandle?.params).toEqual({ accept: true, promptText: 'TroyUser' })

    await port.close()
  })
})
