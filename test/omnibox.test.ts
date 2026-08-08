import { describe, it, expect } from 'vitest'
import { resolveOmnibox } from '../src/browser/omnibox.js'

describe('resolveOmnibox', () => {
  it('says nothing to do for empty input', () => {
    expect(resolveOmnibox('').kind).toBe('empty')
    expect(resolveOmnibox('   \t ').kind).toBe('empty')
  })

  it('navigates a bare hostname over https', () => {
    expect(resolveOmnibox('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(resolveOmnibox('news.ycombinator.com/item?id=1')).toEqual({
      kind: 'url',
      url: 'https://news.ycombinator.com/item?id=1',
    })
  })

  it('keeps an explicit http or https URL exactly as typed', () => {
    expect(resolveOmnibox('https://example.com/a?b=c#d')).toEqual({
      kind: 'url',
      url: 'https://example.com/a?b=c#d',
    })
    expect(resolveOmnibox('http://example.com')).toEqual({ kind: 'url', url: 'http://example.com' })
  })

  it('reads localhost and bare IPs as hosts over http, not as a scheme', () => {
    expect(resolveOmnibox('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(resolveOmnibox('localhost:3000/app?x=1')).toEqual({
      kind: 'url',
      url: 'http://localhost:3000/app?x=1',
    })
    expect(resolveOmnibox('127.0.0.1:8080')).toEqual({ kind: 'url', url: 'http://127.0.0.1:8080' })
  })

  it('searches anything that reads like a sentence', () => {
    const result = resolveOmnibox('how tall is everest')
    expect(result.kind).toBe('search')
    expect(result.url).toBe('https://duckduckgo.com/?q=how%20tall%20is%20everest')
  })

  it('searches a path rather than inventing a host from it', () => {
    expect(resolveOmnibox('/Users/anish/notes.html').kind).toBe('search')
    expect(resolveOmnibox('./relative.html').kind).toBe('search')
  })

  // The reason this module exists. Pasted into the bar of a logged-in tab,
  // javascript: runs in that origin, and the "//" form is the one that slips
  // past a naive "does it look like a URL" check.
  it('refuses javascript: in every disguise', () => {
    expect(resolveOmnibox('javascript:alert(1)').kind).toBe('refused')
    expect(resolveOmnibox('javascript://example.com/%0aalert(document.cookie)').kind).toBe('refused')
    expect(resolveOmnibox('JavaScript:alert(1)').kind).toBe('refused')
    expect(resolveOmnibox('  javascript:alert(1)  ').kind).toBe('refused')
  })

  it('refuses data:, blob: and the browser internal schemes', () => {
    expect(resolveOmnibox('data:text/html,<h1>hi</h1>').kind).toBe('refused')
    expect(resolveOmnibox('data://text/html,<h1>hi</h1>').kind).toBe('refused')
    expect(resolveOmnibox('blob:https://example.com/uuid').kind).toBe('refused')
    expect(resolveOmnibox('chrome://settings').kind).toBe('refused')
    expect(resolveOmnibox('devtools://devtools/bundled/inspector.html').kind).toBe('refused')
    expect(resolveOmnibox('filesystem:https://example.com/temporary/x').kind).toBe('refused')
  })

  it('gives a reason with every refusal, so the chrome can say why', () => {
    const result = resolveOmnibox('javascript:alert(1)')
    expect(result.reason).toMatch(/script/i)
  })

  it('allows about:blank and refuses the other about: pages', () => {
    expect(resolveOmnibox('about:blank')).toEqual({ kind: 'url', url: 'about:blank' })
    expect(resolveOmnibox('about:config').kind).toBe('refused')
  })

  it('allows file: URLs', () => {
    expect(resolveOmnibox('file:///tmp/page.html')).toEqual({
      kind: 'url',
      url: 'file:///tmp/page.html',
    })
  })

  it('hands another application its own scheme instead of loading it', () => {
    expect(resolveOmnibox('mailto:anishfyi@gmail.com')).toEqual({
      kind: 'external',
      url: 'mailto:anishfyi@gmail.com',
    })
    expect(resolveOmnibox('ssh://build-box')).toEqual({ kind: 'external', url: 'ssh://build-box' })
  })
})
