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
      <input type="password" id="pw" value="hunter2">
      <label for="api">API key</label><input id="api" value="sk-live-should-not-leave">
      <input name="code" placeholder="One-time code" value="123456">`)
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
    // Sensitive fields may be listed, but their values must never leave the page.
    expect(JSON.stringify(result)).not.toContain('hunter2')
    expect(JSON.stringify(result)).not.toContain('sk-live-should-not-leave')
    expect(JSON.stringify(result)).not.toContain('123456')
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

describe('ARIA, open Shadow DOM, SPA inputs, and real-DOM browser-user tools', () => {
  it('discovers ARIA roles and open Shadow DOM elements and acts across shadow boundaries', async () => {
    await open(`<!doctype html><title>shadow</title>
      <div id="aria-tab" role="tab" aria-selected="false" tabindex="0" onclick="this.setAttribute('aria-selected','true')">Settings</div>
      <details id="acc"><summary>Details</summary><p>Hidden body</p></details>
      <div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = '<input id="s-in" placeholder="Shadow query"><button id="s-btn" type="button">Shadow Go</button><p id="s-out">idle</p>';
        root.getElementById('s-btn').addEventListener('click', () => {
          root.getElementById('s-out').textContent = 'done:' + root.getElementById('s-in').value;
        });
      </script>`)

    const read = await tools.run('page_read', {})
    const interactive = read.interactive as Array<{ selector: string; role?: string; text?: string; placeholder?: string }>
    expect(interactive.some((i) => i.role === 'tab' && i.text === 'Settings')).toBe(true)
    expect(interactive.some((i) => i.text === 'Details')).toBe(true)

    const shadowInput = interactive.find((i) => i.placeholder === 'Shadow query')
    const shadowBtn = interactive.find((i) => i.text === 'Shadow Go')
    expect(shadowInput?.selector).toContain('>>>')
    expect(shadowBtn?.selector).toContain('>>>')

    // Fill and click inside open Shadow DOM
    const fillRes = await tools.run('page_fill', { selector: shadowInput!.selector, text: 'hello' })
    expect(fillRes.ok).toBe(true)
    const clickRes = await tools.run('page_click', { selector: shadowBtn!.selector })
    expect(clickRes.ok).toBe(true)
    const textRes = await tools.run('page_text', { selector: '#host >>> #s-out' })
    expect(textRes.ok).toBe(true)
    expect(textRes.text).toBe('done:hello')

    // ARIA tab selection and <details> open verify via diffSnapshots
    const tabClick = await tools.run('page_click', { selector: '#aria-tab' })
    expect(tabClick.ok).toBe(true)
    expect(tabClick.changed).toBe(true)

    const summaryClick = await tools.run('page_click', { selector: '#acc > summary' })
    expect(summaryClick.ok).toBe(true)
    expect(summaryClick.changed).toBe(true)
  })

  it('verifies checkbox toggles and same-length text swaps in diffSnapshots', async () => {
    await open(`<!doctype html><title>toggles</title>
      <input id="chk" type="checkbox">
      <button id="swap" type="button" onclick="document.getElementById('lbl').textContent='BBB'">Swap</button>
      <span id="lbl">AAA</span>`)

    const chkClick = await tools.run('page_click', { selector: '#chk' })
    expect(chkClick.ok).toBe(true)
    expect(chkClick.changed).toBe(true)

    const swapClick = await tools.run('page_click', { selector: '#swap' })
    expect(swapClick.ok).toBe(true)
    expect(swapClick.changed).toBe(true)
  })

  it('fills React-style controlled inputs via native value setter and clears with clear: true', async () => {
    await open(`<!doctype html><title>controlled</title>
      <input id="ctrl" value="initial">
      <p id="seen"></p>
      <script>
        const el = document.getElementById('ctrl');
        let internal = 'initial';
        Object.defineProperty(el, 'value', {
          get() { return internal; },
          set(v) { /* ignore direct el.value = ... like React tracker */ },
          configurable: true,
        });
        el.addEventListener('input', (e) => {
          internal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(el);
          document.getElementById('seen').textContent = 'input:' + internal;
        });
      </script>`)

    const filled = await tools.run('page_fill', { selector: '#ctrl', text: 'ReactValue' })
    expect(filled.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('seen').textContent`)).toBe('input:ReactValue')

    const cleared = await tools.run('page_fill', { selector: '#ctrl', clear: true })
    expect(cleared.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('seen').textContent`)).toBe('input:')
  })

  it('runs page_text (full page), page_scroll, page_hover, page_press, page_wait, and page_eval on a real DOM', async () => {
    await open(`<!doctype html><title>primitives</title>
      <style>body { height: 2500px; }</style>
      <button id="hov" type="button" onmouseover="document.getElementById('hstate').textContent='hovered'">Hover me</button>
      <span id="hstate">cold</span>
      <input id="kinput" value="">
      <span id="klog"></span>
      <div id="delayed" style="display:none">Arrived!</div>
      <script>
        document.getElementById('kinput').addEventListener('keydown', (e) => {
          document.getElementById('klog').textContent = e.key + ':' + e.ctrlKey;
        });
        setTimeout(() => { document.getElementById('delayed').style.display = 'block'; }, 120);
      </script>`)

    const fullText = await tools.run('page_text', {})
    expect(fullText.ok).toBe(true)
    expect(String(fullText.text)).toContain('Hover me')

    const hovered = await tools.run('page_hover', { selector: '#hov' })
    expect(hovered.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('hstate').textContent`)).toBe('hovered')

    const pressed = await tools.run('page_press', { selector: '#kinput', key: 'Control+Enter' })
    expect(pressed.ok).toBe(true)
    expect(await cdp.evaluate<string>(`document.getElementById('klog').textContent`)).toBe('Enter:true')

    const scrolled = await tools.run('page_scroll', { direction: 'down', amount: 500 })
    expect(scrolled.ok).toBe(true)
    expect(Number(scrolled.scrollY)).toBeGreaterThanOrEqual(400)

    const waited = await tools.run('page_wait', { selector: '#delayed', state: 'visible', timeoutMs: 2000 })
    expect(waited.ok).toBe(true)
    expect(waited.matched).toBe(true)

    const evalRes = await tools.run('page_eval', { expression: '2 + 40' })
    expect(evalRes).toEqual({ ok: true, value: 42 })
  })
})
