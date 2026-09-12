import type { Box } from '../src/cdp/types.js'

// Minimal local shape of the `Doc` that Task 6 will later define for real.
// `score` only needs an array of lines carrying text, source and box, so
// this is deliberately narrow rather than importing something that does not
// exist yet. Task 6 widens the real `Doc` to carry this shape plus `url`,
// `ocrRegions` and `engine`; `test/score.test.ts` casts its fixture `doc`
// with `as never` so this local shape can stand in until then.
type ScoredLine = { text: string; source: 'dom' | 'ocr'; box: Box }
type Doc = { lines: ScoredLine[] }

export type Expected = { mustContain: string[]; mustNotContain: string[] }
export type Score = {
  recovered: number      // of mustContain, how many appeared
  total: number          // mustContain.length
  falsePositives: number // lines output that match no expected line
  leaks: number          // mustNotContain strings that appeared
  ms: number
  ocrRegions: number
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function score(doc: Doc, expected: Expected, ms: number): Score {
  const lines = doc.lines.map((line) => normalize(line.text))

  const mustContain = expected.mustContain.map(normalize)
  const mustNotContain = expected.mustNotContain.map(normalize)

  const recovered = mustContain.filter((wanted) =>
    lines.some((line) => line.includes(wanted)),
  ).length

  const leaks = mustNotContain.filter((trap) =>
    lines.some((line) => line.includes(trap)),
  ).length

  // A false positive is an output line that does not match anything the
  // page is actually expected to contain. A trap line that leaked still
  // counts here too (it is real output that is not a real, wanted line),
  // in addition to being tallied separately as a leak below.
  const falsePositives = lines.filter((line) =>
    !mustContain.some((wanted) => line.includes(wanted)),
  ).length

  // The minimal local `Doc` above has no region-grouping information (that
  // arrives with `cover()` in Task 10), so this counts OCR-sourced lines as
  // a stand-in for OCR'd regions. It is exact for the fixtures this task
  // ships (a plain article has none, so it is exactly 0) and will be
  // superseded once the real pipeline threads a true region count through.
  const ocrRegions = doc.lines.filter((line) => line.source === 'ocr').length

  return {
    recovered,
    total: mustContain.length,
    falsePositives,
    leaks,
    ms,
    ocrRegions,
  }
}
