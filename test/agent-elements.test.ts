import { describe, expect, it } from 'vitest'
import { ElementRegistry } from '../src/agent/elements.js'

describe('opaque element capabilities', () => {
  it('replaces selectors with refs and keeps selectors private', () => {
    const registry = new ElementRegistry()
    const publicItems = registry.register(
      [{ selector: '#buy', tag: 'button', text: 'More details' }],
      { tabId: 4, url: 'https://example.com/', epoch: 2 },
    )
    expect(publicItems).toEqual([{ ref: 'e1', tag: 'button', text: 'More details' }])
    expect(JSON.stringify(publicItems)).not.toContain('#buy')

    expect(registry.resolve('e1', { tabId: 4, url: 'https://example.com/', epoch: 2 })).toEqual({
      selector: '#buy',
      item: { ref: 'e1', tag: 'button', text: 'More details' },
    })
  })

  it('rejects forged, stale, cross-tab and cross-navigation refs', () => {
    const registry = new ElementRegistry()
    registry.register([{ selector: '#x', tag: 'button' }], { tabId: 1, url: 'https://a.example/', epoch: 0 })

    expect(registry.resolve('selector:#x', { tabId: 1, url: 'https://a.example/', epoch: 0 })).toHaveProperty('error')
    expect(registry.resolve('e1', { tabId: 2, url: 'https://a.example/', epoch: 0 })).toHaveProperty('error')
    expect(registry.resolve('e1', { tabId: 1, url: 'https://a.example/next', epoch: 1 })).toHaveProperty('error')
  })

  it('invalidates every prior ref after a mutation', () => {
    const registry = new ElementRegistry()
    registry.register([{ selector: '#x', tag: 'button' }], { tabId: 1, url: 'https://a.example/', epoch: 0 })
    registry.invalidate()
    expect(registry.resolve('e1', { tabId: 1, url: 'https://a.example/', epoch: 0 })).toHaveProperty('error')
  })
})
