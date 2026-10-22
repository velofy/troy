// Render: the fused document as markdown a person or an agent can read.
//
// The JSON form of a ReadDocument is the acting surface; markdown is the
// reading surface. Two rules shape it:
//
//   - Fragments that visually share a line are joined back into one line.
//     Extraction splits a paragraph at every link so each anchor keeps its
//     own selector, which is right for acting and wrong for reading, so
//     the renderer re-joins consecutive DOM blocks whose boxes overlap
//     vertically and renders links inline as [text](href).
//
//   - OCR text is fenced and labelled, never blended in silently. An agent
//     must be able to tell which words have a selector behind them and
//     which are pixels somebody's model read, because only one of the two
//     can be clicked.
//
// The footer reports what the read cost: how many regions went to OCR,
// which engine ran, how long the whole thing took. Silent OCR would hide
// both the money and the uncertainty.

/** @typedef {import('./types.js').ReadDocument} ReadDocument */
/** @typedef {import('./types.js').FusedBlock} FusedBlock */

/**
 * Do two blocks sit on the same visual line? Vertical overlap of the
 * boxes is the test: fragments of one paragraph overlap in y even when
 * the paragraph wraps, while successive paragraphs do not.
 *
 * @param {FusedBlock} a
 * @param {FusedBlock} b
 * @returns {boolean}
 */
function sameLine(a, b) {
  return Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y) > 0
}

/**
 * @param {FusedBlock} block
 * @returns {string} the block's text, as inline markdown
 */
function inlineText(block) {
  if (block.href && block.role === 'link') return `[${block.text}](${block.href})`
  return block.text
}

/**
 * @param {FusedBlock} block
 * @returns {boolean} can this block be merged into a running line group
 */
function joinable(block) {
  return block.source === 'dom' && !block.headingLevel
}

/**
 * @param {ReadDocument} doc
 * @returns {string}
 */
export function toMarkdown(doc) {
  /** @type {string[]} */
  const out = []
  if (doc.title) out.push(`# ${doc.title}`, '')

  /** @type {FusedBlock | null} */
  let previous = null
  /** @type {string[]} */
  let line = []
  const flushLine = () => {
    if (line.length) out.push(line.join(' '), '')
    line = []
  }

  for (const block of doc.blocks) {
    if (block.source === 'ocr') {
      flushLine()
      previous = null
      const label = block.untranscribed
        ? 'ocr region, untranscribed'
        : `ocr, from pixels at (${block.box.x}, ${block.box.y})`
      out.push('```', `[${label}]`, block.text, '```', '')
      continue
    }
    if (block.headingLevel) {
      flushLine()
      previous = null
      out.push(`${'#'.repeat(block.headingLevel)} ${block.text}`, '')
      continue
    }
    if (previous && joinable(previous) && joinable(block) && sameLine(previous, block)) {
      line.push(inlineText(block))
    } else {
      flushLine()
      line = [inlineText(block)]
    }
    previous = block
  }
  flushLine()

  const engine = doc.stats.ocrEngine
  out.push(
    `> read: ${doc.blocks.length} blocks, ${doc.stats.regionCount} region${doc.stats.regionCount === 1 ? '' : 's'} for ocr` +
      ` (engine: ${engine}), ${doc.stats.elapsedMs}ms${doc.stats.settled ? '' : ', page never settled'}`,
  )
  return out.join('\n')
}
