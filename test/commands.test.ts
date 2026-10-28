import { describe, expect, it } from 'vitest'
import { createCommandRegistry } from '../src/browser/commands.js'
import { buildPaletteResults, matchScore } from '../src/browser/palette.js'
import { resolveOmnibox } from '../src/browser/omnibox.js'

describe('command registry', () => {
  it('keeps handlers in main-shaped registry and lists serializable metadata', async () => {
    const calls: string[] = []
    const registry = createCommandRegistry([
      {
        id: 'tab.new',
        title: 'New tab',
        category: 'Tabs',
        keywords: ['open'],
        shortcut: 'Cmd T',
        run: () => calls.push('new'),
      },
      {
        id: 'tab.close',
        title: 'Close tab',
        category: 'Tabs',
        enabled: (context) => context.canClose,
        run: () => calls.push('close'),
      },
    ])

    expect(registry.list({ canClose: false })).toEqual([
      {
        id: 'tab.new',
        title: 'New tab',
        category: 'Tabs',
        keywords: ['open'],
        shortcut: 'Cmd T',
        enabled: true,
      },
      {
        id: 'tab.close',
        title: 'Close tab',
        category: 'Tabs',
        keywords: [],
        shortcut: '',
        enabled: false,
      },
    ])

    await registry.execute('tab.new', { canClose: false })
    expect(calls).toEqual(['new'])
    expect(await registry.execute('tab.close', { canClose: false })).toEqual({
      error: 'command tab.close is unavailable right now',
    })
  })

  it('rejects duplicate IDs instead of making execution order ambiguous', () => {
    expect(() =>
      createCommandRegistry([
        { id: 'same', title: 'One', category: 'Test', run: () => {} },
        { id: 'same', title: 'Two', category: 'Test', run: () => {} },
      ]),
    ).toThrow(/duplicate/i)
  })
})

describe('palette ranking', () => {
  const commands = [
    {
      id: 'tab.new',
      title: 'New tab',
      category: 'Tabs',
      keywords: ['open create'],
      shortcut: 'Cmd T',
      enabled: true,
    },
    {
      id: 'nav.back',
      title: 'Go back',
      category: 'Navigation',
      keywords: [],
      shortcut: '',
      enabled: false,
    },
  ]

  it('scores exact, prefixes, substrings and subsequences in that order', () => {
    expect(matchScore('new tab', 'new tab')).toBeGreaterThan(matchScore('new', 'new tab'))
    expect(matchScore('tab', 'new tab')).toBeGreaterThan(matchScore('ntb', 'new tab'))
    expect(matchScore('missing', 'new tab')).toBe(-1)
  })

  it('prefers an open tab and removes duplicate bookmark/history URLs', () => {
    const results = buildPaletteResults({
      query: 'example',
      commands,
      tabs: [{ id: 7, title: 'Example', url: 'https://example.com/', active: true }],
      bookmarks: [{ title: 'Example bookmark', url: 'https://example.com/' }],
      history: [{ title: 'Example history', url: 'https://example.com/', visitedAt: '' }],
      resolve: resolveOmnibox,
    })
    expect(results.filter((result) => result.kind === 'tab')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'bookmark')).toHaveLength(0)
    expect(results.filter((result) => result.kind === 'history')).toHaveLength(0)
    expect(results[0]?.kind).toBe('tab')
  })

  it('omits disabled commands and history when the caller supplies none', () => {
    const results = buildPaletteResults({
      query: 'back',
      commands,
      tabs: [],
      bookmarks: [],
      history: [],
      resolve: resolveOmnibox,
    })
    expect(results.some((result) => result.payload.commandId === 'nav.back')).toBe(false)
  })

  it('always offers a safe omnibox navigation result for non-empty input', () => {
    const results = buildPaletteResults({
      query: 'how tall is everest',
      commands,
      tabs: [],
      bookmarks: [],
      history: [],
      resolve: resolveOmnibox,
    })
    const navigation = results.find((result) => result.kind === 'navigation')
    expect(navigation?.title).toMatch(/search/i)
    expect(navigation?.payload.input).toBe('how tall is everest')
  })
})
