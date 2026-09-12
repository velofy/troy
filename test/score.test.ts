import { describe, it, expect } from 'vitest'
import { score } from './score.js'

const doc = { lines: [
  { text: 'Real heading', source: 'dom', box: { x:0,y:0,w:10,h:10 } },
  { text: 'Invented line', source: 'ocr', box: { x:0,y:20,w:10,h:10 } },
] } as never

describe('score', () => {
  it('counts recovered, false positives and leaks', () => {
    const s = score(doc, { mustContain: ['Real heading', 'Missing line'], mustNotContain: ['Invented line'] }, 100)
    expect(s.recovered).toBe(1)
    expect(s.total).toBe(2)
    expect(s.leaks).toBe(1)
    expect(s.falsePositives).toBe(1)
  })
})
