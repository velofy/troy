import { describe, it, expect, afterAll } from 'vitest'
import { launchHeadless } from '../src/cdp/playwright.js'
import { resolveOmnibox } from '../src/browser/omnibox.js'
import { createTools } from '../src/agent/tools.js'
import { READ_PAGE_EXPRESSION, normaliseReadResult } from '../src/agent/read.js'

/**
 * The same tools, against a real DOM. The unit tests in agent-tools.test.ts
 * script the host; these run the actual expressions in a throwaway headless
 * Chromium through the Cdp port, because "did the click verify" and "does
 * maxlength hold" are claims about a real page, not about our own fakes.
 *
 * The browser here is launched and owned by the test. Nothing in the tool
 * layer ever calls browser.close(); teardown belongs to whoever launched it.
 */

const cdp = await launchHeadless()
afterAll(() => cdp.close())

const loads: string[] = []
const host = {
  read: async () =>
    normaliseReadResult(await cdp.evaluate<string>(READ_PAGE_EXPRESSION), {
      url: await cdp.url(),
      title: '',
    }),
  evaluate: (expression: string) => cdp.evaluate<unknown>(expression),
  resolve: (input: string) => resolveOmnibox(input),
  load: async (url: string) => {
    loads.push(url)
    await cdp.send('Page.navigate', { url, timeoutMs: 5000 })
    return { url: await cdp.url() }
  },
  exec: async () => ({ missing: 'not installed in this test' }),
  settle: () => new Promise<void>((resolve) => setTimeout(resolve, 80)),
}
const tools = createTools(host)

async function open(html: string): Promise<void> {
  await cdp.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) })
}

describe('page_read on a real page', () => {
  it('reports facts and selectors that each match exactly one element', async () => {
    await open(`<!doctype html><title>read fixture</title>
      <h1>Heading</h1>
      <a href="/x">a link</a>
      <button id="go-on">Go on</button>
      <input id="city" name="city" value="Pune">
      <input type="password" id="pw" value="hunter2">`)
    const result = await tools.run('page_read', {})
    expect(result.error).toBeUndefined()
    expect(result.headingCount).toBe(1)
    expect(result.linkCount).toBe(1)
    const interactive = result.interactive as Array<{ selector: string; type: string; value: string }>
    expect(interactive.length).toBeGreaterThanOrEqual(3)
    for (const el of interactive) {
      const matches = await cdp.evaluate<number>(
        `document.querySelectorAll(${JSON.stringify(el.selector)}).length`,
      )
      expect(matches, `selector ${el.selector} must be unique`).toBe(1)
    }
    // A password field may be listed, but its value must never leave the page.
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })
})

describe('page_click on a real page', () => {
  it('reports NOT VERIFIED when the click lands but nothing observable changes', async () => {
    await open(`<!doctype html><title>quiet</title>
      <button id="dead">does nothing</button><p>static text</p>`)
    const result = await tools.run('page_click', { selector: '#dead' })
    expect(result.ok).toBe(false)
    expect(String(result.note)).toMatch(/NOT VERIFIED/)
  })

  it('verifies a click that reveals a field, using a selector page_read produced', async () => {
    await open(`<!doctype html><title>reveal</title>
      <button id="more" onclick="document.getElementById('extra').style.display='block'">More</button>
      <input id="extra" style="display:none">`)
    const read = await tools.run('page_read', {})
    const interactive = read.interactive as Array<{ selector: string; tag: string }>
    const button = interactive.find((el) => el.tag === 'button')
    expect(button).toBeTruthy()
    const result = await tools.run('page_click', { selector: button?.selector ?? '' })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
  })

  it('refuses an ambiguous selector against a real DOM', async () => {
    await open(`<!doctype html><title>twins</title>
      <button class="b">one</button><button class="b">two</button>`)
    const result = await tools.run('page_click', { selector: '.b' })
    expect(String(result.error)).toMatch(/2 elements|refusing/i)
  })

  it('refuses the button that would submit a form, even with harmless text', async () => {
    await open(`<!doctype html><title>form</title>
      <form action="/nowhere"><input name="q"><button id="go">Continue</button></form>`)
    const result = await tools.run('page_click', { selector: '#go' })
    expect(String(result.error)).toMatch(/submit/i)
  })
})

describe('page_fill on a real page', () => {
  it('refuses text past maxlength and leaves the field untouched, then fills a fitting value', async () => {
    await open(`<!doctype html><title>fill</title><input id="zip" maxlength="5" value="">`)

    const refused = await tools.run('page_fill', { selector: '#zip', text: '1234567' })
    expect(String(refused.error)).toMatch(/5/)
    expect(await cdp.evaluate<string>(`document.getElementById('zip').value`)).toBe('')

    const filled = await tools.run('page_fill', { selector: '#zip', text: '41101' })
    expect(filled.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('zip').value`)).toBe('41101')
  })

  it('dispatches real input events, so a framework-style listener sees the value', async () => {
    await open(`<!doctype html><title>events</title>
      <input id="name"><p id="echo"></p>
      <script>document.getElementById('name').addEventListener('input', (e) => {
        document.getElementById('echo').textContent = e.target.value
      })</script>`)
    const result = await tools.run('page_fill', { selector: '#name', text: 'Troy' })
    expect(result.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('echo').textContent`)).toBe('Troy')
  })

  it('refuses a real password input', async () => {
    await open(`<!doctype html><title>pw</title><input type="password" id="pw">`)
    const result = await tools.run('page_fill', { selector: '#pw', text: 'hunter2' })
    expect(String(result.error)).toMatch(/password/i)
  })

  it('fills a contenteditable region and reads it back', async () => {
    await open(`<!doctype html><title>editable</title><div id="ed" contenteditable>old words</div>`)
    const result = await tools.run('page_fill', { selector: '#ed', text: 'new words' })
    expect(result.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('ed').innerText.trim()`)).toBe('new words')
  })
})

describe('page_navigate on a real page', () => {
  it('refuses javascript: and the page does not move', async () => {
    await open(`<!doctype html><title>stay</title><h1>here</h1>`)
    const before = await cdp.url()
    const result = await tools.run('page_navigate', { url: 'javascript:document.title="owned"' })
    expect(String(result.error)).toMatch(/javascript/i)
    expect(await cdp.url()).toBe(before)
    expect(await cdp.evaluate<string>('document.title')).toBe('stay')
  })
})
