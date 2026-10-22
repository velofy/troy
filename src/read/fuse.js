// Fuse: one document out of two kinds of evidence.
//
// DOM blocks and OCR lines arrive as flat lists in extraction order and
// crop order respectively, neither of which is the order a person reads
// the page in. Fusing does three things:
//
//   1. drops every block whose visibility verdict failed, which is where
//      hidden-text poisoning actually dies (extract records it; fuse
//      refuses to publish it);
//   2. groups the survivors into columns by horizontal overlap, because a
//      two-column page read strictly top-to-bottom interleaves unrelated
//      sentences, and column-then-row is what reading order means on the
//      web;
//   3. orders each column top-to-bottom (ties broken left-to-right), then
//      emits the columns left-to-right.
//
// Column membership is transitive: if A overlaps B and B overlaps C, all
// three share a column even when A and C never touch. On a page with a
// full-width header this collapses everything into one column and the
// ordering degrades to plain top-to-bottom, which is exactly the right
// degradation: when the geometry does not show columns, do not invent them.
//
// Every fused block keeps its box and its source. A DOM block keeps its
// selector so an agent can act on what it just read; an OCR block has no
// selector, because there is no element behind it, and pretending
// otherwise would hand the action layer a lie.

/** @typedef {import('./types.js').DomBlock} DomBlock */
/** @typedef {import('./types.js').FusedBlock} FusedBlock */

/**
 * @param {{ box: import('./types.js').Box }} a
 * @param {{ box: import('./types.js').Box }} b
 * @returns {boolean} do the horizontal extents overlap at all
 */
function xOverlap(a, b) {
  return Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x) > 0
}

/**
 * Group blocks into columns by transitive x-overlap. Plain union-find over
 * a sorted list: after sorting by x, a block can only join a column whose
 * running x-extent reaches it, so one left-to-right sweep finds the
 * partition without comparing every pair.
 *
 * @template {{ box: import('./types.js').Box }} T
 * @param {T[]} items
 * @returns {T[][]} columns, ordered left-to-right
 */
export function columnsOf(items) {
  const sorted = [...items].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)
  /** @type {{ minX: number, maxX: number, items: T[] }[]} */
  const columns = []
  for (const item of sorted) {
    const right = item.box.x + item.box.w
    const hit = columns.find((c) => Math.min(c.maxX, right) - Math.max(c.minX, item.box.x) > 0)
    if (hit) {
      hit.items.push(item)
      hit.minX = Math.min(hit.minX, item.box.x)
      hit.maxX = Math.max(hit.maxX, right)
    } else {
      columns.push({ minX: item.box.x, maxX: right, items: [item] })
    }
  }
  return columns.map((c) => c.items)
}

/**
 * @param {DomBlock[]} domBlocks everything extract produced, verdicts included
 * @param {FusedBlock[]} ocrBlocks already in viewport coordinates
 * @returns {FusedBlock[]} the document, in reading order
 */
export function fuse(domBlocks, ocrBlocks) {
  /** @type {FusedBlock[]} */
  const kept = []
  for (const block of domBlocks) {
    if (!block.visible) continue
    const text = block.text.trim()
    if (!text) continue
    kept.push({
      text,
      box: block.box,
      source: 'dom',
      selector: block.selector,
      role: block.role,
      href: block.href,
      headingLevel: block.headingLevel,
    })
  }
  for (const block of ocrBlocks) {
    if (block.text.trim()) kept.push(block)
  }

  /** @type {FusedBlock[]} */
  const ordered = []
  for (const column of columnsOf(kept)) {
    column.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
    ordered.push(...column)
  }
  return ordered
}
